/**
 * LLM Wiki 关系维护真库钉（Story 2.6 / FR-17）。
 *
 * 覆盖：parseRelationOutput（snake_case 原样 schema）、selectRelatedTargets（同 kind 优先是
 * 排序权重、跨层/未知 target/上限 5 都拒绝、EVIDENCE 一律拒绝）、recallNeighbors（真 KNN，
 * 排除自身、向量缺失/维度不符返回空）、applyRelations（写边 + 两路审计）、createRelationRunner
 * 的三条降级路径（embedding 禁用 / 节点无向量 / LLM 失败 —— 都不得影响记忆本身）。
 *
 * 播种用 upsertMemory + memoryNodeId（节点 id 是指纹 uuid5，不是文本本身）。
 * 开库次数：本文件 1 次——LadybugDB 每进程约 15 个库封顶。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureEdgeTables } from '../src/db/edges'
import { memoryNodeId } from '../src/db/id'
import { upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import {
  RELATION_RECALL_TOP_K,
  RELATED_MAX_EDGES,
  SKIP_RELATED_LLM_REASON,
  applyRelations,
  createRelationRunner,
  parseRelationOutput,
  recallNeighbors,
  selectRelatedTargets,
  type RecallNeighbor,
  type RelationLlmPort,
  type RelationProposal,
} from '../src/wiki/relations'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'
const E1 = [1, 0, 0, 0, 0, 0, 0, 0]
const LAYER = 'L1'

/** 播种文本 ⇒ 节点 id（upsertMemory 内部就是 memoryNodeId(LAYER, text)）。 */
const nid = (key: string): string => memoryNodeId(LAYER, key)

function vectorWithCosine(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0, 0, 0, 0, 0]
}

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

let store: MemoryDatabase

async function seed(
  key: string,
  args: { embedding?: readonly number[] | null; kind?: string; layer?: string },
): Promise<string> {
  await upsertMemory(store.connection, {
    layer: args.layer ?? LAYER,
    text: key,
    embedding: args.embedding === undefined ? null : args.embedding,
    embeddingModelId: args.embedding ? 'test-embed' : null,
    kind: args.kind ?? '',
    priority: 0,
    validAt: T0,
    recordedAt: T0,
    sourceRefs: [],
    actor: 'system',
  })
  return memoryNodeId(args.layer ?? LAYER, key)
}

async function auditRows(action: string): Promise<Array<{ reason: string; outcome: string }>> {
  const rows = await queryAll(
    store.connection,
    "MATCH (g:generation_log {action: '" + action + "'}) RETURN g.reason AS reason, g.outcome AS outcome",
  )
  return rows.map((row) => ({ reason: String(row.reason ?? ''), outcome: String(row.outcome ?? '') }))
}

async function relatedEdges(): Promise<Array<{ from: string; to: string; reason: string }>> {
  const rows = await queryAll(
    store.connection,
    'MATCH (a:memory)-[r:RELATED]->(b:memory) RETURN a.id AS from_id, b.id AS to_id, r.reason AS reason',
  )
  return rows.map((row) => ({ from: String(row.from_id), to: String(row.to_id), reason: String(row.reason ?? '') }))
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-rel-')),
    dim: DIM,
    modelId: 'test-embed',
  })
  await ensureEdgeTables(store.connection)
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('parseRelationOutput（schema 原样 snake_case）', () => {
  it('合法数组 ⇒ 转 camelCase；非法元素被丢弃；非数组 ⇒ null', () => {
    const parsed = parseRelationOutput(JSON.stringify([
      { target_id: 'a', edge_type: 'RELATED', reason: 'r' },
      { target_id: 'b', edge_type: 'EVIDENCE' },
      { target_id: '', edge_type: 'RELATED' },
      { target_id: 'c', edge_type: 'WRONG' },
    ]))
    expect(parsed).toEqual([
      { targetId: 'a', edgeType: 'RELATED', reason: 'r' },
      { targetId: 'b', edgeType: 'EVIDENCE', reason: null },
    ])
    expect(parseRelationOutput('not json')).toBeNull()
    expect(parseRelationOutput('{"a":1}')).toBeNull()
  })
})

describe('selectRelatedTargets（应用层校验）', () => {
  const candidate = { id: 'cand', layer: 'L1', kind: 'work_fact' }
  const neighbors: RecallNeighbor[] = [
    { id: 'n-same-kind-far', layer: 'L1', kind: 'work_fact', distance: 0.05 },
    { id: 'n-other-kind-near', layer: 'L1', kind: 'persona', distance: 0.01 },
    { id: 'n-cross-layer', layer: 'L2', kind: 'work_fact', distance: 0.02 },
  ]

  it('同 kind 优先是排序权重：同 kind 更远的排在异 kind 更近的前面，但都保留', () => {
    const proposals: RelationProposal[] = [
      { targetId: 'n-other-kind-near', edgeType: 'RELATED', reason: null },
      { targetId: 'n-same-kind-far', edgeType: 'RELATED', reason: 'x' },
    ]
    const selection = selectRelatedTargets(candidate, proposals, neighbors)
    expect(selection.accepted).toEqual([
      { fromId: 'cand', toId: 'n-same-kind-far', reason: 'x' },
      { fromId: 'cand', toId: 'n-other-kind-near', reason: null },
    ])
  })

  it('跨层 / 未知 target / 自身 ⇒ rejectedOther；EVIDENCE ⇒ rejectedEvidence', () => {
    const proposals: RelationProposal[] = [
      { targetId: 'n-cross-layer', edgeType: 'RELATED', reason: null },
      { targetId: 'not-in-neighbors', edgeType: 'RELATED', reason: null },
      { targetId: 'cand', edgeType: 'RELATED', reason: null },
      { targetId: 'n-same-kind-far', edgeType: 'EVIDENCE', reason: null },
    ]
    const selection = selectRelatedTargets(candidate, proposals, neighbors)
    expect(selection.accepted).toEqual([])
    expect(selection.rejectedOther).toEqual(['n-cross-layer', 'not-in-neighbors', 'cand'])
    expect(selection.rejectedEvidence).toEqual(['n-same-kind-far'])
  })

  it('上限 5 条：多出的候选进 rejectedOther', () => {
    const many: RecallNeighbor[] = []
    for (let i = 0; i < 8; i += 1) {
      many.push({ id: 'm' + String(i), layer: 'L1', kind: 'work_fact', distance: 0.01 * (i + 1) })
    }
    const proposals: RelationProposal[] = many.map((n) => ({ targetId: n.id, edgeType: 'RELATED' as const, reason: null }))
    const selection = selectRelatedTargets(candidate, proposals, many)
    expect(selection.accepted.length).toBe(RELATED_MAX_EDGES)
    expect(selection.accepted.map((edge) => edge.toId)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(selection.rejectedOther).toEqual(['m5', 'm6', 'm7'])
  })
})

describe('recallNeighbors（真 KNN）', () => {
  it('按 cosine 距离召回、排除自身、k 生效；无向量/维度不符 ⇒ 空数组', async () => {
    // 三个候选：与 e1 的 cosine 分别为 0.99 / 0.90 / 0.10。
    await seed('k-near', { embedding: vectorWithCosine(0.99), kind: 'work_fact' })
    await seed('k-mid', { embedding: vectorWithCosine(0.9), kind: 'work_fact' })
    await seed('k-far', { embedding: vectorWithCosine(0.1), kind: 'persona' })
    await seed('k-novector', { embedding: null })
    const selfId = await seed('k-self', { embedding: E1, kind: 'work_fact' })

    const neighbors = await recallNeighbors(store.connection, {
      embedding: E1,
      k: RELATION_RECALL_TOP_K,
      excludeId: selfId,
      now: NOW,
    })
    const ids = neighbors.map((n) => n.id)
    expect(ids).not.toContain(selfId)
    expect(ids).not.toContain(nid('k-novector'))
    expect(ids.slice(0, 3)).toEqual([nid('k-near'), nid('k-mid'), nid('k-far')])
    expect(neighbors[0]?.distance).toBeCloseTo(0.01, 3)
    expect(neighbors[0]?.kind).toBe('work_fact')

    const limited = await recallNeighbors(store.connection, { embedding: E1, k: 1, now: NOW })
    expect(limited.length).toBe(1)

    expect(await recallNeighbors(store.connection, { embedding: [], k: 8, now: NOW })).toEqual([])
    expect(await recallNeighbors(store.connection, { embedding: [1, 0, 0], k: 8, now: NOW })).toEqual([])
  })
})

describe('applyRelations（写边 + 记账）', () => {
  it('同层 RELATED 写边并记 write_related；LLM 提议的 EVIDENCE 只记 reject_evidence', async () => {
    const candId = await seed('a-cand', { embedding: E1, kind: 'work_fact' })
    const targetId = await seed('a-target', { embedding: vectorWithCosine(0.95), kind: 'work_fact' })
    const neighbors: RecallNeighbor[] = [
      { id: targetId, layer: 'L1', kind: 'work_fact', distance: 0.05 },
      { id: 'a-layer2', layer: 'L2', kind: 'work_fact', distance: 0.06 },
    ]
    const proposals: RelationProposal[] = [
      { targetId, edgeType: 'RELATED', reason: '同主题' },
      { targetId: 'a-layer2', edgeType: 'EVIDENCE', reason: '编造的证据' },
    ]
    const result = await applyRelations(store.connection, {
      candidate: { id: candId, layer: 'L1', kind: 'work_fact' },
      proposals,
      neighbors,
      now: NOW,
    })
    expect(result.written).toBe(1)
    expect(result.rejectedEvidence).toBe(1)
    expect(await relatedEdges()).toContainEqual({ from: candId, to: targetId, reason: '同主题' })
    const rejected = await auditRows('reject_evidence')
    expect(rejected.length).toBe(1)
    expect(rejected[0]?.reason).toContain('target=a-layer2')
    const written = await auditRows('write_related')
    expect(written.length).toBe(1)
    expect(written[0]?.reason).toBe('edges=1')
  })
})

describe('createRelationRunner（生产降级路径）', () => {
  function scripted(body: string | Error): { llm: RelationLlmPort; calls: () => number } {
    const state = { calls: 0 }
    const llm: RelationLlmPort = {
      stream() {
        state.calls += 1
        if (body instanceof Error) throw body
        return (async function* generate() {
          yield delta(body)
          yield finish({ kind: 'stop' })
        })()
      },
    }
    return { llm, calls: () => state.calls }
  }

  it('embedding 禁用 ⇒ 一条 skip_related 审计，不调 LLM', async () => {
    const okLlm = scripted('[]')
    const runner = createRelationRunner({
      connection: () => store.connection,
      llm: okLlm.llm,
      embeddingEnabled: false,
    })
    await runner({
      itemId: 'item-disabled',
      route: { provider: 'p', model: 'm' },
      entries: [{ id: nid('a-cand'), layer: 'L1', kind: 'work_fact', text: 'x', embedding: E1 }],
      now: NOW,
      signal: AbortSignal.timeout(5_000),
    })
    const skips = await auditRows('skip_related')
    expect(skips.length).toBe(1)
    expect(skips[0]?.reason).toBe('embedding-disabled')
    expect(okLlm.calls()).toBe(0)
  })

  it('节点无向量 ⇒ 记节点级 skip 并继续；LLM 失败 ⇒ skip 审计后中止本轮', async () => {
    const failing = scripted(new Error('model exploded'))
    const runner = createRelationRunner({
      connection: () => store.connection,
      llm: failing.llm,
      embeddingEnabled: true,
      logger: { warn: () => {} },
    })
    await runner({
      itemId: 'item-mixed',
      route: { provider: 'p', model: 'm' },
      entries: [
        { id: nid('k-novector'), layer: 'L1', kind: 'work_fact', text: 'x', embedding: null },
        { id: nid('k-near'), layer: 'L1', kind: 'work_fact', text: 'y', embedding: E1 },
      ],
      now: NOW,
      signal: AbortSignal.timeout(5_000),
    })
    const skips = await auditRows('skip_related')
    // 上一用例 1 条 embedding-disabled + 本用例 2 条（节点级 + LLM 失败）
    expect(skips.length).toBe(3)
    expect(skips[1]?.reason).toContain('node=' + nid('k-novector'))
    expect(skips[2]?.reason).toContain(SKIP_RELATED_LLM_REASON)
  })
})

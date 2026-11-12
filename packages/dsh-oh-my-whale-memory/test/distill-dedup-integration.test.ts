/**
 * 精炼处理器 × 写入去重集成（Story 2.4）。
 *
 * 处理器把 L1 写路径从 writeMemoryVersion 换成 writeDeduplicatedMemory——本文件验证
 * 两条语义去重路径在**真实精炼链路**（真库 dim=4 + 脚本化 llm + 假 embeddings）上成立：
 *   ① 两条向量 cosine ≈ 0.99 的事实合并成 1 个节点 + merge_semantic 审计；
 *   ② 预置同源（source_refs=[item.id]）、cosine ≈ 0.93 的既有节点 → 版本链：新节点带 parent_id、
 *      旧节点置 invalid_at + invalidate_version 审计；
 *   ③ embedding 失败 → 无向量、整段不走 ANN，节点照常写入（N4）；
 *   ④ **U4 粗筛上界回归钉**：cosine ≈ 0.92（distance ≈ 0.08）的亲缘候选确实被 ANN 取回并走进
 *      [0.90,0.97) 版本链分支——把粗筛退回 distance<=0.03 本用例即变红。
 *
 * 独立文件的理由：test/distill-processor.test.ts 已贴 LadybugDB 每进程 ~15 实例硬顶。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { memoryNodeId } from '../src/db/id'
import { queryAll, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { createInboxProcessor, type InboxProcessorDeps } from '../src/distill/processor'
import type { LlmPort } from '../src/distill/llm-refine'
import type { EmbedClient } from '../src/embedding/client'
import { claimNextInboxItem, enqueueInboxItem, type InboxItem } from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'test-embed-model'
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }
const LAYER = 'L1'
const E1 = [1, 0, 0, 0]

/** 与 E1 的 cosine 恰为 c 的 4 维向量。 */
function vectorWithCosine(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0]
}

let store: MemoryDatabase
let seq = 0

beforeEach(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-dedup-int-')),
    dim: DIM,
    modelId: MODEL_ID,
  })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const textDelta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finishChunk = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk
const okOutput = (facts: readonly unknown[]): readonly StreamChunk[] => [
  textDelta(JSON.stringify({ facts })),
  finishChunk({ kind: 'stop' }),
]

function scriptedLlm(script: readonly StreamChunk[]): LlmPort {
  return {
    stream() {
      return (async function* generate() {
        for (const chunk of script) yield chunk
      })()
    },
  }
}

/** 按批内下标给向量（index 缺省回退最后一个）。 */
function vectorScript(vectors: readonly (readonly number[])[]): EmbedClient {
  return {
    embed: async (_model, input) => ({
      ok: true,
      vectors: input.map((_text, index) => vectors[index] ?? vectors[vectors.length - 1]!),
    }),
  }
}

function makeProcessor(llm: LlmPort, overrides: Partial<InboxProcessorDeps> = {}) {
  return createInboxProcessor({
    connection: () => store.connection,
    llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    ...overrides,
  })
}

async function claimFixture(tag: string, payload: string): Promise<InboxItem> {
  const id = 'dd-' + tag + '-' + process.pid + '-' + seq++
  await enqueueInboxItem(store.connection, { id, payload, kind: 'work_fact', sessionId: 'sess-1', now: NOW })
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

interface NodeRow {
  id: string
  text: string
  refs: string[]
  invalidAt: string | null
  parentId: string | null
  embeddingNull: boolean
}

async function allNodes(): Promise<NodeRow[]> {
  const rows = await queryAll(
    store.connection,
    'MATCH (m:memory) RETURN m.id AS id, m.text AS text, m.source_refs AS refs,' +
      ' m.invalid_at AS invalid_at, m.parent_id AS parent_id, m.embedding AS embedding',
  )
  return rows.map((row) => ({
    id: String(row.id),
    text: String(row.text ?? ''),
    refs: Array.isArray(row.refs) ? row.refs.map(String) : [],
    invalidAt: row.invalid_at === null || row.invalid_at === undefined ? null : String(row.invalid_at),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    embeddingNull: row.embedding === null || row.embedding === undefined,
  }))
}

async function audits(action: string): Promise<Array<{ outcome: string; reason: string }>> {
  const rows = await queryAll(
    store.connection,
    `MATCH (g:generation_log) WHERE g.action = '${action}' RETURN g.outcome AS outcome, g.reason AS reason`,
  )
  return rows.map((row) => ({ outcome: String(row.outcome ?? ''), reason: String(row.reason ?? '') }))
}

describe('精炼处理器 × 写入去重（Story 2.4）', () => {
  it('① 两条 cosine ≈ 0.99 的事实合并为一个节点 + merge_semantic 审计', async () => {
    const item = await claimFixture('merge', '用户: 甲和乙说的是一件事')
    const llm = scriptedLlm(okOutput([
      { text: '事实甲', kind: 'work_fact', priority: 1 },
      { text: '事实乙', kind: 'work_fact', priority: 1 },
    ]))
    const processor = makeProcessor(llm, {
      embedding: vectorScript([E1, vectorWithCosine(0.99)]),
      embeddingModel: 'test-model',
      embeddingModelId: MODEL_ID,
    })
    const result = await processor(item)
    expect(result).toEqual({ completed: true, kinds: ['work_fact', 'work_fact'] })

    const nodes = await allNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.text).toBe('事实甲')
    expect(nodes[0]!.refs).toContain(item.id)
    const merged = await audits('merge_semantic')
    expect(merged).toHaveLength(1)
    expect(merged[0]!.outcome).toBe('success')
    expect(merged[0]!.reason).toContain('similarity=')
  })

  it('② 同源既有节点 cosine ≈ 0.93 → 版本作废：新节点带 parent_id、旧节点 invalid_at', async () => {
    const item = await claimFixture('version', '用户: 口径改了')
    const oldId = memoryNodeId(LAYER, '旧版本')
    await upsertMemory(store.connection, {
      layer: LAYER,
      text: '旧版本',
      embedding: vectorWithCosine(0.93),
      embeddingModelId: MODEL_ID,
      sourceRefs: [item.id],
      validAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
    })
    const processor = makeProcessor(scriptedLlm(okOutput([
      { text: '新版本', kind: 'work_fact', priority: 2 },
    ])), {
      embedding: vectorScript([E1]),
      embeddingModel: 'test-model',
      embeddingModelId: MODEL_ID,
    })
    await processor(item)

    const nodes = await allNodes()
    expect(nodes).toHaveLength(2)
    const fresh = nodes.find((node) => node.text === '新版本')!
    expect(fresh.parentId).toBe(oldId)
    expect(fresh.invalidAt).toBeNull()
    const old = nodes.find((node) => node.id === oldId)!
    expect(old.invalidAt).toBe(NOW.toISOString())
    const invalidations = await audits('invalidate_version')
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]!.outcome).toBe('success')
  })

  it('③ embedding 失败：L1 照常写入、无向量、不走 ANN、不产生语义审计', async () => {
    const item = await claimFixture('novec', '用户: 无向量也要落库')
    await upsertMemory(store.connection, {
      layer: LAYER,
      text: '已有向量节点',
      embedding: E1,
      embeddingModelId: MODEL_ID,
      sourceRefs: ['other'],
    })
    const processor = makeProcessor(scriptedLlm(okOutput([
      { text: '无向量事实', kind: 'work_fact', priority: 1 },
    ])), {
      embedding: { embed: async () => ({ ok: false, reason: 'http-500', message: 'stub failure' }) },
      embeddingModel: 'test-model',
      embeddingModelId: MODEL_ID,
    })
    await processor(item)

    const nodes = await allNodes()
    expect(nodes).toHaveLength(2)
    const written = nodes.find((node) => node.text === '无向量事实')!
    expect(written.embeddingNull).toBe(true)
    expect(await audits('merge_semantic')).toHaveLength(0)
    expect(await audits('invalidate_version')).toHaveLength(0)
  })

  it('④ U4 钉住：cosine ≈ 0.92（distance ≈ 0.08）的同源候选被 ANN 取回并走版本链', async () => {
    const item = await claimFixture('pin', '用户: 细节微调')
    const oldId = memoryNodeId(LAYER, '亲缘旧版本')
    await upsertMemory(store.connection, {
      layer: LAYER,
      text: '亲缘旧版本',
      embedding: vectorWithCosine(0.92),
      embeddingModelId: MODEL_ID,
      sourceRefs: [item.id],
      validAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
    })
    const processor = makeProcessor(scriptedLlm(okOutput([
      { text: '亲缘新表述', kind: 'work_fact', priority: 1 },
    ])), {
      embedding: vectorScript([E1]),
      embeddingModel: 'test-model',
      embeddingModelId: MODEL_ID,
    })
    await processor(item)

    const nodes = await allNodes()
    expect(nodes).toHaveLength(2)
    const fresh = nodes.find((node) => node.text === '亲缘新表述')!
    expect(fresh.parentId).toBe(oldId)
    expect(await audits('invalidate_version')).toHaveLength(1)
  })
})

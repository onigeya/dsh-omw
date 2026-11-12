/**
 * 精炼同事务建 EVIDENCE 边的集成钉（Story 2.6 / AC2、I-O 矩阵第 21 行、裁决 U4）。
 *
 * 两件事只有在这一层才看得见：
 * 1. 写 L1 与建 `l0_raw→memory` EVIDENCE 边**在同一个事务里**——事务中途失败（这里用
 *    writeEvidenceEdges 抛错注入）必须让 L1 节点、边、条目标 done **一起回滚**；
 * 2. LLM 提议的 EVIDENCE 一律**拒绝建边**并记 `reject_evidence` 审计（唯一写者是精炼结构）。
 *
 * 真库 dim=4 + 脚本化 llm 端口；开库 1 次（LadybugDB 每进程约 15 库封顶）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { checkReachableToL0 } from '../src/db/eii'
import { ensureEdgeTables } from '../src/db/edges'
import { memoryNodeId } from '../src/db/id'
import { upsertMemory } from '../src/db/memory'
import { claimNextInboxItem, enqueueInboxItem, reclaimProcessingInboxItems, type InboxItem } from '../src/inbox/queue'
import { createInboxProcessor } from '../src/distill/processor'
import { MEMORY_REMEMBER_LAYER } from '../src/tools/memory-remember'
import { createRelationRunner, type RecallNeighbor } from '../src/wiki/relations'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }
const E1 = [1, 0, 0, 0]

/** 注入点：控制 writeEvidenceEdges 是否抛错（模拟「边写入前崩溃」）。 */
const edgeState = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throw' }))
vi.mock('../src/db/edges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/edges')>()
  return {
    ...actual,
    writeEvidenceEdges: async (connection: never, edges: never) => {
      if (edgeState.mode === 'throw') throw new Error('crash-before-edge-write')
      return actual.writeEvidenceEdges(connection, edges)
    },
  }
})

let store: MemoryDatabase
let seq = 0

beforeEach(async () => {
  edgeState.mode = 'real'
  const dir = await makeTempDir('omw-dedge-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed' })
  await ensureEdgeTables(store.connection)
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

function scriptedLlm(text: string): { stream(options: unknown): AsyncIterable<StreamChunk> } {
  return {
    stream() {
      return (async function* generate() {
        yield delta(text)
        yield finish({ kind: 'stop' })
      })()
    },
  }
}

/** 造一条 INBOX 条目 + 同名 l0_raw 行（2.3 P1 起两者同 id）。 */
async function claimWithL0(tag: string): Promise<InboxItem> {
  const id = 'dedge-' + tag + '-' + process.pid + '-' + String(seq++)
  await enqueueInboxItem(store.connection, { id, payload: '用户: 原文', kind: 'work_fact', sessionId: 's', now: NOW })
  await store.connection.query(
    "CREATE (l:l0_raw {id: '" + id + "', raw_text: '用户: 原文', recorded_at: '" + NOW.toISOString() + "', actor: 'system'})",
  )
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

async function evidenceEdges(): Promise<Array<{ from: string; to: string; reason: string }>> {
  const rows = await queryAll(
    store.connection,
    'MATCH (a:l0_raw)-[e:EVIDENCE]->(b:memory) RETURN a.id AS from_id, b.id AS to_id, e.reason AS reason',
  )
  return rows.map((row) => ({ from: String(row.from_id), to: String(row.to_id), reason: String(row.reason ?? '') }))
}

async function audits(action: string): Promise<Array<{ reason: string; outcome: string }>> {
  const rows = await queryAll(
    store.connection,
    "MATCH (g:generation_log) WHERE g.action = '" + action + "' RETURN g.reason AS reason, g.outcome AS outcome",
  )
  return rows.map((row) => ({ reason: String(row.reason ?? ''), outcome: String(row.outcome ?? '') }))
}

async function inboxStatus(id: string): Promise<string | null> {
  const rows = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' RETURN q.status AS status")
  return rows[0] === undefined ? null : String(rows[0].status)
}

function makeProcessor(llm: unknown) {
  return createInboxProcessor({
    connection: () => store.connection,
    llm: llm as never,
    resolveRoute: () => ROUTE,
    now: () => NOW,
  })
}

const factsJson = (facts: readonly unknown[]): string => JSON.stringify({ facts })

describe('F3：精炼写 L1 同事务建 EVIDENCE 边（AC2）', () => {
  it('成功路径：l0_raw→L1 边与节点同事务落库，checkReachableToL0 判据②通过', async () => {
    const item = await claimWithL0('ok')
    const result = await makeProcessor(scriptedLlm(factsJson([{ text: '用户偏好中文', kind: 'persona', priority: 1 }])))(item)
    expect(result).toEqual({ completed: true, kinds: ['persona'] })

    const nodeId = memoryNodeId(MEMORY_REMEMBER_LAYER, '用户偏好中文')
    expect(await evidenceEdges()).toEqual([{ from: item.id, to: nodeId, reason: 'refine' }])
    const reachable = await checkReachableToL0(store.connection, nodeId, NOW.toISOString())
    expect(reachable.pass).toBe(true)
    expect(reachable.failingReasons).toEqual([])
    expect(await inboxStatus(item.id)).toBe('done')
  })

  it('边写入前崩溃：L1 节点 / 边 / done 标记一起回滚，回收重放只产一份', async () => {
    const item = await claimWithL0('crash')
    edgeState.mode = 'throw'
    await expect(
      makeProcessor(scriptedLlm(factsJson([{ text: '事务内崩溃事实', kind: 'work_fact', priority: 0 }])))(item),
    ).rejects.toThrow('crash-before-edge-write')

    // 三不变：无节点、无边、条目仍在 processing（markInboxItemDone 也回滚）。
    expect(await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS c')).toEqual([{ c: 0 }])
    expect(await evidenceEdges()).toEqual([])
    expect(await inboxStatus(item.id)).toBe('processing')

    // 回收重放：只产一份节点 + 一条边。回收把条目打回 pending，消费者按正常路径重新取队头
    // （markInboxItemDone 带 processing 守卫，直接拿旧 item 会 marked=false ⇒ 什么都不写）。
    edgeState.mode = 'real'
    expect(await reclaimProcessingInboxItems(store.connection, { now: NOW })).toBe(1)
    const reclaimed = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
    expect(reclaimed?.id).toBe(item.id)
    await makeProcessor(scriptedLlm(factsJson([{ text: '事务内崩溃事实', kind: 'work_fact', priority: 0 }])))(reclaimed!)
    expect(await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS c')).toEqual([{ c: 1 }])
    expect(await evidenceEdges()).toHaveLength(1)
  })
})

describe('F3：LLM 提议的 EVIDENCE 被拒绝建边并记审计（裁决 U4）', () => {
  it('关系跑者的 EVIDENCE 提议 ⇒ 不建 EVIDENCE 边、写 reject_evidence 审计', async () => {
    // 邻接候选：一条同层节点（带向量，能被 KNN 召回）。
    const neighborText = '既有的同层记忆'
    await upsertMemory(store.connection, {
      layer: MEMORY_REMEMBER_LAYER,
      text: neighborText,
      embedding: E1,
      embeddingModelId: 'test-embed',
      kind: 'work_fact',
      priority: 0,
      validAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
      actor: 'system',
    })
    const neighborId = memoryNodeId(MEMORY_REMEMBER_LAYER, neighborText)

    const proposals = JSON.stringify([{ target_id: neighborId, edge_type: 'EVIDENCE', reason: '编造的证据' }])
    const runner = createRelationRunner({
      connection: () => store.connection,
      llm: scriptedLlm(proposals) as never,
      embeddingEnabled: true,
      logger: { warn: () => {} },
    })
    const candidateId = memoryNodeId(MEMORY_REMEMBER_LAYER, '新的记忆')
    await store.connection.query(
      "CREATE (m:memory {id: '" + candidateId + "', layer: 'L1', kind: 'work_fact', priority: 0, " +
      "text: '新的记忆', valid_at: '" + NOW.toISOString() + "', recorded_at: '" + NOW.toISOString() + "', source_refs: []})",
    )
    await runner({
      itemId: 'item-rel-u4',
      route: ROUTE,
      entries: [{ id: candidateId, layer: MEMORY_REMEMBER_LAYER, kind: 'work_fact', text: '新的记忆', embedding: E1 }],
      now: NOW.toISOString(),
      signal: AbortSignal.timeout(5_000),
    })

    // 没有任何 EVIDENCE 边被 LLM 提议写出来（候选之间本来也没有结构边）。
    expect(await evidenceEdges()).toEqual([])
    const rejected = await audits('reject_evidence')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toContain('target=' + neighborId)
  })
})

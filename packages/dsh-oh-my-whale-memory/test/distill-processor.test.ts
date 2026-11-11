/**
 * INBOX 精炼处理器集成测试（Story 2.3 / R1、R2、N4、N5、N9、N10）。
 *
 * 真库（dim=4）+ 脚本化 ctx.llm 端口 + 假 embeddings 客户端。覆盖：
 * - 成功路径：单次 llm.stream → 每条 fact 一个 L1 节点、条目同事务标 done、refine success 记账；
 * - ① 事务内抛错 ⇒ 节点数/审计行数/条目状态三不变，回收重放只产一份；
 * - ② 同条目成功路径跑两次 ⇒ 节点与记账行数不增（R1 at-most-once）；
 * - ⑦ 无路由 ⇒ 不调 LLM、outcome=uncertain + reason=no-provider-route；
 * - ⑧ embedding 失败 ⇒ L1 照常写入且 embedding 三列为空，另记 uncertain 审计；
 * - N10 非法 kind/priority ⇒ 收敛缺省并记 uncertain 审计；
 * - 4xx 语义错 ⇒ outcome=failure 且 fatal（直接死信）；5xx ⇒ uncertain 且可退避。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-upsert.test.ts。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { claimNextInboxItem, enqueueInboxItem, reclaimProcessingInboxItems, type InboxItem } from '../src/inbox/queue'
import { InboxRefineError, createInboxConsumer } from '../src/inbox/consumer'
import { createIdleGate } from '../src/inbox/idle-gate'
import type { PromotionTracker } from '../src/inbox/promotion-trigger'
import {
  COERCED_CLASSIFICATION_REASON,
  EMBEDDING_FAILED_REASON,
  NO_PROVIDER_ROUTE_REASON,
  createInboxProcessor,
  type InboxProcessorDeps,
} from '../src/distill/processor'
import type { EmbedClient } from '../src/embedding/client'
import type { LlmPort } from '../src/distill/llm-refine'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'test-embed-model'
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase
let seq = 0
const nextId = (tag: string): string => 'proc-' + tag + '-' + process.pid + '-' + seq++

beforeEach(async () => {
  const dir = await makeTempDir('omw-distill-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const textDelta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finishChunk = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

/** 脚本化 llm 端口：记录调用次数/选项，按脚本产出 chunk。 */
function scriptedLlm(script: readonly StreamChunk[]): { llm: LlmPort; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* generate() {
          for (const chunk of script) yield chunk
        })()
      },
    },
  }
}

/** 一段合法模型输出（facts 数组）。 */
const okOutput = (facts: readonly unknown[]): readonly StreamChunk[] => [
  textDelta(JSON.stringify({ facts })),
  finishChunk({ kind: 'stop' }),
]

function makeProcessor(llm: LlmPort, overrides: Partial<InboxProcessorDeps> = {}) {
  return createInboxProcessor({
    connection: () => store.connection,
    llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    ...overrides,
  })
}

const ACCEPTING_EMBED: EmbedClient = {
  embed: async (_model, input) => ({
    ok: true,
    vectors: input.map((_text, index) => (index === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0])),
  }),
}
const failingEmbed = (reason: string): EmbedClient => ({
  embed: async () => ({ ok: false, reason, message: 'stub failure' }),
})

async function claimFixture(tag: string, payload: string): Promise<InboxItem> {
  const id = nextId(tag)
  await enqueueInboxItem(store.connection, { id, payload, kind: 'work_fact', sessionId: 'sess-1', now: NOW })
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

const refsOf = (row: Record<string, unknown>, column: string): string[] => {
  const value = row[column]
  return Array.isArray(value) ? value.map(String) : []
}

async function allLogs(): Promise<Record<string, unknown>[]> {
  return queryAll(
    store.connection,
    'MATCH (g:generation_log) RETURN g.kind AS kind, g.action AS action, g.policy AS policy, ' +
    'g.outcome AS outcome, g.reason AS reason, g.l0_refs AS l0_refs',
  )
}

function refineLogsFor(logs: readonly Record<string, unknown>[], id: string): Record<string, unknown>[] {
  return logs.filter((row) => String(row.kind) === 'refine' && refsOf(row, 'l0_refs').includes(id))
}

async function nodesFor(id: string): Promise<Record<string, unknown>[]> {
  const rows = await queryAll(
    store.connection,
    'MATCH (m:memory) RETURN m.id AS id, m.layer AS layer, m.kind AS kind, m.priority AS priority, ' +
    'm.text AS text, m.embedding AS embedding, m.embedding_model_id AS embedding_model_id, ' +
    'm.embedding_dim AS embedding_dim, m.source_refs AS source_refs',
  )
  return rows.filter((row) => refsOf(row, 'source_refs').includes(id))
}

async function inboxStatus(id: string): Promise<string> {
  const rows = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' RETURN q.status AS status, q.attempts AS attempts")
  return String(rows[0]?.status)
}

describe('成功路径（AC:560、R1、R4①）', () => {
  it('单次 llm.stream → 每条 fact 一个 L1 节点 + refine success 记账 + 条目同事务标 done', async () => {
    const item = await claimFixture('ok', '用户: 我偏好中文回复')
    const { llm, calls } = scriptedLlm(okOutput([
      { text: '用户偏好中文回复', kind: 'persona', priority: 3 },
      { text: '项目使用 pnpm 管理依赖', kind: 'work_fact', priority: 1 },
    ]))

    const result = await makeProcessor(llm)(item)

    expect(calls).toHaveLength(1)
    expect(result).toEqual({ completed: true, kinds: ['persona', 'work_fact'] })
    const nodes = await nodesFor(item.id)
    expect(nodes).toHaveLength(2)
    expect(nodes.map((node) => String(node.kind)).sort()).toEqual(['persona', 'work_fact'])
    expect(nodes.every((node) => String(node.layer) === 'L1')).toBe(true)
    expect(nodes.every((node) => refsOf(node, 'source_refs').includes(item.id))).toBe(true)
    expect(Number(nodes[0]!.embedding_dim)).toBe(0)

    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ action: 'refine_inbox', outcome: 'success' })
    expect(refsOf(logs[0]!, 'l0_refs')).toEqual([item.id])
    expect(await inboxStatus(item.id)).toBe('done')
  })

  it('② 同条目成功路径跑两次：节点与记账行数不增（R1 at-most-once）', async () => {
    const item = await claimFixture('replay', '原文')
    await makeProcessor(scriptedLlm(okOutput([{ text: '事实一', kind: 'work_fact', priority: 0 }])).llm)(item)
    const nodesAfterFirst = (await nodesFor(item.id)).length
    const logsAfterFirst = refineLogsFor(await allLogs(), item.id).length
    expect(nodesAfterFirst).toBe(1)

    const second = await makeProcessor(scriptedLlm(okOutput([
      { text: '事实一', kind: 'work_fact', priority: 0 },
      { text: '事实二', kind: 'persona', priority: 0 },
    ])).llm)(item)

    expect(second).toEqual({ completed: true, kinds: [] })
    expect((await nodesFor(item.id)).length).toBe(nodesAfterFirst)
    expect(refineLogsFor(await allLogs(), item.id).length).toBe(logsAfterFirst)
    expect(await inboxStatus(item.id)).toBe('done')
  })

  it('embedding 成功：写时嵌入三列落库（AC:589）', async () => {
    const item = await claimFixture('embed-ok', '原文')
    await makeProcessor(scriptedLlm(okOutput([{ text: '偏好中文', kind: 'persona', priority: 0 }])).llm, {
      embedding: ACCEPTING_EMBED,
      embeddingModel: 'BAAI/bge-m3',
      embeddingModelId: 'BAAI/bge-m3',
    })(item)
    const node = (await nodesFor(item.id))[0]!
    expect(node.embedding).not.toBeNull()
    expect(String(node.embedding_model_id)).toBe('BAAI/bge-m3')
    expect(Number(node.embedding_dim)).toBe(DIM)
  })
})

describe('① 崩溃重放（U12）', () => {
  it('事务内抛错 ⇒ 三不变；回收重放只产一份', async () => {
    const item = await claimFixture('txabort', '原文')
    // 文本 '!!!' 归一化后为空 → memoryNodeId 在**写库事务内**抛 empty_fingerprint_text。
    await expect(makeProcessor(scriptedLlm(okOutput([{ text: '!!!', kind: 'work_fact', priority: 0 }])).llm)(item))
      .rejects.toThrow()

    expect(await nodesFor(item.id)).toHaveLength(0)
    expect(refineLogsFor(await allLogs(), item.id)).toHaveLength(0)
    // 回滚把同事务里的 processing→done 一起撤销，条目仍是 processing（等启动回收）。
    expect(await inboxStatus(item.id)).toBe('processing')

    expect(await reclaimProcessingInboxItems(store.connection, { now: NOW })).toBe(1)
    const reclaimed = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
    expect(reclaimed?.id).toBe(item.id)

    await makeProcessor(scriptedLlm(okOutput([{ text: '崩溃后只应有一条事实', kind: 'work_fact', priority: 0 }])).llm)(reclaimed!)
    expect(await nodesFor(item.id)).toHaveLength(1)
    expect(refineLogsFor(await allLogs(), item.id)).toHaveLength(1)
    expect(await inboxStatus(item.id)).toBe('done')
  })
})

describe('R1 + R4① 端到端：消费者 + 处理器', () => {
  it('一条精炼：处理器自标 done、按精炼后的 kind 记提升信号、llm 只调一次', async () => {
    const id = nextId('e2e')
    await enqueueInboxItem(store.connection, { id, payload: '用户: 我偏好中文', kind: 'turn', sessionId: 'sess-9', now: NOW })
    const { llm, calls } = scriptedLlm(okOutput([
      { text: '偏好中文', kind: 'persona', priority: 0 },
      { text: '用 pnpm', kind: 'work_fact', priority: 0 },
    ]))
    const recorded: string[] = []
    const promotion = {
      recordL1: (input: { readonly kind: string }) => { recorded.push(input.kind) },
      recordSessionEnd: () => {},
    } as unknown as PromotionTracker
    const consumer = createInboxConsumer({
      connection: () => store.connection,
      gate: createIdleGate(),
      owner: 'test-owner',
      now: () => NOW,
      process: makeProcessor(llm),
      promotion,
    })

    expect(await consumer.runOnce()).toBe(1)
    consumer.stop()

    // R4①：记的是**精炼后的节点 kind**（persona/work_fact），不是采集来源标签 turn。
    expect(recorded).toEqual(['persona', 'work_fact'])
    expect(calls).toHaveLength(1)
    expect(await inboxStatus(id)).toBe('done')
    expect(await nodesFor(id)).toHaveLength(2)
    expect(refineLogsFor(await allLogs(), id)).toHaveLength(1)
  })
})

describe('⑦ 路由闸门（AC:568 / N5）', () => {
  it('无路由 ⇒ 不调 LLM、outcome=uncertain + reason=no-provider-route、fatal=false', async () => {
    const item = await claimFixture('noroute', '原文')
    const { llm, calls } = scriptedLlm(okOutput([]))

    const error = await makeProcessor(llm, { resolveRoute: () => null })(item).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(InboxRefineError)
    expect((error as InboxRefineError).reason).toBe(NO_PROVIDER_ROUTE_REASON)
    expect((error as InboxRefineError).fatal).toBe(false)
    expect(calls).toHaveLength(0)
    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ outcome: 'uncertain', reason: NO_PROVIDER_ROUTE_REASON })
    expect(await inboxStatus(item.id)).toBe('processing')
  })
})

describe('⑧ 写时嵌入降级（N4 / AC:589）', () => {
  it('embedding 失败 ⇒ L1 照常写入、三列留空、另记 uncertain 审计', async () => {
    const item = await claimFixture('embed-fail', '原文')
    const result = await makeProcessor(scriptedLlm(okOutput([{ text: '偏好中文', kind: 'persona', priority: 0 }])).llm, {
      embedding: failingEmbed('http-503'),
      embeddingModel: 'BAAI/bge-m3',
      embeddingModelId: 'BAAI/bge-m3',
    })(item)

    expect(result.completed).toBe(true)
    const nodes = await nodesFor(item.id)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.embedding).toBeNull()
    expect(nodes[0]!.embedding_model_id).toBeNull()
    expect(nodes[0]!.embedding_dim).toBeNull()

    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs.map((log) => String(log.outcome)).sort()).toEqual(['success', 'uncertain'])
    const uncertain = logs.find((log) => String(log.outcome) === 'uncertain')!
    expect(String(uncertain.reason)).toContain(EMBEDDING_FAILED_REASON)
    expect(String(uncertain.reason)).toContain('http-503')
    expect(await inboxStatus(item.id)).toBe('done')
  })
})

describe('失败分类与记账（AC:575-581 / N9 / N10）', () => {
  it('N10：非法 kind 收敛缺省并记 uncertain 审计', async () => {
    const item = await claimFixture('coerce', '原文')
    await makeProcessor(scriptedLlm(okOutput([{ text: '某种事实', kind: 'not-a-kind', priority: 0 }])).llm)(item)

    const node = (await nodesFor(item.id))[0]!
    expect(String(node.kind)).toBe('')
    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs.map((log) => String(log.outcome)).sort()).toEqual(['success', 'uncertain'])
    expect(String(logs.find((log) => String(log.outcome) === 'uncertain')!.reason)).toBe(COERCED_CLASSIFICATION_REASON)
  })

  it('4xx 语义错 ⇒ outcome=failure 且 fatal=true（首次即死信，不重试）', async () => {
    const item = await claimFixture('fatal', '原文')
    const { llm } = scriptedLlm([finishChunk({ kind: 'error', failure: { message: 'bad request', code: 'invalid_request', status: 400 } })])

    const error = await makeProcessor(llm)(item).then(() => null, (thrown: unknown) => thrown)

    expect((error as InboxRefineError).fatal).toBe(true)
    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ outcome: 'failure', reason: 'invalid_request' })
    expect(await inboxStatus(item.id)).toBe('processing')
  })

  it('5xx 瞬时失败 ⇒ outcome=uncertain 且 fatal=false（交给队列退避）', async () => {
    const item = await claimFixture('transient', '原文')
    const { llm } = scriptedLlm([finishChunk({ kind: 'error', failure: { message: 'boom', code: 'provider_error', status: 503 } })])

    const error = await makeProcessor(llm)(item).then(() => null, (thrown: unknown) => thrown)

    expect((error as InboxRefineError).fatal).toBe(false)
    expect((error as InboxRefineError).reason).toBe('provider_error')
    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ outcome: 'uncertain', reason: 'provider_error' })
  })
})

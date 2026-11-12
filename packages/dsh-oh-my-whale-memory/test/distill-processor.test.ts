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
import { writeL0Raw } from '../src/db/l0'
import { queryAll, upsertMemory } from '../src/db/memory'
import { claimNextInboxItem, completeInboxItem, enqueueInboxItem, reclaimProcessingInboxItems, type InboxItem } from '../src/inbox/queue'
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
import { EMBEDDING_MAX_BATCH, type EmbedClient } from '../src/embedding/client'
import { MAX_REFINE_FACT_TOKENS, type LlmPort } from '../src/distill/llm-refine'
import { MEMORY_REMEMBER_LAYER } from '../src/tools/memory-remember'
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

/**
 * 造一条「可精炼」的 INBOX 条目。
 *
 * **必须同时写 l0_raw 行且 id 相同**（Story 2.3 的 P1：capture 侧 L0 行与 INBOX 行同一身份）。
 * 否则精炼建 EVIDENCE 边时 l0_raw 端点缺失 ⇒ writeEvidenceEdges 记 endpoint-missing ⇒
 * processor 再补一条 write_evidence_skipped 的 uncertain 审计（P6/P16 的降级可见），
 * 于是「refine 审计 = 1 条」这类断言会被这条**正确**的降级行打破。
 *
 * 生产路径把两条写在同一事务里；这里是测试夹具，两个原语各自开事务即可（被测对象是 processor）。
 */
async function claimFixture(tag: string, payload: string): Promise<InboxItem> {
  const id = nextId(tag)
  await writeL0Raw(store.connection, { id, text: payload, recordedAt: NOW, actor: 'sess-1' })
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
    // T24：未产向量时三列是 NULL（不是 0），后续重嵌入才识别得出来。
    expect(nodes[0]!.embedding).toBeNull()
    expect(nodes[0]!.embedding_model_id).toBeNull()
    expect(nodes[0]!.embedding_dim).toBeNull()

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

describe('评审补钉（T3 / T7 / T20 / P4 追加项）', () => {
  it('评审 T20：facts 超过单请求上限时按 EMBEDDING_MAX_BATCH 分批（客户端被调 2 次）', async () => {
    const item = await claimFixture('embed-batch', '原文')
    const batches: number[] = []
    // Story 2.4 起写入去重按 cosine 合并节点：本用例必须给 9 条事实**互不相似**的向量，
    // 否则同向量事实会合并成 1 个节点。取 4 维超立方体的 9 个顶点：两两 |cos| ≤ 0.5
    // ⇒ distance ≥ 0.5 > ANN 粗筛上界 0.1001，既不合并也不触发版本链，且每条都带向量。
    const cube = (index: number): number[] => {
      const bits = index + 1
      return [0, 1, 2, 3].map((axis) => (((bits >> axis) & 1) === 1 ? 0.5 : -0.5))
    }
    let cursor = 0
    const counting: EmbedClient = {
      embed: async (_model, input) => {
        batches.push(input.length)
        return { ok: true, vectors: input.map(() => cube(cursor++)) }
      },
    }
    const facts = Array.from({ length: EMBEDDING_MAX_BATCH + 1 }, (_unused, index) => ({
      text: '事实' + index, kind: 'work_fact', priority: 0,
    }))
    await makeProcessor(scriptedLlm(okOutput(facts)).llm, {
      embedding: counting, embeddingModel: 'BAAI/bge-m3', embeddingModelId: 'BAAI/bge-m3',
    })(item)

    expect(batches).toEqual([EMBEDDING_MAX_BATCH, 1])
    const nodes = await nodesFor(item.id)
    expect(nodes).toHaveLength(EMBEDDING_MAX_BATCH + 1)
    expect(nodes.every((node) => node.embedding !== null)).toBe(true)
  })

  it('评审 P4：切分出的纯标点 tail 不再拖垮整条 INBOX（不抛错、不产死信、正常片段入库）', async () => {
    const item = await claimFixture('tail', '原文')
    const text = '甲'.repeat(MAX_REFINE_FACT_TOKENS) + '。...'
    const result = await makeProcessor(scriptedLlm(okOutput([{ text, kind: 'work_fact', priority: 1 }])).llm)(item)

    expect(result.completed).toBe(true)
    const nodes = await nodesFor(item.id)
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((node) => String(node.text).includes('甲'))).toBe(true)
    expect(await inboxStatus(item.id)).toBe('done')
  })

  it('评审 T3：coerced 不覆盖既有节点的分类与优先级（同指纹已有 persona/9）', async () => {
    const item = await claimFixture('keep-kind', '原文')
    await upsertMemory(store.connection, {
      layer: MEMORY_REMEMBER_LAYER, text: '偏好中文', kind: 'persona', priority: 9,
    })
    await makeProcessor(scriptedLlm(okOutput([{ text: '偏好中文', kind: 'not-a-kind', priority: 0 }])).llm)(item)

    const nodes = await nodesFor(item.id)
    expect(nodes).toHaveLength(1)
    expect(String(nodes[0]!.kind)).toBe('persona')
    expect(Number(nodes[0]!.priority)).toBe(9)
  })

  it('评审 T7：已 done 的条目直接 process ⇒ 不调 LLM、不写审计、不抛错', async () => {
    const item = await claimFixture('done-guard', '原文')
    await completeInboxItem(store.connection, item.id, { now: NOW })
    const { llm, calls } = scriptedLlm(okOutput([{ text: '不应产出', kind: 'work_fact', priority: 0 }]))

    const result = await makeProcessor(llm, { resolveRoute: () => null })(item)

    expect(result).toEqual({ completed: true, kinds: [] })
    expect(calls).toHaveLength(0)
    expect(refineLogsFor(await allLogs(), item.id)).toHaveLength(0)
    expect(await nodesFor(item.id)).toHaveLength(0)
    expect(await inboxStatus(item.id)).toBe('done')
  })
  it('评审 T12/T13：不返回的 LLM 被 LLM 子预算截断 ⇒ llm-timeout 可重试，第 4 次进死信', async () => {
    const item = await claimFixture('llm-timeout', '原文')
    // 永不产出 chunk、只在 signal 中止时 reject 的端口：模拟 provider 卡住。
    const hanging: LlmPort = {
      stream(options) {
        return (async function* generate() {
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted by llm budget')), { once: true })
          })
        })()
      },
    }

    // 夹具已把条目 claim 成 processing，而消费者只取 pending：先按启动回收语义放回队头。
    expect(await reclaimProcessingInboxItems(store.connection, { now: NOW })).toBe(1)

    let clock = NOW
    const consumer = createInboxConsumer({
      connection: () => store.connection,
      gate: createIdleGate(),
      owner: 'test-owner',
      now: () => clock,
      // timeoutMs 收紧到 60ms，等价地验证「LLM 只吃 min(timeoutMs, 20s)」这条子预算。
      process: makeProcessor(hanging, { timeoutMs: 60 }),
    })

    for (let round = 0; round < 4; round += 1) {
      await consumer.runOnce()
      clock = new Date(clock.getTime() + 30_000)
    }
    consumer.stop()

    expect(await inboxStatus(item.id)).toBe('failed')
    const logs = refineLogsFor(await allLogs(), item.id)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((log) => String(log.reason) === 'llm-timeout')).toBe(true)
  })
})

describe('① 崩溃重放（U12）', () => {
  it('事务内抛错 ⇒ 三不变；回收重放只产一份', async () => {
    const item = await claimFixture('txabort', '原文')
    // 事务内注入崩溃：now() 在 runInTransaction 的回调里才被求值（markInboxItemDone 的参数），
    // 抛错即触发 ROLLBACK。原先靠「归一化后为空的文本」制造事务内抛错，但 T4/P4 之后
    // 这类文本在解析层已被丢弃（那正是 T4 要消灭的路径），故改在时钟上注入。
    const crashing = makeProcessor(scriptedLlm(okOutput([{ text: '事务内崩溃', kind: 'work_fact', priority: 0 }])).llm, {
      now: () => { throw new Error('crash-inside-transaction') },
    })
    await expect(crashing(item)).rejects.toThrow('crash-inside-transaction')

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
    // 同 claimFixture：L0 行与 INBOX 行同一 id，否则 EVIDENCE 边端点缺失会多出一条降级审计。
    await writeL0Raw(store.connection, { id, text: '用户: 我偏好中文', recordedAt: NOW, actor: 'sess-9' })
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

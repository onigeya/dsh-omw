/**
 * 摘要重写消费者（Story 8.4 / T6、矩阵行 10–12、FR-29、INV-13）。
 *
 * 覆盖：append + 双时态（新版本 `parent_id` 指向旧版本、旧 `invalid_at`，旧正文逐字不变）；
 * LLM 失败保留旧摘要且条目回 pending；连续两轮失败进死信并 warn；链深达阈值即停止。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import { createInboxConsumer } from '../src/inbox/consumer'
import { l1InboxQueue, type InboxItem } from '../src/inbox/queue'
import { HANDLE_REWRITE_KIND, buildHandleRewritePayload, handleRewriteItemId } from '../src/context/handle-stats'
import { classifyHandle, readHandle, writeHandle } from '../src/context/handles'
import {
  MAX_SUMMARY_REWRITE_ATTEMPTS,
  SUMMARY_REWRITE_APPLIED_ACTION,
  SUMMARY_REWRITE_FAILED_ACTION,
  SUMMARY_REWRITE_STOPPED_ACTION,
  createSummaryRewriteProcessor,
} from '../src/distill/summary-rewrite'
import {
  SUMMARY_REWRITE_OUTPUT_SCHEMA,
  buildSummaryRewriteMessages,
  rewriteSummaryText,
  type LlmPort,
} from '../src/distill/llm-refine'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-summary-rewrite-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

/** 脚本化 LLM：每次调用都产出同一段脚本（或抛错）。 */
function scriptedLlm(script: readonly StreamChunk[] | Error): { llm: LlmPort, calls: number } {
  const state = { calls: 0 }
  const llm: LlmPort = {
    stream() {
      state.calls += 1
      if (script instanceof Error) throw script
      return (async function* generate() {
        for (const chunk of script) yield chunk
      })()
    },
  }
  return {
    llm,
    get calls() { return state.calls },
  }
}

const okScript = (summary: string): StreamChunk[] => [
  delta(JSON.stringify({ summary })),
  finish({ kind: 'stop' }),
]

function factNodes(): Promise<Array<{ id: string, text: string, parent: unknown, chain: number, invalid: unknown }>> {
  return queryRows(
    store.connection,
    "MATCH (m:memory) WHERE m.kind = 'handle' RETURN m.id AS id, m.text AS text, " +
    'm.parent_id AS parent, m.chain_depth AS chain, m.invalid_at AS invalid ORDER BY m.recorded_at ASC, m.id ASC',
  ).then((rows) => rows.map((row) => ({
    id: String(row.id),
    text: String(row.text),
    parent: row.parent,
    chain: Number(row.chain ?? 0),
    invalid: row.invalid,
  })))
}

async function countAudit(action: string): Promise<number> {
  const rows = await queryRows(
    store.connection,
    'MATCH (g:generation_log) WHERE g.action = $action RETURN count(g) AS total',
    { action },
  )
  return Number(rows[0]?.total ?? 0)
}

/** 造一个已 claim（processing）的重写条目，返回处理器可直接消费的 item。 */
async function enqueueAndClaim(handleId: string, sessionId: string): Promise<InboxItem> {
  await l1InboxQueue.enqueue(store.connection, {
    id: handleRewriteItemId(handleId),
    sessionId,
    kind: HANDLE_REWRITE_KIND,
    payload: JSON.stringify(buildHandleRewritePayload(handleId)),
    now: new Date(T0),
  })
  const claimed = await l1InboxQueue.claimNext(store.connection, { owner: 'test', now: new Date(T0) })
  if (claimed === null) throw new Error('claim 失败')
  return claimed
}

describe('prompt 与 schema 同文件（§14）', () => {
  it('消息含 sentinel preamble、输出 schema 与原文', () => {
    const messages = buildSummaryRewriteMessages('原文正文')
    const text = (messages[0]!.content as readonly { type: string, text: string }[])[0]!.text
    expect(text).toContain('Field descriptions are never valid values')
    expect(text).toContain(SUMMARY_REWRITE_OUTPUT_SCHEMA)
    expect(text).toContain('原文正文')
  })

  it('rewriteSummaryText：成功取 summary；空输出/非法 JSON 是可重试失败', async () => {
    const ok = await rewriteSummaryText({
      llm: scriptedLlm(okScript(' 新摘要 ')).llm,
      route: ROUTE,
      text: 'x',
      signal: AbortSignal.timeout(1000),
    })
    expect(ok).toEqual({ ok: true, summary: '新摘要' })

    const empty = await rewriteSummaryText({
      llm: scriptedLlm([finish({ kind: 'stop' })]).llm,
      route: ROUTE,
      text: 'x',
      signal: AbortSignal.timeout(1000),
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.failure.reason).toBe('empty-response')
      expect(empty.failure.retryable).toBe(true)
    }
  })
})

describe('矩阵行 10：重写成功 ⇒ append 新版本 + 旧 invalid_at（INV-13）', () => {
  it('新节点 parent_id 指向旧版本、chain_depth=1；旧正文逐字不变且已失效', async () => {
    const old = await writeHandle(store.connection, {
      sessionId: 's-rewrite',
      seq: 201,
      text: '旧摘要原文（逐字）',
      recordedAt: T0,
    })
    const item = await enqueueAndClaim(old.id, 's-rewrite')
    const processor = createSummaryRewriteProcessor({
      connection: () => store.connection,
      llm: scriptedLlm(okScript('重写后的摘要正文')).llm,
      resolveRoute: () => ROUTE,
      chainDepthThreshold: 2,
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })
    const result = await processor(item)
    expect(result.completed).toBe(true)

    const nodes = await factNodes()
    const oldNode = nodes.find((node) => node.id === old.id)
    const rewritten = nodes.find((node) => node.text === '重写后的摘要正文')
    expect(oldNode).toBeDefined()
    expect(rewritten).toBeDefined()
    // append：新节点指向旧版本，链深 +1。
    expect(rewritten?.parent).toBe(old.id)
    expect(rewritten?.chain).toBe(1)
    expect(String(rewritten?.invalid)).toBe('null')
    // 双时态：旧版本失效，但正文一个字都没改（不原地改写）。
    expect(String(oldNode?.invalid)).not.toBe('null')
    expect(oldNode?.text).toBe('旧摘要原文（逐字）')
    // 旧正文仍可读，只是 classifyHandle 归 handle_expired（矩阵行 10 的「直到失效」）。
    const record = await readHandle(store.connection, old.id)
    expect(record?.text).toBe('旧摘要原文（逐字）')
    expect(classifyHandle(record, 's-rewrite')).toEqual({ ok: false, failure: 'handle_expired' })
    // 条目已 done，并留一条 applied 审计。
    expect(await l1InboxQueue.readStatus(store.connection, item.id)).toBe('done')
    expect(await countAudit(SUMMARY_REWRITE_APPLIED_ACTION)).toBe(1)
  })
})

describe('矩阵行 11–12：失败保留旧摘要、连续两轮失败即停止', () => {
  function makeConsumer(llm: LlmPort, clock: { now: Date }) {
    const warn = vi.fn()
    const processor = createSummaryRewriteProcessor({
      connection: () => store.connection,
      llm,
      resolveRoute: () => ROUTE,
      chainDepthThreshold: 2,
      now: () => clock.now,
      logger: { warn },
    })
    const consumer = createInboxConsumer({
      connection: () => store.connection,
      gate: { isIdle: () => true },
      owner: 'test-rewrite',
      now: () => clock.now,
      process: processor,
      logger: { warn },
    })
    return { consumer, warn, processor }
  }

  it('LLM 5xx ⇒ 条目回 pending（attempts=1）、旧摘要保持有效、无新版本', async () => {
    const old = await writeHandle(store.connection, { sessionId: 's-fail', seq: 202, text: '失败用例旧摘要', recordedAt: T0 })
    await l1InboxQueue.enqueue(store.connection, {
      id: handleRewriteItemId(old.id),
      sessionId: 's-fail',
      kind: HANDLE_REWRITE_KIND,
      payload: JSON.stringify(buildHandleRewritePayload(old.id)),
      now: new Date(T0),
    })
    const clock = { now: new Date(T0) }
    const { consumer, warn } = makeConsumer(scriptedLlm(new Error('boom 500')).llm, clock)
    const before = (await factNodes()).length
    expect(await consumer.runOnce()).toBe(0)
    expect(warn).toHaveBeenCalled()

    const after = (await factNodes())
    expect(after.length).toBe(before)
    const record = await readHandle(store.connection, old.id)
    expect(record?.invalidAt).toBeNull()
    // 条目回到 pending（可重试），attempts 记 1。
    const rows = await queryRows(
      store.connection,
      'MATCH (i:l1_inbox {id: $id}) RETURN i.status AS status, i.attempts AS attempts',
      { id: handleRewriteItemId(old.id) },
    )
    expect(rows[0]?.status).toBe('pending')
    expect(Number(rows[0]?.attempts)).toBe(1)
    expect(await countAudit(SUMMARY_REWRITE_FAILED_ACTION)).toBeGreaterThanOrEqual(1)
  })

  it('连续第二轮失败 ⇒ 进死信 failed 并 warn 停止（不无限重试）', async () => {
    const old = await writeHandle(store.connection, { sessionId: 's-stop', seq: 203, text: '两轮失败旧摘要', recordedAt: T0 })
    await l1InboxQueue.enqueue(store.connection, {
      id: handleRewriteItemId(old.id),
      sessionId: 's-stop',
      kind: HANDLE_REWRITE_KIND,
      payload: JSON.stringify(buildHandleRewritePayload(old.id)),
      now: new Date(T0),
    })
    const clock = { now: new Date(T0) }
    const { consumer, warn } = makeConsumer(scriptedLlm(new Error('still 500')).llm, clock)
    expect(await consumer.runOnce()).toBe(0)
    // 退避 5s：推进时钟后才可再次取件。
    clock.now = new Date(new Date(T0).getTime() + 10_000)
    expect(await consumer.runOnce()).toBe(0)

    const rows = await queryRows(
      store.connection,
      'MATCH (i:l1_inbox {id: $id}) RETURN i.status AS status, i.attempts AS attempts',
      { id: handleRewriteItemId(old.id) },
    )
    expect(rows[0]?.status).toBe('failed')
    expect(Number(rows[0]?.attempts)).toBe(MAX_SUMMARY_REWRITE_ATTEMPTS)
    // 停止必须可见（warn 里点名「停止」）。
    expect(warn.mock.calls.some((call) => String(call[0]).includes('摘要重写停止'))).toBe(true)
    // 旧摘要仍在且有效。
    expect((await readHandle(store.connection, old.id))?.invalidAt).toBeNull()
  })
})

describe('链深护栏：已达阈值不再重写（停止 + warn + 留账）', () => {
  it('chain_depth=2（=阈值）⇒ 条目标 done、无新版本、写 stopped 审计', async () => {
    const old = await writeHandle(store.connection, { sessionId: 's-chain', seq: 204, text: '链深达阈值的旧摘要', recordedAt: T0 })
    await queryRows(store.connection, 'MATCH (m:memory {id: $id}) SET m.chain_depth = 2', { id: old.id })
    const item = await enqueueAndClaim(old.id, 's-chain')
    const warn = vi.fn()
    const processor = createSummaryRewriteProcessor({
      connection: () => store.connection,
      llm: scriptedLlm(okScript('不该被写进去的摘要')).llm,
      resolveRoute: () => ROUTE,
      chainDepthThreshold: 2,
      now: () => new Date(T0),
      logger: { warn },
    })
    const result = await processor(item)
    expect(result.completed).toBe(true)
    expect(warn.mock.calls.some((call) => String(call[0]).includes('chain_depth'))).toBe(true)
    const nodes = await factNodes()
    expect(nodes.some((node) => node.text === '不该被写进去的摘要')).toBe(false)
    expect(await l1InboxQueue.readStatus(store.connection, item.id)).toBe('done')
    expect(await countAudit(SUMMARY_REWRITE_STOPPED_ACTION)).toBe(1)
  })
})

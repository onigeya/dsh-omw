/**
 * 开局注入生成编排测试（Story 3.3 / B2；假 recall + 假 llm，0 开库）。
 *
 * 钉住的行为（spec D2/D3/D9/D10）：
 * - 成功：recall(top-8) → LLM 单通道（显式 provider/model、maxTokens=512）→ `{summary, evidence_ids}`
 *   → ready 文本含摘要与证据；evidence_ids 越界/编造被过滤；
 * - 降级阶梯：摘要超时 ⇒ 仅 L1 原文；摘要不可解析 ⇒ 仅 L1；L1 也为空 ⇒ skipped；
 * - 零注入：召回命中为空 / Config 关闭（零 recall、零 LLM）/ 无 llm / 非真人首条消息；
 * - 每会话一次（第二次不生成）、多会话隔离、首条消息按 1000 字符截断、embedding disabled 走关键词单路。
 */
import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  OPENSTART_LLM_TIMEOUT_MS,
  OPENSTART_MAX_QUERY_CHARS,
  OPENSTART_RECALL_TOP_K,
  buildOpenstartMessages,
  createOpenstartGenerator,
  parseOpenstartOutput,
  type OpenstartLlmPort,
  type OpenstartPreStepPayload,
  type OpenstartRecallPort,
  type OpenstartRoute,
} from '../src/injection/openstart'
import { createInjectionStore } from '../src/injection/state'
import type { RecallCoreResult, RecallResultItem } from '../src/recall/core'

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown = { kind: 'stop' }): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

const ROUTE: OpenstartRoute = { provider: 'test-provider', model: 'test-model' }

function humanMessage(text: string) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
function runtimeContextMessage(text: string) {
  return { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }
}

function makeRecall(items: readonly RecallResultItem[], embeddingEnabled = true) {
  const calls: Array<{ query: string; queryVector: readonly number[] | null; limit: number }> = []
  const port: OpenstartRecallPort = {
    embeddingEnabled,
    embedQuery: vi.fn(async () => [1, 0, 0, 0]),
    async recall(input) {
      calls.push({ query: input.query, queryVector: input.queryVector, limit: input.limit })
      const result: RecallCoreResult = { total: items.length, results: [...items], degraded: !embeddingEnabled, hint: '' }
      return result
    },
  }
  return { port, calls }
}

type LlmHandler = (input: {
  provider: string
  model: string
  messages: unknown
  maxTokens?: number
  signal?: AbortSignal
}) => AsyncIterable<StreamChunk>

function makeLlm(handler: LlmHandler) {
  const calls: Array<{ provider: string; model: string; maxTokens?: number; signal?: AbortSignal }> = []
  const llm: OpenstartLlmPort = {
    stream(input) {
      calls.push({ provider: input.provider, model: input.model, maxTokens: input.maxTokens, signal: input.signal })
      return handler(input)
    },
  }
  return { llm, calls }
}

function replyWith(text: string): LlmHandler {
  return () => (async function* generate() {
    yield delta(text)
    yield finish()
  })()
}

/** 永不产出、只有 signal abort 时才 reject（模拟超时路径）。 */
const hangingLlm: LlmHandler = ({ signal }) => (async function* generate() {
  await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('llm-timeout')))
  })
})()

const L2_ITEM: RecallResultItem = { id: 'l2-1', layer: 'L2', kind: 'work_method', priority: 0, text: '用户偏好 ESM' }
const L1_ITEM: RecallResultItem = { id: 'l1-1', layer: 'L1', kind: 'work_fact', priority: 0, text: '证据原文 A' }
const L1_ONLY: RecallResultItem = { id: 'l1-2', layer: 'L1', kind: 'work_fact', priority: 0, text: '只有 L1' }

const SUMMARY_JSON = JSON.stringify({ summary: '用户偏好 ESM，避免 CJS。', evidence_ids: ['l2-1'] })

function makeGenerator(args: {
  readonly store?: ReturnType<typeof createInjectionStore>
  readonly recallItems?: readonly RecallResultItem[]
  readonly embeddingEnabled?: boolean
  readonly llm?: OpenstartLlmPort | undefined
  readonly enabled?: boolean
  readonly timeoutMs?: number
  /** B4b：观测 logger（info 断言用；缺省空实现）。 */
  readonly logger?: { warn: (message: string) => void; info?: (message: string) => void }
}) {
  const store = args.store ?? createInjectionStore()
  const { port, calls: recallCalls } = makeRecall(args.recallItems ?? [L2_ITEM, L1_ITEM], args.embeddingEnabled ?? true)
  const generate = createOpenstartGenerator({
    store,
    recall: port,
    getLlm: () => ('llm' in args ? args.llm : undefined),
    enabled: () => args.enabled ?? true,
    resolveRoute: () => ROUTE,
    timeoutMs: args.timeoutMs,
    logger: args.logger ?? { warn: vi.fn() },
  })
  return { store, generate, recallCalls }
}

function payload(sessionId: string, text = '我偏好 ESM'): OpenstartPreStepPayload {
  return { messages: [humanMessage(text)], agent: { session: { id: sessionId } } }
}

describe('parseOpenstartOutput（schema 与边界）', () => {
  it('解析合法 JSON、过滤编造 id、summary 空视为失败', () => {
    const allowed = new Set(['l2-1', 'l1-1'])
    expect(parseOpenstartOutput(SUMMARY_JSON, allowed)).toEqual({ summary: '用户偏好 ESM，避免 CJS。', evidenceIds: ['l2-1'] })
    expect(parseOpenstartOutput(JSON.stringify({ summary: 'x', evidence_ids: ['l2-1', 'bogus', 'l2-1'] }), allowed))
      .toEqual({ summary: 'x', evidenceIds: ['l2-1'] })
    expect(parseOpenstartOutput(JSON.stringify({ summary: '   ', evidence_ids: [] }), allowed)).toBeNull()
    expect(parseOpenstartOutput('不是 JSON', allowed)).toBeNull()
    expect(parseOpenstartOutput(JSON.stringify({ evidence_ids: ['l2-1'] }), allowed)).toBeNull()
  })
})

describe('createOpenstartGenerator：成功与单通道纪律', () => {
  it('成功：recall(top-8) → 显式 provider/model 的 LLM(maxTokens=512) → ready 含摘要与证据', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate, recallCalls } = makeGenerator({ llm })

    await generate(payload('s-ok', '我偏好 ESM'))

    expect(recallCalls).toHaveLength(1)
    expect(recallCalls[0]).toMatchObject({ query: '我偏好 ESM', limit: OPENSTART_RECALL_TOP_K })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: ROUTE.provider, model: ROUTE.model, maxTokens: 512 })
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)

    expect(store.read('s-ok')).toMatchObject({ status: 'ready' })
    const text = store.textFor('s-ok')
    expect(text).toContain('用户偏好 ESM，避免 CJS。')
    expect(text).toContain('[L2] l2-1')
  })

  it('evidence_ids 编造/越界被过滤；未给证据时回落到 L1 证据行', async () => {
    const { llm } = makeLlm(replyWith(JSON.stringify({ summary: '摘要', evidence_ids: ['bogus'] })))
    const { store, generate } = makeGenerator({ llm })

    await generate(payload('s-bogus'))

    const text = store.textFor('s-bogus')
    expect(text).toContain('摘要')
    expect(text).not.toContain('bogus')
    expect(text).toContain('[L1] l1-1')
  })

  it('首条消息按 1000 字符截断；embedding disabled 时 queryVector=null（关键词单路仍可用）', async () => {
    const { llm } = makeLlm(replyWith(SUMMARY_JSON))
    const { generate, recallCalls } = makeGenerator({ llm, embeddingEnabled: false })

    await generate(payload('s-long', 'x'.repeat(1500)))

    expect(recallCalls[0]?.query).toHaveLength(OPENSTART_MAX_QUERY_CHARS)
    expect(recallCalls[0]?.queryVector).toBeNull()
  })
})

describe('createOpenstartGenerator：降级阶梯（D2）', () => {
  it('摘要超时 ⇒ 仅注入 L1 原文（ready，不含摘要）', async () => {
    const { llm } = makeLlm(hangingLlm)
    const { store, generate } = makeGenerator({ llm, timeoutMs: 10 })

    await generate(payload('s-timeout'))

    expect(store.read('s-timeout')).toMatchObject({ status: 'ready' })
    const text = store.textFor('s-timeout')
    expect(text).not.toContain('记忆摘要')
    expect(text).toContain('[L1] l1-1')
    expect(text).toContain('证据原文 A')
  })

  it('摘要不可解析（非 JSON）⇒ 仅 L1 原文', async () => {
    const { llm } = makeLlm(replyWith('这不是 JSON'))
    const { store, generate } = makeGenerator({ llm })

    await generate(payload('s-bad-json'))

    expect(store.read('s-bad-json')).toMatchObject({ status: 'ready' })
    expect(store.textFor('s-bad-json')).toContain('[L1] l1-1')
  })

  it('摘要失败且无 L1 ⇒ skipped（无注入）', async () => {
    const { llm } = makeLlm(hangingLlm)
    const { store, generate } = makeGenerator({ llm, recallItems: [L2_ITEM], timeoutMs: 10 })

    await generate(payload('s-no-l1'))

    expect(store.read('s-no-l1')).toMatchObject({ status: 'skipped' })
    expect(store.textFor('s-no-l1')).toBe('')
  })

  it('无 L2 命中 ⇒ 仅 L1（不调 LLM）', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate } = makeGenerator({ llm, recallItems: [L1_ONLY] })

    await generate(payload('s-l1-only'))

    expect(calls).toHaveLength(0)
    expect(store.read('s-l1-only')).toMatchObject({ status: 'ready' })
    expect(store.textFor('s-l1-only')).toContain('[L1] l1-2')
  })

  it('召回命中为空 ⇒ 零注入 skipped（不调 LLM）', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate } = makeGenerator({ llm, recallItems: [] })

    await generate(payload('s-empty'))

    expect(calls).toHaveLength(0)
    expect(store.read('s-empty')).toMatchObject({ status: 'skipped' })
  })

  it('Config 关闭 ⇒ skipped 且零 recall、零 LLM（AC:945-947）', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate, recallCalls } = makeGenerator({ llm, enabled: false })

    await generate(payload('s-disabled'))

    expect(recallCalls).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(store.read('s-disabled')).toMatchObject({ status: 'skipped' })
  })

  it('无 ctx.llm ⇒ skipped（零 LLM，不抛错）', async () => {
    const { store, generate, recallCalls } = makeGenerator({ llm: undefined })

    await generate(payload('s-no-llm'))

    expect(recallCalls).toHaveLength(0)
    expect(store.read('s-no-llm')).toMatchObject({ status: 'skipped' })
  })

  it('非真人首条消息（仅 runtime-context）⇒ 不生成、不改状态', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate, recallCalls } = makeGenerator({ llm })

    await generate({ messages: [runtimeContextMessage('cwd: /workspace')], agent: { session: { id: 's-synthetic' } } })

    expect(recallCalls).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(store.read('s-synthetic')).toBeUndefined()
  })
})

describe('createOpenstartGenerator：每会话一次与隔离', () => {
  it('同一会话第二次 pre-step 不再生成（ready 短路）', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate, recallCalls } = makeGenerator({ llm })

    await generate(payload('s-once', '第一句'))
    await generate(payload('s-once', '第二句'))

    expect(recallCalls).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(store.textFor('s-once')).toContain('用户偏好 ESM，避免 CJS。')
  })

  it('多会话隔离：不同 sessionKey 各自生成', async () => {
    const { llm, calls } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate, recallCalls } = makeGenerator({ llm })

    await generate(payload('s-a'))
    await generate(payload('s-b'))

    expect(recallCalls).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(store.read('s-a')?.status).toBe('ready')
    expect(store.read('s-b')?.status).toBe('ready')
  })
})

describe('createOpenstartGenerator：预算与 lastInjection（B3）', () => {
  it('超长证据被预算裁剪：text ≤8000 字符、lastInjection.truncated=true、unit=chars', async () => {
    const { llm } = makeLlm(replyWith(SUMMARY_JSON))
    const longL1 = Array.from({ length: 10 }, (_, index) => ({
      id: `long-${index}`,
      layer: 'L1',
      kind: 'work_fact',
      priority: 0,
      text: 'y'.repeat(1000),
    }))
    const { store, generate } = makeGenerator({ llm, recallItems: [L2_ITEM, ...longL1] })

    await generate(payload('s-budget'))

    const last = store.readLastInjection()
    expect(last).toMatchObject({ unit: 'chars', truncated: true, overBudget: false, degraded: false })
    expect(last?.chars).toBeLessThanOrEqual(8000)
    expect(last?.chars).toBeGreaterThan(0)
    expect(last?.items).toBeGreaterThan(0)
    expect(last?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(typeof last?.at).toBe('string')
  })

  it('不可删集合成员完整出现在 text 中；超预算 ⇒ lastInjection.overBudget=true 且 keptInviolable 计数', async () => {
    const { llm } = makeLlm(replyWith(SUMMARY_JSON))
    const pinned = { id: 'pin-rule', layer: 'L1', kind: 'work_fact', priority: -1, text: 'P'.repeat(9000) }
    const { store, generate } = makeGenerator({ llm, recallItems: [L2_ITEM, L1_ITEM, pinned] })

    await generate(payload('s-over-budget'))

    const text = store.textFor('s-over-budget')
    expect(text).toContain('[L1] pin-rule')
    expect(text).toContain('P'.repeat(9000))
    const last = store.readLastInjection()
    expect(last).toMatchObject({ overBudget: true, keptInviolable: 1, unit: 'chars' })
    expect(last?.chars).toBeGreaterThan(8000)
  })
})

describe('createOpenstartGenerator：观测事件（B4b）', () => {
  it('注入完成 ⇒ logger.info 单行含全部结构化字段（injection/items/chars/degraded/truncated/overBudget/keptInviolable/elapsedMs/unit）', async () => {
    const info = vi.fn()
    const { llm } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate } = makeGenerator({ llm, logger: { warn: vi.fn(), info } })

    await generate(payload('s-observe'))

    expect(info).toHaveBeenCalledTimes(1)
    const line = String(info.mock.calls[0]?.[0])
    expect(line.startsWith('injection: ')).toBe(true)
    for (const field of [
      'items=',
      'chars=',
      'degraded=false',
      'truncated=false',
      'overBudget=false',
      'keptInviolable=0',
      'elapsedMs=',
      'unit=chars',
    ]) {
      expect(line).toContain(field)
    }
    // 不含原文/凭据（NFR9）。
    expect(line).not.toContain('用户偏好')
    expect(line).not.toContain('sk-')
    expect(store.readLastInjection()?.items).toBeGreaterThan(0)
  })

  it('logger.info 抛错不影响注入结果（fire-and-forget / 不阻塞主路径）', async () => {
    const info = vi.fn(() => {
      throw new Error('logger down')
    })
    const { llm } = makeLlm(replyWith(SUMMARY_JSON))
    const { store, generate } = makeGenerator({ llm, logger: { warn: vi.fn(), info } })

    await expect(generate(payload('s-logger-throw'))).resolves.toBeUndefined()
    expect(info).toHaveBeenCalledTimes(1)
    expect(store.read('s-logger-throw')).toMatchObject({ status: 'ready' })
    expect(store.textFor('s-logger-throw')).toContain('记忆摘要')
  })
})

  it('摘要超长（远超 512 tokens 的等价长度）⇒ 实现不做二次 token 校验，交给预算裁剪（≤1200 字符 + 截断）', async () => {
    // 实现现状：只通过 LLM 的 `maxTokens=512` 约束输出（引擎侧截断），不在插件侧二次 estimateTokens
    // 校验；超长 summary 由 B3 预算的单条 1200 字符规则兜底。本用例钉住该现状，防未来语义漂移。
    const longSummary = 's'.repeat(5000)
    const { llm, calls } = makeLlm(replyWith(JSON.stringify({ summary: longSummary, evidence_ids: [] })))
    const { store, generate } = makeGenerator({ llm })

    await generate(payload('s-long-summary'))

    expect(calls[0]?.maxTokens).toBe(512)
    const text = store.textFor('s-long-summary')
    expect(text).toContain('记忆摘要（开局注入）：')
    const last = store.readLastInjection()
    expect(last?.truncated).toBe(true)
    expect(last?.chars).toBeLessThanOrEqual(8000)
    // 摘要行按单条 1200 字符截断（含省略号）。
    const summaryLine = text.split('\n')[1]!
    expect(summaryLine.endsWith('…')).toBe(true)
    expect(summaryLine.length).toBeLessThanOrEqual(1200)
  })

describe('prompt 与 schema 同文件（§14）', () => {
  it('buildOpenstartMessages：sentinel preamble 在首行、含 schema、query 与候选', () => {
    const messages = buildOpenstartMessages('我偏好 ESM', [L2_ITEM, L1_ITEM])
    const text = (messages[0]?.content as readonly { type: string; text: string }[])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(text.startsWith('Field descriptions are never valid values; set them to null')).toBe(true)
    expect(text).toContain('output JSON schema'.replace('output ', '输出 ')) // 同文件 schema 已内联
    expect(text).toContain('我偏好 ESM')
    expect(text).toContain('[L2] l2-1')
    expect(text).toContain('[L1] l1-1')
  })

  it('默认超时是 3000ms（AC:934 / NFR1）', () => {
    expect(OPENSTART_LLM_TIMEOUT_MS).toBe(3000)
  })
})

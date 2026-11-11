/**
 * 精炼单元测试（Story 2.3 / AC:567-585、N1、N10、R2）。
 *
 * 覆盖：prompt 与 schema 同文件 + sentinel preamble；一次尝试只有一次 llm.stream；
 * 输出收敛为 ≤150 token 且 kind/priority 非法即收敛缺省并标 coerced；失败分类的
 * retryable 决定退避还是死信（5xx/429/超时/空/JSON = 可重试，4xx/max-tokens = 不可重试）。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MEMORY_KIND, DEFAULT_MEMORY_PRIORITY } from '../src/db/memory'
import { MEMORY_KINDS } from '../src/tools/memory-remember'
import {
  MAX_REFINE_FACT_TOKENS,
  REFINE_MAX_OUTPUT_TOKENS,
  REFINE_OUTPUT_SCHEMA,
  REFINE_SENTINEL_PREAMBLE,
  buildRefineMessages,
  estimateTokens,
  isRetryableStatus,
  parseRefineOutput,
  refineTranscript,
  splitToBudget,
  type LlmPort,
} from '../src/distill/llm-refine'

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

interface StreamCall {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
  readonly text: string
}

/** 脚本化 llm 端口：记录每次调用，按脚本产出 chunk（或抛出）。 */
function scriptedLlm(script: readonly StreamChunk[] | Error): { llm: LlmPort; calls: StreamCall[] } {
  const calls: StreamCall[] = []
  const llm: LlmPort = {
    stream(options) {
      const text = options.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens, signal: options.signal, text })
      if (script instanceof Error) throw script
      return (async function* generate() {
        for (const chunk of script) yield chunk
      })()
    },
  }
  return { llm, calls }
}

const route = { provider: 'test-provider', model: 'test-model' }
const jsonFacts = (facts: unknown): string => JSON.stringify({ facts })

describe('prompt 与 schema 同文件（AC:573）', () => {
  it('消息里含 sentinel preamble、输出 schema 与对话原文', () => {
    const messages = buildRefineMessages('用户: 记住我偏好中文')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    const text = (messages[0]!.content as readonly { type: string; text: string }[])[0]!.text
    expect(text).toContain(REFINE_SENTINEL_PREAMBLE)
    expect(text).toContain(REFINE_OUTPUT_SCHEMA)
    expect(text).toContain('用户: 记住我偏好中文')
  })
})

describe('一次尝试 = 一次 llm.stream（R2）', () => {
  it('成功路径只调用一次，并透传 provider/model/maxTokens', async () => {
    const { llm, calls } = scriptedLlm([
      delta(jsonFacts([{ text: '用户偏好中文', kind: 'persona', priority: 5 }])),
      finish({ kind: 'stop' }),
    ])
    const result = await refineTranscript({
      llm,
      route,
      transcript: '原文',
      signal: AbortSignal.timeout(5_000),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'test-provider', model: 'test-model', maxTokens: REFINE_MAX_OUTPUT_TOKENS })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.facts).toEqual([{ text: '用户偏好中文', kind: 'persona', priority: 5, coerced: false }])
    }
  })
})

describe('输出收敛（AC:572 / N10）', () => {
  it('非法 kind 与越界 priority 收敛为缺省常量并标 coerced', () => {
    const facts = parseRefineOutput(jsonFacts([
      { text: '合法', kind: 'work_fact', priority: 7 },
      { text: '非法 kind', kind: 'not-a-kind', priority: 7 },
      { text: '越界 priority', kind: 'persona', priority: 999 },
      { text: '缺字段' },
    ]))
    expect(facts).not.toBeNull()
    expect(facts![0]).toEqual({ text: '合法', kind: 'work_fact', priority: 7, coerced: false })
    expect(facts![1]).toMatchObject({ kind: DEFAULT_MEMORY_KIND, coerced: true })
    expect(facts![2]).toMatchObject({ kind: 'persona', priority: DEFAULT_MEMORY_PRIORITY, coerced: true })
    expect(facts![3]).toMatchObject({ kind: DEFAULT_MEMORY_KIND, priority: DEFAULT_MEMORY_PRIORITY, coerced: true })
  })

  it('超预算的单条事实按 ≤150 token 切分，且拼接后与原文一致', () => {
    const sentence = '这是一条需要被切分的原子事实。'
    const long = sentence.repeat(60)
    const pieces = splitToBudget(long)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((piece) => estimateTokens(piece) <= MAX_REFINE_FACT_TOKENS)).toBe(true)
    expect(pieces.join('')).toBe(long)
  })

  it('空 facts 数组是合法输出（原文没有值得长期记住的内容）', () => {
    expect(parseRefineOutput(jsonFacts([]))).toEqual([])
  })
})

describe('失败分类（AC:575-581）', () => {
  it('finish.error：5xx 可重试、4xx 不可重试', async () => {
    const server = scriptedLlm([finish({ kind: 'error', failure: { message: 'boom', code: 'provider_error', status: 503 } })])
    const serverResult = await refineTranscript({ llm: server.llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(serverResult.ok).toBe(false)
    if (!serverResult.ok) expect(serverResult.failure).toMatchObject({ retryable: true, reason: 'provider_error' })

    const client = scriptedLlm([finish({ kind: 'error', failure: { message: 'bad request', code: 'invalid_request', status: 400 } })])
    const clientResult = await refineTranscript({ llm: client.llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(clientResult.ok).toBe(false)
    if (!clientResult.ok) expect(clientResult.failure).toMatchObject({ retryable: false, reason: 'invalid_request' })
  })

  it('max-tokens 截断不可重试；空响应与非法 JSON 可重试', async () => {
    const truncated = scriptedLlm([delta('{"facts":['), finish({ kind: 'max-tokens' })])
    const truncatedResult = await refineTranscript({ llm: truncated.llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(truncatedResult.ok).toBe(false)
    if (!truncatedResult.ok) expect(truncatedResult.failure).toMatchObject({ reason: 'max-tokens', retryable: false })

    const empty = scriptedLlm([finish({ kind: 'stop' })])
    const emptyResult = await refineTranscript({ llm: empty.llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(emptyResult.ok).toBe(false)
    if (!emptyResult.ok) expect(emptyResult.failure).toMatchObject({ reason: 'empty-response', retryable: true })

    const garbage = scriptedLlm([delta('抱歉，我无法完成'), finish({ kind: 'stop' })])
    const garbageResult = await refineTranscript({ llm: garbage.llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(garbageResult.ok).toBe(false)
    if (!garbageResult.ok) expect(garbageResult.failure).toMatchObject({ reason: 'json-parse-failed', retryable: true })
  })

  it('任务预算超时（signal 已中止）归类 llm-timeout 且可重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const { llm } = scriptedLlm(new Error('The operation was aborted'))
    const result = await refineTranscript({ llm, route, transcript: 'x', signal: controller.signal })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toMatchObject({ reason: 'llm-timeout', retryable: true })
  })

  it('未给 finish 视为可重试失败；isRetryableStatus 的边界', async () => {
    const { llm } = scriptedLlm([delta('{}')])
    const result = await refineTranscript({ llm, route, transcript: 'x', signal: AbortSignal.timeout(1_000) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toMatchObject({ reason: 'llm-no-finish', retryable: true })
    expect(isRetryableStatus(undefined)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
  })
})

describe('token 估算', () => {
  it('CJK 按字符、其余按词', () => {
    expect(estimateTokens('中文四字')).toBe(4)
    expect(estimateTokens('hello world')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('MEMORY_KINDS 与输出 schema 的 kind 值域同源', () => {
    expect(MEMORY_KINDS.length).toBeGreaterThan(0)
    expect(parseRefineOutput(jsonFacts([{ text: 'x', kind: MEMORY_KINDS[0], priority: 0 }]))![0]).toMatchObject({ coerced: false })
  })
})

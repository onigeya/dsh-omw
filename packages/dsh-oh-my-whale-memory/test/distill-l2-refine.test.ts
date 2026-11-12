/**
 * L2 综合与忠实性核实（Story 2.5 / FR-5、AC:674、U5、U11、U13、AD-15）。
 *
 * 纯逻辑文件（不碰 LadybugDB，无开库），故不受每进程约 15 个实例的上限约束。
 * 与 2.3 的 `distill-llm-refine.test.ts` 同形：一次尝试 = 一次 llm.stream，
 * retryable 决定进退避还是死信。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MEMORY_KIND, DEFAULT_MEMORY_PRIORITY } from '../src/db/memory'
import { MEMORY_KINDS } from '../src/tools/memory-remember'
import { MAX_REFINE_FACT_TOKENS, type LlmPort } from '../src/distill/llm-refine'
import {
  L2_MAX_OUTPUT_TOKENS,
  L2_OUTPUT_SCHEMA,
  L2_SENTINEL_PREAMBLE,
  L2_VERIFY_MAX_OUTPUT_TOKENS,
  L2_VERIFY_SCHEMA,
  MAX_L2_STATEMENT_TOKENS,
  buildL2Messages,
  buildVerifyMessages,
  parseL2Output,
  parseVerifyOutput,
  refineToL2,
  verifyL2Statement,
  type L2SourceFact,
} from '../src/distill/l2-refine'

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

interface StreamCall {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly text: string
}

function scriptedLlm(script: readonly StreamChunk[] | Error): { llm: LlmPort; calls: StreamCall[] } {
  const calls: StreamCall[] = []
  const llm: LlmPort = {
    stream(options) {
      const text = options.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens, text })
      if (script instanceof Error) throw script
      return (async function* generate() {
        for (const chunk of script) yield chunk
      })()
    },
  }
  return { llm, calls }
}

const ROUTE = { provider: 'test-provider', model: 'test-model' }
const FACTS: readonly L2SourceFact[] = [
  { id: 'l1-a', text: 'pnpm 安装 @ladybugdb/core 需要 allowBuilds', kind: 'work_fact' },
  { id: 'l1-b', text: 'Windows 上 vector 扩展需要 PATH 提供 OpenSSL 3', kind: 'work_fact' },
]
const signal = new AbortController().signal

describe('prompt 与 schema 同文件 + sentinel（AC:573 的 L2 延续）', () => {
  it('L2 综合消息含 sentinel、schema、每条来源的 id 与 kind', () => {
    const messages = buildL2Messages(FACTS)
    expect(messages).toHaveLength(1)
    const text = messages[0]!.content[0]!.text
    expect(text).toContain(L2_SENTINEL_PREAMBLE)
    expect(text).toContain(L2_OUTPUT_SCHEMA)
    expect(text).toContain('id=l1-a')
    expect(text).toContain('kind=work_fact')
  })

  it('核实消息含 sentinel、核实 schema、待判定陈述与来源', () => {
    const text = buildVerifyMessages('L2 陈述正文', FACTS)[0]!.content[0]!.text
    expect(text).toContain(L2_SENTINEL_PREAMBLE)
    expect(text).toContain(L2_VERIFY_SCHEMA)
    expect(text).toContain('L2 陈述正文')
    expect(text).toContain('id=l1-b')
  })
})

describe('parseL2Output', () => {
  it('合法输出：text 原样、kind/priority 保留', () => {
    const result = parseL2Output(JSON.stringify({ text: '复合经验', kind: 'work_fact', priority: 7 }))
    expect(result).toEqual({ ok: true, statement: { text: '复合经验', kind: 'work_fact', priority: 7 } })
  })

  it('kind 非法 / priority 越界 → 收敛缺省值（不抛、不整条丢弃）', () => {
    const result = parseL2Output(JSON.stringify({ text: 'x', kind: '不存在的类', priority: 9999 }))
    expect(result).toEqual({
      ok: true,
      statement: { text: 'x', kind: DEFAULT_MEMORY_KIND, priority: DEFAULT_MEMORY_PRIORITY },
    })
  })

  it('无 JSON / text 为空 / 超 token 预算 → 失败，且超预算是不可重试', () => {
    expect(parseL2Output('抱歉，我无法完成')).toMatchObject({ ok: false, failure: { reason: 'json-parse-failed', retryable: true } })
    expect(parseL2Output('{"text":"   "}')).toMatchObject({ ok: false, failure: { reason: 'empty-statement', retryable: true } })

    // CJK 每字 1 token，150 字正好顶到上限，151 字必超。
    const overBudget = parseL2Output(JSON.stringify({ text: '甲'.repeat(MAX_L2_STATEMENT_TOKENS + 1) }))
    expect(overBudget).toMatchObject({ ok: false, failure: { reason: 'statement-over-budget', retryable: false } })
    expect(MAX_L2_STATEMENT_TOKENS).toBe(MAX_REFINE_FACT_TOKENS)
  })
})

describe('refineToL2：一次尝试 = 一次 llm.stream', () => {
  it('成功路径只调用一次并透传 provider/model/maxTokens', async () => {
    const { llm, calls } = scriptedLlm([
      delta(JSON.stringify({ text: '经验陈述', kind: 'work_fact', priority: 3 })),
      finish({ kind: 'stop' }),
    ])
    const result = await refineToL2({ llm, route: ROUTE, facts: FACTS, signal })
    expect(result).toMatchObject({ ok: true, statement: { text: '经验陈述', kind: 'work_fact', priority: 3 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'test-provider', model: 'test-model', maxTokens: L2_MAX_OUTPUT_TOKENS })
    expect(calls[0]!.text).toContain('id=l1-a')
  })

  it('error / aborted / 抛出 → 可重试；max-tokens → 不可重试', async () => {
    const err = scriptedLlm([finish({ kind: 'error', failure: { message: 'boom', code: 'provider_error', status: 503 } })])
    expect(await refineToL2({ llm: err.llm, route: ROUTE, facts: FACTS, signal })).toMatchObject({
      ok: false,
      failure: { reason: 'provider_error', retryable: true },
    })

    const aborted = scriptedLlm([finish({ kind: 'aborted', failure: { message: '用户取消' } })])
    expect(await refineToL2({ llm: aborted.llm, route: ROUTE, facts: FACTS, signal })).toMatchObject({
      ok: false,
      failure: { reason: 'llm-aborted', retryable: true },
    })

    const thrown = scriptedLlm(new Error('The operation was aborted'))
    expect(await refineToL2({ llm: thrown.llm, route: ROUTE, facts: FACTS, signal })).toMatchObject({
      ok: false,
      failure: { reason: 'llm-threw', retryable: true },
    })

    const truncated = scriptedLlm([delta('{"text":"半'), finish({ kind: 'max-tokens' })])
    expect(await refineToL2({ llm: truncated.llm, route: ROUTE, facts: FACTS, signal })).toMatchObject({
      ok: false,
      failure: { reason: 'max-tokens', retryable: false },
    })

    const empty = scriptedLlm([finish({ kind: 'stop' })])
    expect(await refineToL2({ llm: empty.llm, route: ROUTE, facts: FACTS, signal })).toMatchObject({
      ok: false,
      failure: { reason: 'empty-response', retryable: true },
    })
  })
})

describe('parseVerifyOutput', () => {
  it('两个布尔齐备 → ok，reason 缺省为空串', () => {
    expect(parseVerifyOutput('{"faithful":true,"conflict":false}')).toEqual({
      ok: true, faithful: true, conflict: false, reason: '',
    })
    expect(parseVerifyOutput('{"faithful":false,"conflict":true,"reason":"与来源矛盾"}')).toEqual({
      ok: true, faithful: false, conflict: true, reason: '与来源矛盾',
    })
  })

  it('布尔缺失或类型不符 → bad-verdict（不猜默认值）', () => {
    expect(parseVerifyOutput('{"faithful":"true","conflict":false}')).toMatchObject({
      ok: false,
      failure: { reason: 'bad-verdict', retryable: true },
    })
    expect(parseVerifyOutput('{"faithful":true}')).toMatchObject({ ok: false, failure: { reason: 'bad-verdict' } })
    expect(parseVerifyOutput('随便一段话')).toMatchObject({ ok: false, failure: { reason: 'json-parse-failed' } })
  })
})

describe('verifyL2Statement（AD-15 降级通道）', () => {
  it('成功路径透传 maxTokens 并解析判定', async () => {
    const { llm, calls } = scriptedLlm([
      delta(JSON.stringify({ faithful: false, conflict: true, reason: '超出源材料' })),
      finish({ kind: 'stop' }),
    ])
    const result = await verifyL2Statement({ llm, route: ROUTE, statement: 'L2 陈述', facts: FACTS, signal })
    expect(result).toEqual({ ok: true, faithful: false, conflict: true, reason: '超出源材料' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.maxTokens).toBe(L2_VERIFY_MAX_OUTPUT_TOKENS)
  })

  it('调用失败返回 ok:false（由调用方 throw 让 INBOX 重试，绝不当作判定失败）', async () => {
    const thrown = scriptedLlm(new Error('connection reset'))
    const result = await verifyL2Statement({ llm: thrown.llm, route: ROUTE, statement: 's', facts: FACTS, signal })
    expect(result).toMatchObject({ ok: false, failure: { reason: 'llm-threw', retryable: true } })
  })
})

describe('七类 kind 的单一来源', () => {
  it('schema 与指令里逐字枚举 MEMORY_KINDS', () => {
    for (const kind of MEMORY_KINDS) {
      expect(L2_OUTPUT_SCHEMA).toContain(kind)
      expect(buildL2Messages(FACTS)[0]!.content[0]!.text).toContain(kind)
    }
  })
})

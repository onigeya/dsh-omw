/**
 * 处境感知查询改写测试（Story 9.3 / T2、spec I/O 矩阵 5–8）。
 *
 * 断言对象是 `src/recall/query-rewrite.ts` 的实际契约：
 * - 矩阵 5：LLM 超时 / 5xx ⇒ 该步降级、查询退回处境原文、`degraded: true`；
 * - 矩阵 6：HyDE 与上下文改写叠加（先改写再 HyDE）；任一步失败即降级，
 *   已成功的前置步骤不丢弃（最终查询取已生效的最长链路）；
 * - 矩阵 7：无 LLM / 无路由 ⇒ 降级，不抛错（改写是增益路径，不能把召回拖挂）；
 * - 矩阵 8：改写输出为空 / 非 JSON / 缺字段 ⇒ 降级为处境原文。
 *
 * 全部注入假 LLM 端口（`RewriteLlmPort`），**不打真实网络、无真实时钟**。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_REWRITE_INSTRUCTION,
  HYDE_INSTRUCTION,
  REWRITE_MAX_OUTPUT_TOKENS,
  REWRITE_SENTINEL_PREAMBLE,
  buildContextRewriteMessages,
  buildHydeMessages,
  parseRewriteField,
  rewriteSituatedQuery,
  type RewriteLlmPort,
  type RewriteRoute,
} from '../src/recall/query-rewrite'
import { situationQueryText, type SituationDescriptor } from '../src/recall/situation'

const DESCRIPTOR: SituationDescriptor = {
  goal: '修 story-9-3 的召回降级',
  tools: ['memory_recall'],
  files: ['src/recall/rerank.ts'],
  errors: ['timeout'],
  recentUserTurns: ['修 story-9-3 的召回降级'],
}

/** 降级目标：处境原文（矩阵 5/7/8 的期望查询串）。 */
const SITUATION_TEXT = situationQueryText(DESCRIPTOR)

const ROUTE: RewriteRoute = { provider: 'test-provider', model: 'test-model' }

type Step = { readonly text: string } | { readonly throw: Error } | { readonly hang: true }

interface FakeLlm {
  readonly port: RewriteLlmPort
  readonly calls: Array<{
    readonly provider: string
    readonly model: string
    readonly messages: readonly unknown[]
    readonly maxTokens?: number
  }>
}

/**
 * 按顺序消费脚本的假 LLM：
 * - `{ text }`：正常吐一段 `text-delta` + `finish`；
 * - `{ throw }`：首个 `next()` 即 reject（模拟 5xx / 网络错）；
 * - `{ hang }`：挂起直到注入的 `signal` 中止（模拟超时）。
 */
function scriptedLlm(script: readonly Step[]): FakeLlm {
  const calls: FakeLlm['calls'] = []
  const port: RewriteLlmPort = {
    async *stream(options) {
      calls.push(options)
      const step = script[calls.length - 1]
      if (step === undefined) throw new Error('假 LLM 收到超出脚本的调用')
      if ('throw' in step) throw step.throw
      if ('hang' in step) {
        await new Promise<never>((_resolve, reject) => {
          if (options.signal?.aborted === true) {
            reject(new Error('aborted'))
            return
          }
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } else {
        yield { type: 'text-delta', text: step.text } as never
      }
      yield { type: 'finish', reason: 'stop' } as never
    },
  }
  return { port, calls }
}

async function rewrite(
  script: readonly Step[],
  overrides: Partial<Parameters<typeof rewriteSituatedQuery>[0]> = {},
) {
  const llm = scriptedLlm(script)
  const result = await rewriteSituatedQuery({
    descriptor: DESCRIPTOR,
    fallbackQuery: '用户原始 query',
    llm: llm.port,
    route: ROUTE,
    ...overrides,
  })
  return { result, llm }
}

describe('矩阵 5：LLM 超时 / 5xx ⇒ 降级为处境原文 + degraded', () => {
  it('5xx（端口抛错）⇒ 查询退回处境原文，reason=llm-error，不抛', async () => {
    const { result } = await rewrite([{ throw: new Error('upstream returned HTTP 500') }])
    expect(result.query).toBe(SITUATION_TEXT)
    expect(result.lanes).toEqual([])
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('llm-error')
  })

  it('超时（signal 中止）⇒ 同样降级为处境原文，且只跑了第一步', async () => {
    const { result, llm } = await rewrite([{ hang: true }, { text: '{"query":"不该跑到这一步"}' }], { timeoutMs: 10 })
    expect(result.query).toBe(SITUATION_TEXT)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('llm-error')
    expect(llm.calls).toHaveLength(1)
  })
})

describe('矩阵 6：HyDE 与改写叠加（先改写再 HyDE）；任一步失败即降级', () => {
  it('两步都成功 ⇒ lanes=[context-rewrite, hyde]，检索式在前、假设文本在后', async () => {
    const { result, llm } = await rewrite([
      { text: '{"query":"story-9-3 召回降级 rerank.ts"}' },
      { text: '{"hypothetical":"记忆里大概会记：story-9-3 的处境召回在 reranker 5xx 时降级为 System One-only。"}' },
    ])
    expect(result.lanes).toEqual(['context-rewrite', 'hyde'])
    expect(result.degraded).toBe(false)
    expect(result.degradedReason).toBeUndefined()
    expect(result.query).toBe(
      'story-9-3 召回降级 rerank.ts\n' +
      '记忆里大概会记：story-9-3 的处境召回在 reranker 5xx 时降级为 System One-only。',
    )
    // 第二步吃的输入是第一步的输出（先改写再 HyDE），且两步是不同 prompt。
    expect(llm.calls).toHaveLength(2)
    expect(JSON.stringify(llm.calls[0]?.messages)).toContain('检索查询改写器')
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('记忆假设生成器')
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('story-9-3 召回降级 rerank.ts')
    // AD-5：显式路由透传（不自带 key、不猜 provider/model）。
    expect(llm.calls[0]).toMatchObject({ provider: 'test-provider', model: 'test-model', maxTokens: REWRITE_MAX_OUTPUT_TOKENS })
  })

  it('HyDE 失败、改写成功 ⇒ 降级但保留改写结果（lanes 只含 context-rewrite）', async () => {
    const { result, llm } = await rewrite([
      { text: '{"query":"story-9-3 召回降级"}' },
      { throw: new Error('HTTP 503') },
    ])
    expect(result.query).toBe('story-9-3 召回降级')
    expect(result.lanes).toEqual(['context-rewrite'])
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('llm-error')
    expect(llm.calls).toHaveLength(2)
  })

  it('第一步失败时不再尝试第二步（降级不叠加成本）', async () => {
    const { result, llm } = await rewrite([{ throw: new Error('HTTP 502') }, { text: '{"hypothetical":"x"}' }])
    expect(llm.calls).toHaveLength(1)
    expect(result.query).toBe(SITUATION_TEXT)
    expect(result.lanes).toEqual([])
  })

  it('prompt 与输出 schema 同文件、带 sentinel preamble（§14）', () => {
    expect(CONTEXT_REWRITE_INSTRUCTION).toContain(REWRITE_SENTINEL_PREAMBLE)
    expect(HYDE_INSTRUCTION).toContain(REWRITE_SENTINEL_PREAMBLE)
    expect(CONTEXT_REWRITE_INSTRUCTION).toContain('{"query": string}')
    expect(HYDE_INSTRUCTION).toContain('{"hypothetical": string}')
    // 组装的消息里带上处境摘要（截断后的单行检索式）。
    const contextMessages = buildContextRewriteMessages(DESCRIPTOR)
    expect(JSON.stringify(contextMessages)).toContain('memory_recall')
    const hydeMessages = buildHydeMessages(DESCRIPTOR, '改写后的检索式')
    expect(JSON.stringify(hydeMessages)).toContain('改写后的检索式')
  })
})

describe('矩阵 7：无 LLM ⇒ 降级，不抛', () => {
  it('llm=undefined ⇒ reason=no-llm，查询即处境原文', async () => {
    const result = await rewriteSituatedQuery({
      descriptor: DESCRIPTOR,
      fallbackQuery: '用户原始 query',
      llm: undefined,
      route: ROUTE,
    })
    expect(result).toEqual({ query: SITUATION_TEXT, lanes: [], degraded: true, degradedReason: 'no-llm' })
  })

  it('无路由（route=null / 缺省）⇒ reason=no-route，且从不调 LLM', async () => {
    const llm = scriptedLlm([{ text: '{"query":"不该被调用"}' }])
    for (const route of [null, undefined]) {
      const result = await rewriteSituatedQuery({
        descriptor: DESCRIPTOR,
        fallbackQuery: '用户原始 query',
        llm: llm.port,
        route,
      })
      expect(result.degradedReason).toBe('no-route')
      expect(result.query).toBe(SITUATION_TEXT)
    }
    expect(llm.calls).toHaveLength(0)
  })

  it('处境原文为空时用调用方的 fallbackQuery（不退回空查询）', async () => {
    const empty: SituationDescriptor = { goal: '', tools: [], files: [], errors: [], recentUserTurns: [] }
    const result = await rewriteSituatedQuery({
      descriptor: empty,
      fallbackQuery: '  用户原始 query  ',
      llm: undefined,
    })
    expect(result.query).toBe('用户原始 query')
  })
})

describe('矩阵 8：改写输出为空 / 不可解析 ⇒ 降级为原文', () => {
  it('空白 query 字段 ⇒ reason=empty-output，查询退回处境原文', async () => {
    const { result } = await rewrite([{ text: '{"query":"   "}' }])
    expect(result.query).toBe(SITUATION_TEXT)
    expect(result.degradedReason).toBe('empty-output')
    expect(result.lanes).toEqual([])
  })

  it('非 JSON / 缺字段 / 非字符串 ⇒ 一律 empty-output（不抛、不半信半疑）', async () => {
    for (const text of ['好的，我改写好了', '{"other":"x"}', '{"query":42}', '{"query":null}', '']) {
      const { result } = await rewrite([{ text }])
      expect(result.degradedReason, JSON.stringify(text)).toBe('empty-output')
      expect(result.query).toBe(SITUATION_TEXT)
    }
  })

  it('parseRewriteField：模型把 JSON 包在解释里也能取到；超长输出截断', () => {
    expect(parseRewriteField('这是我的答案：{"query":"自包含检索式"} 希望有用', 'query')).toBe('自包含检索式')
    expect(parseRewriteField('{"hypothetical":"假设文本"}', 'hypothetical')).toBe('假设文本')
    // 同一段文本取另一个字段 ⇒ 缺字段 ⇒ null。
    expect(parseRewriteField('{"query":"x"}', 'hypothetical')).toBeNull()
    // 换行压成单行（检索式必须单行）。
    expect(parseRewriteField('{"query":"第一行\\n第二行"}', 'query')).toBe('第一行 第二行')
    const long = parseRewriteField(JSON.stringify({ query: 'x'.repeat(2000) }), 'query')
    expect(long).not.toBeNull()
    expect(Array.from(long ?? '')).toHaveLength(600)
  })
})

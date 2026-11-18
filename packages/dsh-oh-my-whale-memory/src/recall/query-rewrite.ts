/**
 * 处境感知的查询改写（Story 9.3 / T2、AC:2005-2009、I/O 矩阵 5–8）。
 *
 * 两条路，**先改写再 HyDE**（可叠加）：
 * 1. 上下文改写：从处境原文与最近用户回合做指代消解，产出「自包含检索式」；
 * 2. HyDE：让 LLM 生成「如果记忆库里有相关条目，它大概会怎么写」的假设文本，
 *    用它的 embedding 去检索（而不是用处境原文的 embedding）。
 *
 * 纪律：
 * - **纯查询侧**：不写库、不改任何表（零 schema 变更，AC:2008）；
 * - LLM 只走调用方注入的 `ctx.llm` 端口（AD-5 单通道；本模块不 import 宿主值，
 *   运行期只 `import type` 消费 chunk 联合）；
 * - prompt 与输出 schema 同文件（§14）；结构化输出带 sentinel preamble；
 * - **降级不抛错**（矩阵 5–8）：无 LLM / 无路由 / 调用失败 / 空输出 ⇒ 该步降级，
 *   任一步失败后续步骤不再尝试，最终查询退回处境原文并标 `degraded: true`（NFR12）。
 */
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { foldStream } from '../shared/stream-fold.js'
import { situationQueryText, type SituationDescriptor } from './situation.js'

/** 结构化输出 sentinel preamble（§14，与其它 prompt 同一句）。 */
export const REWRITE_SENTINEL_PREAMBLE = 'Field descriptions are never valid values; set them to null'

/** 单步改写的输出 token 预算（检索式/假设文本都是短文）。 */
export const REWRITE_MAX_OUTPUT_TOKENS = 400

/** 单步改写的硬超时（召回总预算 ≤3s 软目标，两步各留一半）。 */
export const REWRITE_TIMEOUT_MS = 1_200

/** 送进 prompt 的处境原文最大字符数（超长截断，不把整段对话当查询）。 */
export const REWRITE_INPUT_MAX_CHARS = 1_200

/** 改写输出的最大字符数（超出按降级处理：改写不该比原文长一个数量级）。 */
export const REWRITE_OUTPUT_MAX_CHARS = 600

/** 上下文改写的输出 schema（与下方 prompt 同文件，§14）。 */
export const CONTEXT_REWRITE_OUTPUT_SCHEMA = JSON.stringify({
  query: 'string — 自包含的检索式：把「它/那个/上面那个」等指代换成具体对象；无可用信息给空串',
})

/** 上下文改写指令（指代消解为自包含检索式）。 */
export const CONTEXT_REWRITE_INSTRUCTION = [
  REWRITE_SENTINEL_PREAMBLE,
  '',
  '你是检索查询改写器。输入是当前工作处境的摘要（目标、涉及工具与文件、失败状态、最近用户回合）。',
  '任务：把处境改写成一条**自包含**的检索式，用来在长期记忆库里找相关记忆。',
  '要求：',
  '- 消解指代：把「它 / 那个 / 上面那个 / 刚才的」替换成摘要里的具体对象；',
  '- 补上检索有用的标识：文件名、工具名、错误形态、领域词；',
  '- 不要编造摘要里没有的事实；不要写成问句；长度 ≤ 60 字；',
  '- 只输出 JSON，形如 {"query": string}；无可改写内容时给空串。',
  '',
  '输出 JSON schema：',
  CONTEXT_REWRITE_OUTPUT_SCHEMA,
].join('\n')

/** HyDE 的输出 schema（与下方 prompt 同文件，§14）。 */
export const HYDE_OUTPUT_SCHEMA = JSON.stringify({
  hypothetical: 'string — 「记忆库里大概会怎么记这条相关经验」的假设文本；无相关记忆时给空串',
})

/** HyDE 指令（生成假设记忆文本）。 */
export const HYDE_INSTRUCTION = [
  REWRITE_SENTINEL_PREAMBLE,
  '',
  '你是记忆假设生成器。输入是当前工作处境与一条改写后的检索式。',
  '任务：假设长期记忆库里**确实**有一条与这个处境相关的记忆，写出它大概会怎么写。',
  '要求：',
  '- 用记忆条目的口吻写（陈述句、原子事实：偏好/决策/约束/结论/踩过的坑），不是回答问题；',
  '- 只写与处境相关的经验，2–4 句；不要编造具体数字、端点或未出现的标识；',
  '- 只输出 JSON，形如 {"hypothetical": string}；确实写不出时给空串。',
  '',
  '输出 JSON schema：',
  HYDE_OUTPUT_SCHEMA,
].join('\n')

/** 只用到 `ctx.llm.stream` 的结构端口（单测注入假实现，运行期不 import 宿主值）。 */
export interface RewriteLlmPort {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: RequestMessage[]
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

/** 显式路由（Config 的 llmProvider/llmModel；AD-5）。 */
export interface RewriteRoute {
  readonly provider: string
  readonly model: string
}

/** 降级原因（封闭词表，直接进 status / 日志）。 */
export type RewriteDegradeReason = 'no-llm' | 'no-route' | 'llm-error' | 'empty-output'

/** 实际生效的检索 lane。 */
export type RewriteLane = 'context-rewrite' | 'hyde'

export interface QueryRewriteResult {
  /** 最终检索文本（降级时 = 处境原文）。 */
  readonly query: string
  /** 实际生效的路径（降级那一步不出现）。 */
  readonly lanes: readonly RewriteLane[]
  /** true = 至少一步降级（NFR12：降级必须可感知）。 */
  readonly degraded: boolean
  /** 降级原因（degraded 时必有）。 */
  readonly degradedReason?: RewriteDegradeReason
}

export interface QueryRewriteInput {
  readonly descriptor: SituationDescriptor
  /** 用户原始 query（处境原文为空时的兜底检索串）。 */
  readonly fallbackQuery: string
  /** 惰性 LLM 端口；`undefined` = 本实例无 LLM ⇒ 直接降级（矩阵 7）。 */
  readonly llm?: RewriteLlmPort | undefined
  /** 显式路由；缺失 ⇒ 降级（不猜 provider/model，AD-5）。 */
  readonly route?: RewriteRoute | null
  /** 宿主取消信号（F-09 同款）。 */
  readonly signal?: AbortSignal
  /** 单步超时（缺省 {@link REWRITE_TIMEOUT_MS}；测试注入）。 */
  readonly timeoutMs?: number
}

/** 组装上下文改写的消息（prompt 与 schema 同源）。 */
export function buildContextRewriteMessages(descriptor: SituationDescriptor): RequestMessage[] {
  const situation = situationQueryText(descriptor)
  const instruction = [
    CONTEXT_REWRITE_INSTRUCTION,
    '',
    '处境摘要：',
    truncate(situation, REWRITE_INPUT_MAX_CHARS),
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 组装 HyDE 的消息（prompt 与 schema 同源）。 */
export function buildHydeMessages(descriptor: SituationDescriptor, rewrittenQuery: string): RequestMessage[] {
  const instruction = [
    HYDE_INSTRUCTION,
    '',
    '处境摘要：',
    truncate(situationQueryText(descriptor), REWRITE_INPUT_MAX_CHARS),
    '',
    '改写后的检索式：',
    truncate(rewrittenQuery, REWRITE_INPUT_MAX_CHARS),
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 按 code point 截断（不切断代理对）。 */
function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

/**
 * 从模型输出里取一个字符串字段：非 JSON / 缺字段 / 非字符串 / 空白 ⇒ `null`。
 * 只取首尾大括号之间的内容（模型常把 JSON 包在解释里）。
 */
export function parseRewriteField(text: string, field: 'query' | 'hypothetical'): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const value = (parsed as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  if (trimmed === '') return null
  return truncate(trimmed, REWRITE_OUTPUT_MAX_CHARS)
}

type StepOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: RewriteDegradeReason }

/** 一次 LLM 步：任何异常/空输出都收敛成降级（不抛）。 */
async function runStep(
  input: QueryRewriteInput,
  messages: RequestMessage[],
  field: 'query' | 'hypothetical',
): Promise<StepOutcome> {
  if (input.llm === undefined) return { ok: false, reason: 'no-llm' }
  if (input.route === undefined || input.route === null) return { ok: false, reason: 'no-route' }
  const timeout = AbortSignal.timeout(input.timeoutMs ?? REWRITE_TIMEOUT_MS)
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout])
  try {
    const folded = await foldStream(input.llm.stream({
      provider: input.route.provider,
      model: input.route.model,
      messages,
      maxTokens: REWRITE_MAX_OUTPUT_TOKENS,
      signal,
    }))
    const parsed = parseRewriteField(folded.text, field)
    return parsed === null ? { ok: false, reason: 'empty-output' } : { ok: true, text: parsed }
  } catch {
    // 超时 / 5xx / 畸形响应一律降级（矩阵 5）：改写是增益路径，不能把召回拖挂。
    return { ok: false, reason: 'llm-error' }
  }
}

/**
 * 一次处境感知查询改写（矩阵 5–8）。
 *
 * 顺序固定：上下文改写 →（成功才）HyDE；任一步降级即停并退回处境原文，
 * 已成功的前置步骤**不丢弃**（只有当前步退场），最终查询取已生效的最长链路。
 */
export async function rewriteSituatedQuery(input: QueryRewriteInput): Promise<QueryRewriteResult> {
  const fallback = situationQueryText(input.descriptor).trim() || input.fallbackQuery.trim()

  const rewritten = await runStep(input, buildContextRewriteMessages(input.descriptor), 'query')
  if (!rewritten.ok) {
    return { query: fallback, lanes: [], degraded: true, degradedReason: rewritten.reason }
  }

  const hyde = await runStep(input, buildHydeMessages(input.descriptor, rewritten.text), 'hypothetical')
  if (!hyde.ok) {
    return { query: rewritten.text, lanes: ['context-rewrite'], degraded: true, degradedReason: hyde.reason }
  }
  // 两路叠加：检索式在前（精确标识），假设文本在后（语义扩展）。
  return { query: rewritten.text + '\n' + hyde.text, lanes: ['context-rewrite', 'hyde'], degraded: false }
}

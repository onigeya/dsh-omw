/**
 * LLM 单通道精炼（Story 2.3 / FR-19 / AD-5）。
 *
 * prompt 与输出 schema **同文件**（AC:573 硬要求）：改 prompt 必须同步改 schema。
 * 所有 LLM 调用走宿主 `ctx.llm` 单通道，显式 provider+model，插件不自带 key；
 * 路由解析失败直接降级（N5）、一次调用只有一次 provider 尝试（N1/N3/R2）。
 * 结构化输出统一加 sentinel preamble（§14 / AC:573）。
 */
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { normalizeFingerprintText } from '../db/id.js'
import { DEFAULT_MEMORY_KIND, DEFAULT_MEMORY_PRIORITY } from '../db/memory.js'
import { MEMORY_KINDS } from '../shared/memory-vocab.js'
import { estimateTokens, splitToBudget as splitTextToBudget } from '../shared/text-budget.js'
import { foldStream, type FoldedStream } from './stream-fold.js'

/** sentinel preamble（§14 / AC:573）：字段说明永远不是合法值。 */
export const REFINE_SENTINEL_PREAMBLE = 'Field descriptions are never valid values; set them to null'

/** prompt 版本；改 prompt 或 schema 必须同时递增，并同步本文的 REFINE_OUTPUT_SCHEMA。 */
export const REFINE_PROMPT_VERSION = '2'

/**
 * 七类标识符的枚举串（单一来源 = src/shared/memory-vocab.ts 的 MEMORY_KINDS）。
 * 评审 T2：模型拿不到标识符清单 ⇒ kind 恒判非法 ⇒ 全部收敛为空、七类分类实际失效。
 */
const KIND_ENUM = MEMORY_KINDS.join(' / ')

/** 单条原子卡片 token 上限（AC:572）。 */
export const MAX_REFINE_FACT_TOKENS = 150

/** 单次精炼请求的输出预算上限（不是任务预算；任务预算由调用方 AbortSignal 收紧）。 */
export const REFINE_MAX_OUTPUT_TOKENS = 2048

/** priority 值域（memory_remember 工具描述：-1..100，-1 = 全局强规则）。 */
export const MEMORY_PRIORITY_MIN = -1
export const MEMORY_PRIORITY_MAX = 100

/** 输出 schema（与 prompt 同文件；AC:573）。字段说明文字本身不是合法值，判定不了就填 null。 */
export const REFINE_OUTPUT_SCHEMA = [
  '{',
  '  "facts": [',
  '    {',
  '      "text": string,        // 原子事实原文，必填、非空',
  '      "kind": string|null,   // 七类之一：' + KIND_ENUM + '；判定不了填 null',
  '      "priority": number|null // -1..100 的整数，判定不了填 null',
  '    }',
  '  ]',
  '}',
].join('\n')

/** 精炼指令：每张卡片一条事实，只收跨会话仍成立的长期事实；宁少勿滥。 */
export const REFINE_INSTRUCTION = [
  '把下面的对话原文精炼成原子 Zettelkasten 卡片。',
  '每条卡片写一条独立成立的事实；同一主题的不同事实拆成多条。',
  '只保留跨会话仍成立的长期事实：用户偏好与习惯、已确定的决策及其理由、硬约束与禁令、稳定的标识（路径/端点/版本号/ID）、可复用的结论。',
  '丢弃：当前任务进度、一次性中间结果、临时变量、闲聊寒暄，以及原文里没有的事实——不要推测、不要补全。',
  '每条卡片不超过 150 token。原文里没有值得长期记住的内容时返回空数组。',
  'kind 只能取这七类之一（逐字，别改写）：' + KIND_ENUM + '；判定不了就填 null，不要猜。',
  'priority 取 -1..100 的整数（-1 = 全局强规则），判定不了就填 null。',
  '严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
].join('\n')

/** 组装一次精炼请求的消息（prompt 与 schema 同源）。 */
export function buildRefineMessages(transcript: string): RequestMessage[] {
  const instruction = [
    REFINE_SENTINEL_PREAMBLE,
    '',
    REFINE_INSTRUCTION,
    '',
    '输出 JSON schema：',
    REFINE_OUTPUT_SCHEMA,
    '',
    '对话原文：',
    transcript,
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 只用到 ctx.llm 的一个方法：结构端口，单测可注入假实现（运行期不 import 宿主值）。 */
export interface LlmPort {
  stream(options: {
    provider: string
    model: string
    messages: RequestMessage[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

/** 解析出的路由：显式 provider + model（AC:567 单通道）。 */
export interface RefineRoute {
  readonly provider: string
  readonly model: string
}

/** 一次精炼产出的原子卡片。 */
export interface RefinedFact {
  readonly text: string
  readonly kind: string
  readonly priority: number
  /** LLM 给的 kind/priority 缺失或非法、已收敛为缺省常量（N10：必须记审计）。 */
  readonly coerced: boolean
}

/** 精炼失败：reason 是自由字符串（N5 要求 no-provider-route 逐字），retryable 决定退避还是死信。 */
export interface RefineFailure {
  readonly reason: string
  readonly message: string
  /** true = 瞬时失败（退避重试）；false = 语义错/超预算，按 AC:581 直接降级进 failed。 */
  readonly retryable: boolean
}

export type RefineResult =
  | { readonly ok: true; readonly facts: readonly RefinedFact[] }
  | { readonly ok: false; readonly failure: RefineFailure }

/** 精炼输入。signal 是调用方给的任务预算 AbortSignal（R2：单次尝试 ≤30s）。 */
export interface RefineInput {
  readonly llm: LlmPort
  readonly route: RefineRoute
  readonly transcript: string
  readonly signal: AbortSignal
  readonly maxTokens?: number
}

/**
 * 极简 token 估算：实现在 src/shared/text-budget.ts（精炼与召回共用同一套规则）。
 * 这里 re-export 保持既有 import 路径与调用点不变。
 */
export { estimateTokens }

/**
 * 精炼侧切分：缺省预算 = 单条原子卡片上限 {@link MAX_REFINE_FACT_TOKENS}；
 * 实现在 src/shared/text-budget.ts（budget 必填，缺省值属于各调用方的业务常量）。
 */
export function splitToBudget(text: string, budget: number = MAX_REFINE_FACT_TOKENS): string[] {
  return splitTextToBudget(text, budget)
}

/**
 * 解析模型输出为原子卡片；无法解析、结构不符、或**非空数组但元素全部无用**返回 null
 * （调用方归为可重试失败，评审 T25）。
 *
 * 归一化后为空的文本（纯标点 / 纯空白，评审 T4）在此丢弃：留着它会在写库事务里由
 * `memoryNodeId` 抛 `empty_fingerprint_text`，把整条 INBOX 的**全部**合格 fact 一起回滚。
 * 检查落在**每个片段**上而不只是整条：`'甲'.repeat(150) + '。...'` 会被切成
 * `['甲'x150, '。...']`，tail 整条非空但归一化后为空（评审 P4 追加项）。
 */
export function parseRefineOutput(text: string): readonly RefinedFact[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const facts = (parsed as { readonly facts?: unknown } | null)?.facts
  if (!Array.isArray(facts)) return null
  // 空数组是合法的「原文无可记内容」，保持成功（T25）。
  if (facts.length === 0) return []
  const out: RefinedFact[] = []
  const kinds: readonly string[] = MEMORY_KINDS
  for (const raw of facts) {
    const entry = raw as { readonly text?: unknown; readonly kind?: unknown; readonly priority?: unknown } | null
    const factText = typeof entry?.text === 'string' ? entry.text.trim() : ''
    if (factText.length === 0) continue
    const kindOk = typeof entry?.kind === 'string' && kinds.includes(entry.kind)
    const rawPriority = typeof entry?.priority === 'number' && Number.isFinite(entry.priority) ? Math.trunc(entry.priority) : Number.NaN
    const priorityOk = Number.isFinite(rawPriority) && rawPriority >= MEMORY_PRIORITY_MIN && rawPriority <= MEMORY_PRIORITY_MAX
    const coerced = !kindOk || !priorityOk
    for (const piece of splitToBudget(factText)) {
      // 逐片段校验：整条可用不代表每个片段都可用（见上方 parseRefineOutput 的注释）。
      if (isUnusableFactText(piece)) continue
      out.push({
        text: piece,
        kind: kindOk ? (entry?.kind as string) : DEFAULT_MEMORY_KIND,
        priority: priorityOk ? rawPriority : DEFAULT_MEMORY_PRIORITY,
        coerced,
      })
    }
  }
  // 非空数组但一条都没留下：整个响应无法使用 ⇒ 按可重试的解析失败处理（T25）。
  if (out.length === 0) return null
  return out
}

/**
 * 归一化后为空的文本（纯标点 / 纯空白）不是可写入的原子事实：
 * `memoryNodeId` 对它抛 `empty_fingerprint_text`，故在解析层就丢掉（评审 T4）。
 *
 * `normalizeFingerprintText` 对「归一化后为空」**抛错**、永不返回空串（db/id.ts:29-40），
 * 所以判据就是「是否抛错」，没有长度比较分支。
 */
function isUnusableFactText(text: string): boolean {
  try {
    normalizeFingerprintText(text)
    return false
  } catch {
    return true
  }
}

/** HTTP 状态是否瞬时（AC:575-577）：429 / 5xx / 无状态码算可重试，其余 4xx 是语义错。 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true
  if (status === 429) return true
  return status >= 500
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 把「流以外」抛出的异常映射为失败分类（评审 T8）。
 *
 * 宿主的 LlmFailure 形状（`{ message, code, status, ... }`）既可能直接抛出，也可能挂在
 * `LlmError.failure` 上。尽力取出 status/code 并复用 {@link isRetryableStatus}——否则确定性
 * 4xx（鉴权失败 / 模型不存在）会被当成瞬时错重试 4 次才进死信，违反 §14「4xx 直接降级」。
 * 提不出状态码才按可重试兜底（未知错误宁可多试）。
 */
function classifyThrown(error: unknown, signal: AbortSignal): RefineFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) return { reason: 'llm-timeout', message, retryable: true }
  const shaped = error as {
    readonly status?: unknown
    readonly code?: unknown
    readonly failure?: { readonly status?: unknown; readonly code?: unknown }
  } | null | undefined
  const status = numberOrUndefined(shaped?.status) ?? numberOrUndefined(shaped?.failure?.status)
  const code = stringOrUndefined(shaped?.code) ?? stringOrUndefined(shaped?.failure?.code)
  return {
    reason: code ?? 'llm-threw',
    message,
    retryable: status === undefined ? true : isRetryableStatus(status),
  }
}

function classifyFinish(folded: FoldedStream, signal: AbortSignal): RefineFailure | null {
  const finish = folded.finish
  if (finish === undefined) return { reason: 'llm-no-finish', message: '流未给出终态 finish', retryable: true }
  if (finish.kind === 'error') {
    const failure = finish.failure
    return {
      reason: failure.code ?? 'llm-error',
      message: failure.message,
      retryable: isRetryableStatus(failure.status),
    }
  }
  if (finish.kind === 'aborted') {
    return signal.aborted
      ? { reason: 'llm-timeout', message: finish.failure.message, retryable: true }
      : { reason: 'llm-aborted', message: finish.failure.message, retryable: true }
  }
  if (finish.kind === 'max-tokens') {
    return { reason: 'max-tokens', message: '输出被长度截断，无法确认完整性', retryable: false }
  }
  return null
}

/**
 * 一次精炼：**单次** `ctx.llm.stream` 调用（R2：重试不在同一次尝试内），
 * 结果收敛为 ≤150 token 的原子卡片。失败分类决定调用方的记账路径。
 */
export async function refineTranscript(input: RefineInput): Promise<RefineResult> {
  let folded: FoldedStream
  try {
    folded = await foldStream(
      input.llm.stream({
        provider: input.route.provider,
        model: input.route.model,
        messages: buildRefineMessages(input.transcript),
        maxTokens: input.maxTokens ?? REFINE_MAX_OUTPUT_TOKENS,
        signal: input.signal,
      }),
    )
  } catch (error) {
    return { ok: false, failure: classifyThrown(error, input.signal) }
  }
  const finishFailure = classifyFinish(folded, input.signal)
  if (finishFailure) return { ok: false, failure: finishFailure }
  const text = folded.text.trim()
  if (text.length === 0) {
    return { ok: false, failure: { reason: 'empty-response', message: '模型返回空文本', retryable: true } }
  }
  const facts = parseRefineOutput(text)
  if (facts === null) {
    return { ok: false, failure: { reason: 'json-parse-failed', message: '模型输出不是合法 JSON schema', retryable: true } }
  }
  return { ok: true, facts }
}

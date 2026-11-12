/**
 * L1→L2 高层抽象（Story 2.5 / FR-5）：把一条（或同批若干条）L1 综合成一条 L2 经验陈述。
 *
 * prompt 与输出 schema **同文件**（沿用 2.3 AC:573 的硬要求），结构化输出加
 * sentinel preamble（§14）。单次 ctx.llm.stream 调用（认证路由见调用方）——
 * 与 2.3 的精炼共用 LlmPort 结构端口，不新增通道、不自带 key（AD-5）。
 *
 * 与 2.3 的区别：输入是**已精炼过的 L1 原子事实**（不是原始对话），输出是**一条**
 * 综合陈述（不是数组）——L2 的语义是「那次为什么失败 / 那次怎么解决」（PRD:104），
 * 故 prompt 要求保留跨事实的因果与教训，而不是罗列。
 */
import { MAX_REFINE_FACT_TOKENS, estimateTokens, type LlmPort } from './llm-refine.js'
import { foldStream } from './stream-fold.js'

/** sentinel preamble（§14）：字段说明永远不是合法值。 */
export const L2_SENTINEL_PREAMBLE = 'Field descriptions are never valid values; set them to null'

/** prompt 版本；改 prompt 或 schema 必须同时递增。 */
/**
 * 评审 P16①（T20）：从 '1' 升到 '2' —— 模型不再被问 kind / priority。
 * 提升路径恒用来源 L1 的`dominantKind`/`maxPriority` 覆盖（AC:723-726），模型输出这两个字段
 * 是**死数据**：既白耗输出预算，也让「prompt 与 schema 同源」失去意义。
 */
export const L2_PROMPT_VERSION = '2'

/** 单条 L2 陈述的 token 上限（与 L1 卡片同一上限；AC 未另给 L2 值）。 */
export const MAX_L2_STATEMENT_TOKENS = MAX_REFINE_FACT_TOKENS

/** 单次请求的输出预算（不是任务预算）。 */
export const L2_MAX_OUTPUT_TOKENS = 1024

/** 输出 schema（与 prompt 同文件）。只问 text —— 分类由调用方从来源继承（评审 P16①）。 */
export const L2_OUTPUT_SCHEMA = [
  '{',
  '  "text": string   // L2 综合陈述：跨来源事实成立的经验/教训，必填、非空',
  '}',
].join('\n')

/** L2 综合指令：从多条 L1 里提炼「为什么 / 怎么解决」，不罗列、不添加原文没有的事实。 */
export const L2_INSTRUCTION = [
  '把下面若干条 L1 原子事实综合成一条 L2 经验陈述。',
  'L2 回答的是「那次为什么失败」「那次怎么解决」——写成可复用的经验或教训，而不是把 L1 罗列一遍。',
  '只使用给定 L1 里已经成立的事实，不要推测、不要补全、不要引入外部知识。',
  '必须能顺着这些 L1 回溯到原始上下文；无法回溯的内容不要写。',
  '陈述不超过 ' + String(MAX_L2_STATEMENT_TOKENS) + ' token；只输出一条。',
  '只输出 text 一个字段：分类（kind / priority）由调用方从来源事实继承，不需要你判断。',
  '严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
].join('\n')

/** 一条待综合的 L1 输入（只取综合所需字段，避免把整行记忆耦合进来）。 */
export interface L2SourceFact {
  readonly id: string
  readonly text: string
  readonly kind: string
}

/** 组装一次 L2 综合请求的消息（prompt 与 schema 同源）。 */
export function buildL2Messages(
  facts: readonly L2SourceFact[],
): { role: 'user'; content: { type: 'text'; text: string }[] }[] {
  const body = facts
    .map((fact, index) => '[' + String(index + 1) + '] (id=' + fact.id + ', kind=' + fact.kind + ') ' + fact.text)
    .join('\n')
  const instruction = [
    L2_SENTINEL_PREAMBLE,
    '',
    L2_INSTRUCTION,
    '',
    '输出 JSON schema：',
    L2_OUTPUT_SCHEMA,
    '',
    'L1 来源事实：',
    body,
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/**
 * L2 综合结果（评审 P16①）：**只有** text —— 分类恒由调用方按来源继承
 * （`dominantKind` / `maxPriority`），模型给出的一律不采信，故不再索要。
 */
export interface L2Statement {
  readonly text: string
}

export interface L2RefineFailure {
  readonly reason: string
  readonly message: string
  readonly retryable: boolean
}

export type L2RefineResult =
  | { readonly ok: true; readonly statement: L2Statement }
  | { readonly ok: false; readonly failure: L2RefineFailure }

/**
 * 解析 L2 输出。text 缺失、非字符串、trim 后为空、或超预算一律判失败
 * （超预算按**不可重试**处理：重试只会得到同样的超长输出）。
 */
export function parseL2Output(raw: string): L2RefineResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { ok: false, failure: { reason: 'json-parse-failed', message: 'L2 输出不是合法 JSON', retryable: true } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, failure: { reason: 'json-parse-failed', message: 'L2 输出不是合法 JSON', retryable: true } }
  }
  const record = parsed as { readonly text?: unknown } | null
  const text = typeof record?.text === 'string' ? record.text.trim() : ''
  if (text.length === 0) {
    return { ok: false, failure: { reason: 'empty-statement', message: 'L2 输出缺少非空 text', retryable: true } }
  }
  if (estimateTokens(text) > MAX_L2_STATEMENT_TOKENS) {
    return {
      ok: false,
      failure: {
        reason: 'statement-over-budget',
        message: 'L2 陈述超过 ' + String(MAX_L2_STATEMENT_TOKENS) + ' token',
        retryable: false,
      },
    }
  }
  // 评审 P16①：kind / priority 不再从模型输出读取 —— 调用方恒用来源 L1 的 taboo/主流值覆盖。
  return { ok: true, statement: { text } }
}

export interface L2RefineInput {
  readonly llm: LlmPort
  readonly route: { readonly provider: string; readonly model: string }
  readonly facts: readonly L2SourceFact[]
  readonly signal: AbortSignal
}

/** 一次 L2 综合：**单次** ctx.llm.stream 调用（重试归任务层，与 2.3 同纪律）。 */
export async function refineToL2(input: L2RefineInput): Promise<L2RefineResult> {
  let folded: Awaited<ReturnType<typeof foldStream>>
  try {
    folded = await foldStream(
      input.llm.stream({
        provider: input.route.provider,
        model: input.route.model,
        messages: buildL2Messages(input.facts),
        maxTokens: L2_MAX_OUTPUT_TOKENS,
        signal: input.signal,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        reason: input.signal.aborted ? 'llm-timeout' : 'llm-threw',
        message,
        retryable: true,
      },
    }
  }
  const finish = folded.finish
  if (finish === undefined) {
    return { ok: false, failure: { reason: 'llm-no-finish', message: '流未给出终态 finish', retryable: true } }
  }
  if (finish.kind === 'error') {
    return { ok: false, failure: { reason: finish.failure.code ?? 'llm-error', message: finish.failure.message, retryable: true } }
  }
  if (finish.kind === 'aborted') {
    return { ok: false, failure: { reason: 'llm-aborted', message: finish.failure.message, retryable: true } }
  }
  if (finish.kind === 'max-tokens') {
    return { ok: false, failure: { reason: 'max-tokens', message: 'L2 输出被长度截断', retryable: false } }
  }
  const text = folded.text.trim()
  if (text.length === 0) {
    return { ok: false, failure: { reason: 'empty-response', message: '模型返回空文本', retryable: true } }
  }
  return parseL2Output(text)
}

// ---------------------------------------------------------------------------
// 忠实性核实（ctx.llm 降级通道，AC:674）
// ---------------------------------------------------------------------------

/** 核实 prompt 版本；与 refine 的 prompt 独立演进（改任一个都要同时改它的 schema）。 */
export const L2_VERIFY_PROMPT_VERSION = '1'

/** ctx.llm 单次检查的输出预算（判定只需几个 token，但要容得下理由）。 */
export const L2_VERIFY_MAX_OUTPUT_TOKENS = 256

/**
 * ctx.llm 降级通道的输出 schema（与 prompt 同文件）。
 *
 * 两个判定与 System One 的两个 question key 一一对应（faithful / no-conflict）：
 * 忠实性 = 陈述是否完全由来源 L1 支撑；冲突 = 是否与来源或后续不可容事实矛盾。
 */
export const L2_VERIFY_SCHEMA = [
  '{',
  '  "faithful": boolean,   // 陈述是否完全由来源 L1 支撑、没有添油加醋',
  '  "conflict": boolean,   // 陈述是否与来源 L1 或后续不可容事实冲突',
  '  "reason": string|null  // 一句话理由；没有就填 null',
  '}',
].join('\n')

/** 核实指令：只判定、不改写；判定结果只用于标注（丢弃权只属外部信号）。 */
export const L2_VERIFY_INSTRUCTION = [
  '判定下面这条 L2 综合陈述是否忠实于它的来源 L1 事实。',
  '只依据给出的来源 L1 判定，不要引入外部知识。',
  'faithful：陈述里的每条信息都能在来源 L1 中找到依据则为 true；有臆造、夸大、超出来源的因果则为 false。',
  'conflict：陈述与来源 L1 矛盾、或与来源互相矛盾则为 true；否则为 false。',
  '严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
].join('\n')

export interface L2VerifyFailure {
  readonly reason: string
  readonly message: string
  readonly retryable: boolean
}

export type L2VerifyResult =
  | {
    readonly ok: true
    /** 忠实于来源（false = 标疑，**不丢弃**）。 */
    readonly faithful: boolean
    /** 存在隐式冲突（true = 标疑，**不丢弃**）。 */
    readonly conflict: boolean
    readonly reason: string
  }
  | { readonly ok: false; readonly failure: L2VerifyFailure }

/** 组装一次核实的消息（prompt 与 schema 同源）。 */
export function buildVerifyMessages(
  statement: string,
  facts: readonly L2SourceFact[],
): { role: 'user'; content: { type: 'text'; text: string }[] }[] {
  const body = facts
    .map((fact, index) => '[' + String(index + 1) + '] (id=' + fact.id + ') ' + fact.text)
    .join('\n')
  const instruction = [
    L2_SENTINEL_PREAMBLE,
    '',
    L2_VERIFY_INSTRUCTION,
    '',
    '输出 JSON schema：',
    L2_VERIFY_SCHEMA,
    '',
    '待判定的 L2 陈述：',
    statement,
    '',
    '来源 L1 事实：',
    body,
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 解析核实输出：两个布尔都必须是**真布尔**，缺失/类型不符一律判调用失败（不猜默认值）。 */
export function parseVerifyOutput(raw: string): L2VerifyResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { ok: false, failure: { reason: 'json-parse-failed', message: '核实输出不是合法 JSON', retryable: true } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { ok: false, failure: { reason: 'json-parse-failed', message: '核实输出不是合法 JSON', retryable: true } }
  }
  const record = parsed as { readonly faithful?: unknown; readonly conflict?: unknown; readonly reason?: unknown } | null
  if (typeof record?.faithful !== 'boolean' || typeof record?.conflict !== 'boolean') {
    return {
      ok: false,
      failure: { reason: 'bad-verdict', message: '核实输出缺少 faithful / conflict 布尔字段', retryable: true },
    }
  }
  return {
    ok: true,
    faithful: record.faithful,
    conflict: record.conflict,
    reason: typeof record.reason === 'string' ? record.reason : '',
  }
}

export interface L2VerifyInput {
  readonly llm: LlmPort
  readonly route: { readonly provider: string; readonly model: string }
  readonly statement: string
  readonly facts: readonly L2SourceFact[]
  readonly signal: AbortSignal
}

/**
 * ctx.llm 单次忠实性检查（AD-15 的降级通道 / AC:674）。
 *
 * 与 refineToL2 同一纪律：**单次** ctx.llm.stream（宿主直连不带重试，llm-streaming.md:301）。
 * 调用失败返回 ok:false，由调用方 **throw** 让 INBOX 重试——调用失败 ≠ 判定失败（AD-15）。
 */
export async function verifyL2Statement(input: L2VerifyInput): Promise<L2VerifyResult> {
  let folded: Awaited<ReturnType<typeof foldStream>>
  try {
    folded = await foldStream(
      input.llm.stream({
        provider: input.route.provider,
        model: input.route.model,
        messages: buildVerifyMessages(input.statement, input.facts),
        maxTokens: L2_VERIFY_MAX_OUTPUT_TOKENS,
        signal: input.signal,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        reason: input.signal.aborted ? 'llm-timeout' : 'llm-threw',
        message,
        retryable: true,
      },
    }
  }
  const finish = folded.finish
  if (finish === undefined) {
    return { ok: false, failure: { reason: 'llm-no-finish', message: '流未给出终态 finish', retryable: true } }
  }
  if (finish.kind === 'error') {
    return { ok: false, failure: { reason: finish.failure.code ?? 'llm-error', message: finish.failure.message, retryable: true } }
  }
  if (finish.kind === 'aborted') {
    return { ok: false, failure: { reason: 'llm-aborted', message: finish.failure.message, retryable: true } }
  }
  if (finish.kind === 'max-tokens') {
    return { ok: false, failure: { reason: 'max-tokens', message: '核实输出被长度截断', retryable: false } }
  }
  const text = folded.text.trim()
  if (text.length === 0) {
    return { ok: false, failure: { reason: 'empty-response', message: '模型返回空文本', retryable: true } }
  }
  return parseVerifyOutput(text)
}

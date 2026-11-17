/**
 * 确定性净化 pass（Story 8.6 / T1、FR-30、AC:1859-1868）。
 *
 * **零 LLM、确定性、fail-open**：同样的输入永远得到同样的输出；抛错 / 结果为空 /
 * 长度异常一律返回原文（INV-3）。
 *
 * 三条规则（默认开 R1 + R3、关 R2，AC:1868）：
 * - **R1** 整行纯填充删除：整行只剩 `Let me…` / `Go.` 这类过程性填充 ⇒ 删掉该行；
 * - **R2** 句内前缀剥离：行首的 `Let me` / `I'll` 等前缀剥离，**只有剩余长度 >=
 *   `minRemainder` 且不命中例外表**才改，否则整行不动（安全阀）；
 * - **R3** 复读塌缩：连续完全相同的自然语言行塌缩为一行。
 *
 * 作用域排除（AC:1860）：**code fence 内**与**结构化载荷**（JSON / 日志 / 表格 /
 * 逐字转录行）一律原样；R3 只作用自然语言段。
 *
 * 净化**不是第四个档位**（AD-29/AD-30）：它只作用于**执行副本**，判据一律在净化前
 * 原文上算（INV-16）。本模块是纯函数，不碰库、不碰时钟、不碰宿主对象。
 */
import { estimateTokens } from './fold.js'
import { SKELETON_SOURCE_KIND } from '../shared/injection-vocab.js'

/** 三条规则的名字（账本 `ruleHits` 与测试断言共用这些字面量）。 */
export const PURIFY_RULES = ['R1', 'R2', 'R3'] as const
export type PurifyRule = (typeof PURIFY_RULES)[number]

/** 净化配置（来自 Config 的四个 `.volatile()` 字段，运行期可覆盖）。 */
export interface PurifyOptions {
  /** R1 整行纯填充删除（默认 true）。 */
  readonly r1: boolean
  /** R2 句内前缀剥离（默认 false）。 */
  readonly r2: boolean
  /** R3 复读塌缩（默认 true）。 */
  readonly r3: boolean
  /** R2 安全阀：剥离后剩余长度低于它则整行不动（默认 24，AC:1868）。 */
  readonly minRemainder: number
}

/**
 * 缺省值与 `Config` schema 的 `default(...)` 同源（AC:1868：开 R1 + R3、关 R2，
 * `minRemainder` 24）。两处若各写一份，「未注入」与「取默认值」会给出不同行为。
 */
export const DEFAULT_PURIFY_OPTIONS: PurifyOptions = {
  r1: true,
  r2: false,
  r3: true,
  minRemainder: 24,
}

/**
 * 惯用句例外表（AC:1868）：命中即**整行不动**，R1 与 R2 同时受它约束。
 * 这些短语是真实的请求/澄清句，不是过程性填充。
 */
export const PURIFY_EXCEPTIONS = ['let me know', 'let me see', 'let me explain', 'let me be clear'] as const

/**
 * R1：整行**只有**过程性填充时命中（比较口径 = 小写、首尾空白与尾部标点/省略号已去掉）。
 *
 * 刻意窄：只收「一行里除了填充没有别的内容」的形态。带实质宾语的句子（`Let me check the
 * file`）不是 R1 的对象，交给 R2 按安全阀处理。
 */
const R1_PURE_FILLER = new RegExp(
  '^(?:' +
  [
    'let me',
    'let us',
    "let's",
    'lets',
    "i'll",
    'i will',
    "i'm going to",
    'im going to',
    'go',
    'go on',
    'go ahead',
    'okay',
    'ok',
    'alright',
    'all right',
    'now',
    'so',
    'well',
    'hmm+',
    'uh+',
    'um+',
    'ah+',
    'oh',
    'anyway',
    'right',
  ].join('|') +
  ')$',
  'i',
)

/**
 * R2：行首可剥离的前缀。与 R1 同一族词，但允许后面跟正文；剥离后是否采纳由
 * `minRemainder` 与例外表决定。
 */
const R2_PREFIX = new RegExp(
  '^(?:' +
  [
    'let me',
    'let us',
    "let's",
    'lets',
    "i'll",
    'i will',
    "i'm going to",
    'im going to',
    'now,?',
    'okay,?',
    'ok',
    'alright,?',
    'so,',
    'well,',
    'first,',
    'next,',
    'then,',
  ].join('|') +
  ')\\s+',
  'i',
)

/** 纯标点/省略号行：没有任何词，属于填充。 */
const R1_PUNCTUATION_ONLY = /^[\s.!?…,;:—–\-]+$/

/** code fence 定界行（``` 或 ~~~，允许缩进与语言标注）。 */
const CODE_FENCE = /^\s*(?:```|~~~)/

/** 逐字转录行（`[user]` / `user: ...`；采集口与宿主渲染的既有形态）。 */
const TRANSCRIPT_LINE = /^\[?(?:user|assistant|system|tool|human|ai|developer)\]?\s*:/i

/** 日志行：ISO 时间戳前缀或级别前缀。 */
const LOG_LINE = /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?(?:trace|debug|info|warn|warning|error|fatal)\]?\b)/i

/** 表格行：以竖线开头或结尾（Markdown 表格/管道分隔）。 */
const TABLE_LINE = /^\s*\|/

/**
 * 结构性 JSON 行：整行就是一个对象/数组字面量（首尾括号闭合）。
 *
 * 数组那一支要再看内层：`[assistant]` / `[tool-call]` 这类**角色/标签标记**也是方括号包起来的，
 * 但它们不是结构化载荷（判成 JSON 会漏掉真正的自然语言行）。真正的 JSON 数组内层以
 * `{`、`[`、`"` 或数字开头。
 */
function isJsonLine(trimmed: string): boolean {
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (first === '{' && last === '}') return true
  if (first !== '[' || last !== ']') return false
  const inner = trimmed.slice(1, -1).trim()
  if (inner === '') return true
  return inner[0] === '{' || inner[0] === '[' || inner[0] === '"' || /^\d/.test(inner)
}

/** 结构化载荷判据（JSON / 日志 / 表格 / 逐字转录）：这些行一律不净化。 */
export function isStructuredLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true
  if (isJsonLine(trimmed)) return true
  if (TABLE_LINE.test(line)) return true
  if (LOG_LINE.test(trimmed)) return true
  if (TRANSCRIPT_LINE.test(trimmed)) return true
  return false
}

/** 命中惯用句例外表（大小写不敏感、包含匹配：`Sure, let me know.` 也算例外）。 */
export function hitsException(line: string): boolean {
  const lowered = line.toLowerCase()
  return PURIFY_EXCEPTIONS.some((phrase) => lowered.includes(phrase))
}

/** R1 判据：整行只剩过程性填充。 */
export function isPureFillerLine(line: string): boolean {
  if (line.trim() === '') return false
  if (R1_PUNCTUATION_ONLY.test(line)) return true
  // 比较前去掉尾部标点/省略号（`Let me…` / `Go.`），但不 trim 词内空格。
  const normalized = line
    .trim()
    .toLowerCase()
    .replace(/[\s.!?…,;:—–-]+$/u, '')
  return R1_PURE_FILLER.test(normalized)
}

/** 一次净化的结果。 */
export interface PurifyResult {
  /** 净化后文本（fail-open 时等于原文）。 */
  readonly text: string
  /** 命中过的规则（去重、按 R1→R3 顺序；未命中为空数组）。 */
  readonly ruleHits: readonly PurifyRule[]
  /** 少掉的字符数（`原文长度 - 结果长度`，恒 >= 0）。 */
  readonly removedChars: number
  /** 少掉的 tokens（同一估算口径的差值，恒 >= 0）。 */
  readonly removedTokens: number
  /** 文本是否真的变了。 */
  readonly changed: boolean
}

/** 不做任何改动的结果（禁用 / fail-open / 无命中都收敛到这里）。 */
function unchanged(text: string): PurifyResult {
  return { text, ruleHits: [], removedChars: 0, removedTokens: 0, changed: false }
}

/** 归一化外部传入的选项：缺字段回落到默认值，非法 `minRemainder` 不下探到负数。 */
export function normalizePurifyOptions(options: Partial<PurifyOptions> | null | undefined): PurifyOptions {
  const source = options ?? {}
  const minRemainder = typeof source.minRemainder === 'number' && Number.isFinite(source.minRemainder)
    ? Math.max(0, Math.trunc(source.minRemainder))
    : DEFAULT_PURIFY_OPTIONS.minRemainder
  return {
    r1: source.r1 ?? DEFAULT_PURIFY_OPTIONS.r1,
    r2: source.r2 ?? DEFAULT_PURIFY_OPTIONS.r2,
    r3: source.r3 ?? DEFAULT_PURIFY_OPTIONS.r3,
    minRemainder,
  }
}

/**
 * 对一个**自然语言文本块**跑净化（T1 纯函数）。
 *
 * 行级处理：code fence 内与结构化行原样；其余行按 R1 → R2 → R3 过一遍。
 * fail-open（INV-3）：抛错（含选项读取抛错）/ 结果为空 / 长度异常（变长，或删掉超过 80%）
 * ⇒ 返回原文。
 */
export function purifyText(text: string, options: Partial<PurifyOptions> | null | undefined): PurifyResult {
  if (typeof text !== 'string') return unchanged('')
  if (text === '') return unchanged(text)
  try {
    return purifyTextUnguarded(text, options)
  } catch {
    // INV-3：任何异常（规则、选项读取）都不得让调用方看见，也不得让原文被截半。
    return unchanged(text)
  }
}

/** `purifyText` 的实现体：所有异常由外层收敛成 fail-open。 */
function purifyTextUnguarded(text: string, options: Partial<PurifyOptions> | null | undefined): PurifyResult {
  const resolved = normalizePurifyOptions(options)
  if (!resolved.r1 && !resolved.r2 && !resolved.r3) return unchanged(text)

  let purified: string
  const hits = new Set<PurifyRule>()
  try {
    purified = runRules(text, resolved, hits)
  } catch {
    // INV-3：规则抛错不得让调用方看见异常，也不得让原文被截半。
    return unchanged(text)
  }

  if (!isSaneResult(text, purified)) return unchanged(text)
  const removedChars = text.length - purified.length
  if (removedChars === 0) return unchanged(text)
  const removedTokens = Math.max(0, estimateTokens(text) - estimateTokens(purified))
  return {
    text: purified,
    ruleHits: PURIFY_RULES.filter((rule) => hits.has(rule)),
    removedChars,
    removedTokens,
    changed: true,
  }
}

/**
 * 长度异常判据（INV-3 的「结果为空 / 长度异常」）：
 * - 结果比原文长（任何规则都不该让文本变长）；
 * - 原文非空但结果全空（整段被删光 = 可疑，交回原文）；
 * - 删掉超过原长的 80%（同样按可疑处理，保留原文）。
 */
function isSaneResult(original: string, purified: string): boolean {
  if (purified.length > original.length) return false
  if (purified.trim() === '' && original.trim() !== '') return false
  if (original.length - purified.length > original.length * 0.8) return false
  return true
}

/** 实际跑三条规则（异常向上抛，由 `purifyText` 收敛成 fail-open）。 */
function runRules(text: string, options: PurifyOptions, hits: Set<PurifyRule>): string {
  const lines = text.split('\n')
  const output: string[] = []
  let inFence = false
  let previousNatural: string | null = null

  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      // 定界行本身原样输出，并翻转 fence 状态（fence 内一律不净化）。
      inFence = !inFence
      output.push(line)
      previousNatural = null
      continue
    }
    const protectedLine = inFence || isStructuredLine(line)

    // R1：整行纯填充删除（例外表优先）。
    if (!protectedLine && options.r1 && !hitsException(line) && isPureFillerLine(line)) {
      hits.add('R1')
      previousNatural = null
      continue
    }

    let next = line
    if (!protectedLine && options.r2 && !hitsException(line)) {
      const stripped = stripPrefix(line, options.minRemainder)
      if (stripped !== null) {
        hits.add('R2')
        next = stripped
      }
    }

    // R3：连续复读行塌缩（只作用自然语言段；结构化/受保护行不参与）。
    const natural = protectedLine ? null : next.trim()
    if (!protectedLine && options.r3 && natural !== null && natural !== '' && previousNatural !== null && natural === previousNatural) {
      hits.add('R3')
      continue
    }
    output.push(next)
    previousNatural = natural === '' ? null : natural
  }
  return output.join('\n')
}

/**
 * R2 的实际剥离：只在命中前缀、剩余（trim 后）长度 >= `minRemainder` 时返回新行。
 * 不满足安全阀 ⇒ `null`（整行不动，AC:1868）。
 */
function stripPrefix(line: string, minRemainder: number): string | null {
  const match = R2_PREFIX.exec(line)
  if (match === null) return null
  const remainder = line.slice(match[0].length)
  if (remainder.trim().length < minRemainder) return null
  // 保留原始缩进：前缀落在首个非空白字符处时，缩进原样留在前面。
  const indent = line.slice(0, line.length - line.trimStart().length)
  const body = line.trimStart().slice(match[0].length)
  if (body.trim().length < minRemainder) return null
  return indent + body
}

/** 净化只作用于这些 role 的消息（user 原话永不净化，system 是宿主提示）。 */
function isPurifiableRole(role: string): boolean {
  return role !== 'user' && role !== 'system'
}

/** 一条消息的最小结构视图（不 import 宿主 `Message` 类型，避免类型双身份）。 */
export interface PurifyMessageLike {
  readonly role: string
  readonly content: string | readonly PurifyBlockLike[]
  /** 动态骨架等受保护注入形态：带 `source.kind` 的消息不净化（它要逐字回注）。 */
  readonly source?: { readonly kind?: unknown } | null
}

/** 内容块的最小结构视图：只关心承载自然语言的两类块。 */
export interface PurifyBlockLike {
  readonly type: string
  readonly text?: string
}

/** 一次「消息级」净化的聚合结果。 */
export interface PurifyMessagesResult<T> {
  /** 净化后的消息（未改动的消息保持原引用）。 */
  readonly messages: readonly T[]
  readonly ruleHits: readonly PurifyRule[]
  readonly removedChars: number
  readonly removedTokens: number
  readonly changed: boolean
  /** 参与净化的原文字符总数（账本 `rangeStart`/`rangeEnd` 的口径：0..sourceChars）。 */
  readonly sourceChars: number
}

const EMPTY_MESSAGES_RESULT = {
  ruleHits: [],
  removedChars: 0,
  removedTokens: 0,
  changed: false,
  sourceChars: 0,
} as const

/**
 * 消息级净化（T3 / T4 共用的执行副本构造器）。
 *
 * 逐条处理：`user` / `system` / 骨架消息原样；其余消息的字符串内容与 `text`/`reasoning`
 * 块各跑一次 {@link purifyText}，其余块（tool-call / tool-result / image …）保持原样。
 * **返回新对象**：调用方拿到的是内存副本，不得写回 surface（INV-1）。
 */
export function purifyMessages<T extends PurifyMessageLike>(
  messages: readonly T[],
  options: Partial<PurifyOptions> | null | undefined,
): PurifyMessagesResult<T> {
  const resolved = normalizePurifyOptions(options)
  const hits = new Set<PurifyRule>()
  let removedChars = 0
  let removedTokens = 0
  let changed = false
  let sourceChars = 0
  const purified: T[] = []

  for (const message of messages) {
    if (!isPurifiableRole(message.role) || isProtectedMessage(message)) {
      purified.push(message)
      continue
    }
    if (typeof message.content === 'string') {
      const result = purifyText(message.content, resolved)
      sourceChars += message.content.length
      collect(result)
      purified.push(result.changed ? ({ ...message, content: result.text } as T) : message)
      continue
    }
    const blocks = message.content
    let messageChanged = false
    const nextBlocks = blocks.map((block) => {
      if (block.type !== 'text' && block.type !== 'reasoning') return block
      const original = block.text ?? ''
      const result = purifyText(original, resolved)
      sourceChars += original.length
      collect(result)
      if (!result.changed) return block
      messageChanged = true
      return { ...block, text: result.text }
    })
    purified.push(messageChanged ? ({ ...message, content: nextBlocks } as T) : message)
  }

  if (!changed) return { ...EMPTY_MESSAGES_RESULT, messages: purified }

  return { messages: purified, ruleHits: PURIFY_RULES.filter((rule) => hits.has(rule)), removedChars, removedTokens, changed: true, sourceChars }

  function collect(result: PurifyResult): void {
    if (!result.changed) return
    changed = true
    removedChars += result.removedChars
    removedTokens += result.removedTokens
    for (const rule of result.ruleHits) hits.add(rule)
  }
}

/**
 * 受保护的消息形态：**动态骨架**必须逐字回注（净化它会破坏「压缩移除后自动补回」的
 * 语义）。只保护骨架这一种 `source.kind`：采集口的候选消息本身带
 * `source.kind ∈ {assistant.text, assistant.reasoning}`，它们恰恰是要净化的对象。
 */
function isProtectedMessage(message: PurifyMessageLike): boolean {
  return message.source?.kind === SKELETON_SOURCE_KIND
}

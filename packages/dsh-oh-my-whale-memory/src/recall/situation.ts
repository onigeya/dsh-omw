/**
 * 处境描述符（Story 9.3 / T1、AC:2001-2003、I/O 矩阵 1–4）。
 *
 * 输入是 session 尾部事件的**结构化窄视图**（不读 ctx、不读库、不看时钟、无随机），
 * 输出是封闭词表的描述符 `{goal, tools, files, errors, recentUserTurns}`：
 * - 字段集封闭（五个键，不随输入长出动态键），可直接进审计日志；
 * - `tools` / `files` / `errors` 是归一化后的标识与封闭错误档，不落原始正文；
 * - `goal` / `recentUserTurns` 是截断 + 脱敏后的单行短语（自由文本只留可检索的最短前缀）。
 *
 * 为什么不是新 schema / 新表：AC:2003 明确「纯文本近似版」，本模块只有内存值。
 *
 * 确定性（矩阵 4）：`tools` / `files` 按 code unit 升序、`errors` 按封闭档顺序排序，
 * 去重后输出与输入顺序无关；`recentUserTurns` 保留输入里的**最后 3 个不重复**回合
 * （事件顺序本身是宿主日志顺序，不做二次猜测）。
 */
import { contentText } from '../shared/message-text.js'

/** 参与描述符的宿主事件类型（adapter 产出的窄视图）。 */
export const SITUATION_USER_EVENT = 'user/message'
export const SITUATION_TOOL_CALL_EVENT = 'tool/call'
export const SITUATION_TOOL_RESULT_EVENT = 'tool/result'

/**
 * 错误的封闭档（AC:2003「封闭词表」）：只留「哪一类失败」，不落上游错误正文
 * （错误正文可能带路径、端点或凭据，且对检索没有增量价值）。
 */
export const SITUATION_ERROR_KINDS = [
  'timeout',
  'aborted',
  'http_4xx',
  'http_5xx',
  'tool_error',
  'unknown',
] as const

export type SituationErrorKind = (typeof SITUATION_ERROR_KINDS)[number]

/** 单个字段的容量上限（超限截断，保证描述符短暂可读、日志不膨胀）。 */
export const SITUATION_GOAL_MAX_CHARS = 160
export const SITUATION_TURN_MAX_CHARS = 120
export const SITUATION_MAX_TURNS = 3
export const SITUATION_MAX_TOOLS = 8
export const SITUATION_MAX_FILES = 8

/** 一条 session 尾部事件的窄视图（adapter 从宿主 message 形状拍平）。 */
export interface SituationEvent {
  readonly type: string
  /** 事件正文（仅 user/message 与 tool/result 使用；tool/result 只用来挖文件路径）。 */
  readonly text?: string
  /** 工具名（tool/call）。 */
  readonly tool?: string
  /** 工具结果是否成功（tool/result）。 */
  readonly ok?: boolean
  /** 失败档（tool/result 且失败时）。 */
  readonly errorKind?: SituationErrorKind
  /** 结构化文件提示（tool/call 的参数里已识别出的路径）。 */
  readonly files?: readonly string[]
}

/**
 * 处境描述符（封闭词表；AC:2003）。
 *
 * `goal` 为空串是合法态（矩阵 2：只有工具结果时没有用户回合）。
 */
export interface SituationDescriptor {
  /** 当前目标（最近一条用户回合的归一化前缀）。 */
  readonly goal: string
  /** 最近使用的工具名（去重、升序、≤8）。 */
  readonly tools: readonly string[]
  /** 涉及文件（归一化为 `/` 分隔、去重、升序、≤8）。 */
  readonly files: readonly string[]
  /** 失败档（封闭词表、去重、按档顺序、≤6）。 */
  readonly errors: readonly SituationErrorKind[]
  /** 最近用户回合（最多 3 条，最后一条与 goal 同源）。 */
  readonly recentUserTurns: readonly string[]
}

/** 凭据形态的脱敏规则（NFR9：描述符会进日志，原文里的凭据不得跟着走）。 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [redacted]'],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gu, '[redacted]'],
  [/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\b\s*[:=]\s*\S+/giu, '$1=[redacted]'],
]

/** 单行化 + 脱敏 + 截断（不抛错；空结果表示该字段无可用内容）。 */
export function scrubSituationText(text: string, maxChars: number): string {
  let out = String(text ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  // C0 控制字符 → 空格，连续空白归一：描述符必须是单行（日志/检索式都是单行）。
  out = out.replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(out)
  if (chars.length > maxChars) return chars.slice(0, maxChars).join('').trimEnd()
  return out
}

/** 文件路径识别：只认带分隔符的路径（裸词不做文件名猜测，避免把普通词当文件）。 */
const FILE_PATH_PATTERN = /(?:[A-Za-z]:)?(?:[\w.@-]+[\\/])+[\w.@-]+(?:\.[A-Za-z0-9]{1,12})?/gu

/** 路径正文 → 描述符形态：`\` → `/`，去 `./` 前缀。 */
function normalizeFile(raw: string): string {
  let value = raw.trim().replace(/\\/gu, '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value
}

/** 从一段文本里挖文件路径（确定性：出现顺序不影响结果，调用方会再排序）。 */
export function filesInText(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(FILE_PATH_PATTERN)) out.push(normalizeFile(match[0]))
  return out
}

/** 从工具参数（JSON 串或对象）里取结构化文件提示。 */
export function filesInToolArguments(args: unknown): string[] {
  let parsed: unknown = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return filesInText(args)
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const out: string[] = []
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']) {
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') out.push(normalizeFile(value))
  }
  const files = (parsed as Record<string, unknown>).files
  if (Array.isArray(files)) {
    for (const value of files) if (typeof value === 'string' && value.trim() !== '') out.push(normalizeFile(value))
  }
  return out
}

/** 错误正文 → 封闭错误档（只按形态归类，不保留正文）。 */
export function classifyToolError(text: string): SituationErrorKind {
  const value = text.toLowerCase()
  if (/timeout|timed out|etimedout|deadline exceeded/u.test(value)) return 'timeout'
  if (/abort|cancel/u.test(value)) return 'aborted'
  if (/\b[45]\d\d\b/u.test(value)) return /\b4\d\d\b/u.test(value) ? 'http_4xx' : 'http_5xx'
  return 'tool_error'
}

/** code unit 升序（不用 localeCompare：跨机器/区域设置必须给出同一序）。 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** 去重 + 排序 + 截断（tools / files 共用）。 */
function normalizeIdentifiers(values: Iterable<string>, limit: number): string[] {
  const set = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed !== '') set.add(trimmed)
  }
  return [...set].sort(compareCodeUnits).slice(0, limit)
}

/** 错误档去重后按封闭词表顺序输出（升序不是语义序，词表序才是稳定档位序）。 */
function normalizeErrors(values: Iterable<SituationErrorKind>): SituationErrorKind[] {
  const set = new Set<SituationErrorKind>()
  for (const value of values) if ((SITUATION_ERROR_KINDS as readonly string[]).includes(value)) set.add(value)
  return SITUATION_ERROR_KINDS.filter((kind) => set.has(kind))
}

/**
 * 构建处境描述符（矩阵 1–4）。不可构建（没有任何可用信号）⇒ `null`，
 * 调用方据此回退 v1 纯相似度召回并标降级（AC:2016-2018）。
 */
export function buildSituationDescriptor(input: {
  readonly events: readonly SituationEvent[]
}): SituationDescriptor | null {
  const userTurns: string[] = []
  const tools: string[] = []
  const files: string[] = []
  const errors: SituationErrorKind[] = []

  for (const event of input.events) {
    const type = typeof event.type === 'string' ? event.type.trim() : ''
    // 结构化文件提示对所有事件类型都吃（adapter 只在 tool/call 上给）。
    for (const file of event.files ?? []) files.push(file)
    if (type === SITUATION_USER_EVENT) {
      const turn = scrubSituationText(event.text ?? '', SITUATION_TURN_MAX_CHARS)
      if (turn !== '') userTurns.push(turn)
      continue
    }
    if (type === SITUATION_TOOL_CALL_EVENT) {
      const name = scrubSituationText(event.tool ?? '', 64)
      if (name !== '') tools.push(name)
      continue
    }
    if (type === SITUATION_TOOL_RESULT_EVENT) {
      // tool/result 的正文只用于挖文件路径与归类失败，本身不进描述符。
      const text = event.text ?? ''
      for (const file of filesInText(text)) files.push(file)
      if (event.ok === false) {
        errors.push(event.errorKind ?? classifyToolError(text))
      }
    }
  }

  const recentUserTurns = dedupeTail(userTurns, SITUATION_MAX_TURNS)
  const goal = recentUserTurns[recentUserTurns.length - 1] ?? ''
  const descriptor: SituationDescriptor = {
    goal: scrubSituationText(goal, SITUATION_GOAL_MAX_CHARS),
    tools: normalizeIdentifiers(tools, SITUATION_MAX_TOOLS),
    files: normalizeIdentifiers(files, SITUATION_MAX_FILES),
    errors: normalizeErrors(errors),
    recentUserTurns,
  }
  if (
    descriptor.goal === '' &&
    descriptor.tools.length === 0 &&
    descriptor.files.length === 0 &&
    descriptor.errors.length === 0
  ) {
    return null
  }
  return descriptor
}

/** 取尾部 N 条不重复文本（重复回合只保留最后出现的那次）。 */
function dedupeTail(values: readonly string[], limit: number): string[] {
  const out: string[] = []
  for (let index = values.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const value = values[index]!
    if (!out.includes(value)) out.push(value)
  }
  return out.reverse()
}

/**
 * 处境原文（矩阵 5–8 的降级目标）：把描述符拍成一条单行检索式。
 * 无 LLM / 改写失败时用它检索，保证「降级 = 退回处境原文」而不是退回空查询。
 */
export function situationQueryText(descriptor: SituationDescriptor): string {
  const parts: string[] = []
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed !== '' && !parts.includes(trimmed)) parts.push(trimmed)
  }
  push(descriptor.goal)
  for (const tool of descriptor.tools) push(tool)
  for (const file of descriptor.files) push(file)
  for (const error of descriptor.errors) push(error)
  for (const turn of descriptor.recentUserTurns) push(turn)
  return parts.join(' ')
}

/** 宿主 message 形状（只取 role / content / content 块；结构窄化，不 import 宿主类型）。 */
interface MessageLike {
  readonly role?: unknown
  readonly content?: unknown
}

/** 宿主 assistant 消息里的 tool-call 块（`name` + 原始 JSON `arguments`）。 */
interface ToolCallBlockLike {
  readonly type?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

/**
 * 宿主 `session.deriveMessages()` 的消息数组 → 描述符事件。
 * 纯函数（可脱离宿主单测）：只认 user / assistant(tool-call) / tool 三类信号。
 */
export function buildSituationEvents(messages: readonly unknown[]): SituationEvent[] {
  const events: SituationEvent[] = []
  for (const raw of messages) {
    const message = raw as MessageLike | null | undefined
    const role = typeof message?.role === 'string' ? message.role : ''
    if (role === 'user') {
      events.push({ type: SITUATION_USER_EVENT, text: contentText(message?.content) })
      continue
    }
    if (role === 'assistant') {
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as ToolCallBlockLike[]) {
        if (block?.type !== 'tool-call') continue
        const name = typeof block.name === 'string' ? block.name : ''
        events.push({
          type: SITUATION_TOOL_CALL_EVENT,
          tool: name,
          files: filesInToolArguments(block.arguments),
        })
      }
      continue
    }
    if (role === 'tool') {
      const text = contentText(message?.content)
      const isError = (message as { readonly isError?: unknown }).isError === true
      // 文件路径由描述符统一从正文挖（单点实现，不在这里重复一份）。
      events.push({
        type: SITUATION_TOOL_RESULT_EVENT,
        text,
        ok: !isError,
        ...(isError ? { errorKind: classifyToolError(text) } : {}),
      })
    }
  }
  return events
}

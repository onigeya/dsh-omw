/**
 * 注入预算的 tokens 口径（Story 8.5 / T1、AC:1826-1832、AD-25、INV-12）。
 *
 * 纯函数：不读库、不读时钟、不抛错。调用方把宿主 `tokenMeter.contextPressure(session)`
 * 的 `pressureTokens` / `contextWindow` 与 Config 的四个上限传进来，得到本次注入可用额度。
 *
 * 公式（AC:1827 逐字）：`budget = max(0, min(injectionTokenCap, ratio × (contextWindow − pressureTokens)))`
 * 三条边界（AC:1829-1832）：
 * 1. `contextWindow` 缺失 ⇒ 退回**绝对上限** `injectionTokenCap`，**不假设窗口大小**（矩阵 1）；
 * 2. `pressureTokens >= contextWindow` ⇒ 预算 0 + **可见 warning**（矩阵 2，不静默降为负数）；
 * 3. `ratio` 未配置 ⇒ 0.5（矩阵 4）；`ratio` 负数/非有限值 ⇒ 预算 0 + **可见 warning**（矩阵 3）。
 *
 * 另两项上限（单条 / 摘要）随结果一起返回：它们是**各自独立的绝对上限**（AC:1827 的
 * 「注入 / 单条 / 摘要三项各一个绝对上限」），由 {@link truncateToTokenCap} 统一施加。
 *
 * 「不抛错」是硬要求：本函数在注入热路径上，抛错会把「预算降级为 0」变成「注入整条失踪」。
 * 非法输入一律按保守方向折算成 0 / 缺省值，并把原因写进 `warnings` 让调用方落日志。
 */
import { estimateTokens, splitToBudget } from '../shared/text-budget.js'

/** `ratio` 未配置时的缺省值（AC:1832 / PRD §8 Q-19 的 v1 落地值）。 */
export const INJECTION_DEFAULT_RATIO = 0.5

/** 截断标记（与 `injection/budget.ts` 的 `…` 同一符号；两处都要能看出「被裁过」）。 */
export const INJECTION_ELLIPSIS = '…'

/** 矩阵 2 的可见告警（调用方据此落 warn，不静默）。 */
export const INJECTION_WARNING_PRESSURE_EXHAUSTED =
  'injection 预算按 0 计：pressureTokens 已不低于 contextWindow（窗口无剩余余额，不假设还有空间）'

/** 矩阵 3 的可见告警。 */
export const INJECTION_WARNING_RATIO_INVALID =
  'injection 预算按 0 计：injectionRatio 非法或为负（期望 ≥ 0 的有限数，缺省 0.5）'

export interface InjectionBudgetInput {
  /** 路由声明的上下文窗口（tokens）；缺失 = 该路由未声明容量（不假设）。 */
  readonly contextWindow?: number | null
  /** 当前请求压力（tokens）；缺省 0。 */
  readonly pressureTokens?: number | null
  /** 注入总预算的绝对上限（Config `injectionTokenCap`）。 */
  readonly injectionTokenCap: number
  /** 窗口占比（Config `injectionRatio`）；缺失 = {@link INJECTION_DEFAULT_RATIO}。 */
  readonly ratio?: number | null
  /** 单条正文的绝对上限（Config `injectionSingleCap`）。 */
  readonly singleCap: number
  /** 摘要正文的绝对上限（Config `injectionSummaryCap`）。 */
  readonly summaryCap: number
}

export interface InjectionTokenBudget {
  /** 本次注入可用总额度（tokens，恒 ≥ 0 的整数）。 */
  readonly budget: number
  /** 单条绝对上限（tokens，恒 ≥ 0 的整数）。 */
  readonly singleCap: number
  /** 摘要绝对上限（tokens，恒 ≥ 0 的整数）。 */
  readonly summaryCap: number
  /** 非空 = 本次预算被降级/钳位，调用方必须落 warn（AC:1832「可见告警」）。 */
  readonly warnings: readonly string[]
}

/** 非负整数（NaN / 负数 / 非有限值一律折 0；不抛错）。 */
function nonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/** 窗口是否可用：宿主未声明容量时给 undefined/0/NaN，一律当「缺失」而不是「窗口为 0」。 */
function usableWindow(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/**
 * 计算一次注入的 tokens 预算（矩阵 1–7）。**不抛错**：坏输入折成 0/缺省值 + warning。
 */
export function computeInjectionBudget(input: InjectionBudgetInput): InjectionTokenBudget {
  const warnings: string[] = []
  const cap = nonNegativeInt(input.injectionTokenCap)
  const singleCap = nonNegativeInt(input.singleCap)
  const summaryCap = nonNegativeInt(input.summaryCap)

  // 矩阵 3 / 4：未配置 = 0.5；负数或非有限值 = 预算 0 + 可见告警（不静默夹成 0.5）。
  const ratio = input.ratio === undefined || input.ratio === null ? INJECTION_DEFAULT_RATIO : input.ratio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0) {
    warnings.push(INJECTION_WARNING_RATIO_INVALID)
    return { budget: 0, singleCap, summaryCap, warnings }
  }

  // 矩阵 1：窗口缺失 ⇒ 退回绝对上限，不假设窗口大小。
  const window = usableWindow(input.contextWindow)
  if (window === undefined) {
    return { budget: cap, singleCap, summaryCap, warnings }
  }

  // 矩阵 2：压力打满/越界 ⇒ 预算 0 + 可见告警。
  const pressure = typeof input.pressureTokens === 'number' && Number.isFinite(input.pressureTokens) && input.pressureTokens > 0
    ? input.pressureTokens
    : 0
  if (pressure >= window) {
    warnings.push(INJECTION_WARNING_PRESSURE_EXHAUSTED)
    return { budget: 0, singleCap, summaryCap, warnings }
  }

  // 矩阵 5：`max(0, ·)` 钳位；矩阵 7：窗口极大时仍不超 `injectionTokenCap`。
  const budget = Math.max(0, Math.min(cap, Math.floor(ratio * (window - pressure))))
  return { budget, singleCap, summaryCap, warnings }
}

/**
 * 按 token 上限截断一段正文（矩阵 6）：未超限原样返回；超限取 ≤ `capTokens - 1` 的前缀 + `…`，
 * 使**含省略号的正文总长仍 ≤ `capTokens`**。`capTokens <= 0` ⇒ 空串（预算已耗尽）。
 *
 * 与 `splitToBudget` 同口径（CJK 每字 1 token、按句末优先切），这是全仓唯一的 token 截断实现。
 */
export function truncateToTokenCap(
  text: string,
  capTokens: number,
): { readonly text: string, readonly truncated: boolean } {
  const cap = nonNegativeInt(capTokens)
  if (cap === 0) return { text: '', truncated: text.trim().length > 0 }
  if (estimateTokens(text) <= cap) return { text, truncated: false }
  const first = splitToBudget(text, Math.max(1, cap - 1))[0]
  const body = first === undefined ? '' : first
  if (body === '') return { text: '', truncated: true }
  return { text: body + INJECTION_ELLIPSIS, truncated: true }
}

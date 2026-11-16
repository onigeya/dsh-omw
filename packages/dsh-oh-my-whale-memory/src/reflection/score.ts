/**
 * turn 兴趣分（Story 7.2 / AD-37、FR-21）。
 *
 * 模型逐字取自外部一手依据（`dsh-mnemon docs/en/guides/skills.md:122`）：
 * 「The conversation earns a review as it goes: one point a turn, more for longer requests (up to 3),
 * many tool calls (up to 2) and varied tools (up to 2)」⇒ 单 turn 上限 1+3+2+2 = **8**。
 *
 * 为什么用「长度 + 工具调用数 + 工具种类」当惊讶度代理：`research/…/d2-instrumentation-lifecycle-r2-1.md`
 * 明确这是 surprise/interestingness 的工程答复，避免每 turn 都反思；纯可观测信号，无 LLM 打分（AD-28 只调数值）。
 *
 * 纯函数：无 I/O、无时钟、无随机（同输入恒同输出），因此可以直接单测边界。
 */

/** 单 turn 兴趣分上限（AD-37，AC:1405 的「≤ 8」）。 */
export const MAX_TURN_INTEREST_SCORE = 8

/** 长请求的字符门槛：>400 / >1200 / >2400 各 +1（上限 +3）。 */
const LONG_REQUEST_BREAKS = [400, 1200, 2400] as const

/** 工具调用次数门槛：>2 各 +1、>5 再 +1（上限 +2）。 */
const TOOL_CALL_BREAKS = [2, 5] as const

/** 工具种类门槛：>1 各 +1、>3 再 +1（上限 +2）。 */
const TOOL_VARIETY_BREAKS = [1, 3] as const

export interface TurnSignals {
  /** 本 turn 里 user 输入的总字符数（`userChars`），用于「长请求」维度。 */
  readonly userChars: number
  /** 本 turn 的 tool 调用次数。 */
  readonly toolCalls: number
  /** 本 turn 用到的不同 tool 名数量。 */
  readonly distinctTools: number
}

/** 非有限/负数一律按 0 处理（不信任外部输入；不抛错，兴趣分不该让采集路径失败）。 */
function normalize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 大于门槛的档位数（严格大于：`> 400` 才 +1）。 */
function breaksAbove(value: number, breaks: readonly number[]): number {
  let count = 0
  for (const threshold of breaks) {
    if (value > threshold) count += 1
  }
  return count
}

/**
 * 计算单个 turn 的兴趣分，范围 `[1, 8]`。
 *
 * 下限是 1（基础分）：任何 turn 都算「发生了对话」，这样窗口累计分才与「有几次 turn」可比。
 */
export function scoreTurn(signals: TurnSignals): number {
  const base = 1
  const longRequest = breaksAbove(normalize(signals.userChars), LONG_REQUEST_BREAKS)
  const manyCalls = breaksAbove(normalize(signals.toolCalls), TOOL_CALL_BREAKS)
  const variedTools = breaksAbove(normalize(signals.distinctTools), TOOL_VARIETY_BREAKS)
  return Math.min(MAX_TURN_INTEREST_SCORE, base + longRequest + manyCalls + variedTools)
}

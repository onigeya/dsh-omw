/**
 * 反思触发的运行期状态（Story 7.2 / AD-37）。
 *
 * 为什么需要它：兴趣分是**窗口累计**量、熔断是**跨 turn** 状态，两者都不能只存在某一次调用的栈上。
 * 但按 AD-6 的精神，运行期状态只在内存里（不建表）：进程重启后窗口分归零、熔断归 closed ——
 * 这是「重启即冷静」的保守缺省，也避免把瞬时阈值写进 append-only 账本。
 *
 * 纯逻辑（无宿主依赖）：`recordTurn` 只接收已算好的信号与时钟，因此可直接单测；
 * `wire/events.ts` 负责把宿主 turn/end 事件折算成信号喂进来。
 */
import {
  DEFAULT_REFLECTION_THRESHOLDS,
  INITIAL_BREAKER_STATE,
  decideReflection,
  nextBreakerState,
  type BreakerState,
  type ReflectionDecision,
  type ReflectionThresholds,
} from './trigger.js'
import { scoreTurn, type TurnSignals } from './score.js'

export interface ReflectionState {
  /** 当前窗口累计兴趣分（反思发起或窗口重置后归零）。 */
  windowScore: number
  lastReflectionAt: string | null
  lastDecision: ReflectionDecision | null
  /** 最近一次 turn 的兴趣分（供 status 展示）。 */
  lastTurnScore: number | null
  breaker: BreakerState
}

export function createReflectionState(): ReflectionState {
  return {
    windowScore: 0,
    lastReflectionAt: null,
    lastDecision: null,
    lastTurnScore: null,
    breaker: INITIAL_BREAKER_STATE,
  }
}

export interface ReflectionTurnInput {
  readonly signals: TurnSignals
  /** 会话空闲时长（ms）；由宿主 turn/end 之后到本次评估之间计算。 */
  readonly idleMs: number
  readonly now: Date
  readonly thresholds?: ReflectionThresholds
}

/**
 * 记录一个 turn：累计窗口分并给出触发决策。**不发起反思**（发起由调用方按 `decision.trigger` 做）。
 *
 * 触发且执行成功时，调用方必须调 `markReflectionStarted`（清窗口 + 更新时间），
 * 失败调 `recordReflectionOutcome(state, 'failure')`（熔断计数 +1）。
 */
export function recordTurn(state: ReflectionState, input: ReflectionTurnInput): ReflectionDecision {
  const score = scoreTurn(input.signals)
  state.lastTurnScore = score
  state.windowScore += score
  const thresholds = input.thresholds ?? DEFAULT_REFLECTION_THRESHOLDS
  const sinceLastReflectionMs =
    state.lastReflectionAt === null ? null : input.now.getTime() - Date.parse(state.lastReflectionAt)
  const decision = decideReflection({
    windowScore: state.windowScore,
    idleMs: input.idleMs,
    sinceLastReflectionMs: Number.isNaN(sinceLastReflectionMs ?? 0) ? null : sinceLastReflectionMs,
    thresholds,
    breaker: state.breaker,
    now: input.now,
  })
  state.lastDecision = decision
  return decision
}

/** 反思真正发起后调用：清窗口分、记时间（窗口是「自上次反思以来的累计」）。 */
export function markReflectionStarted(state: ReflectionState, now: Date): void {
  state.windowScore = 0
  state.lastReflectionAt = now.toISOString()
}

/** 反思结束：成功复位熔断，失败累计（连续 3 次开闸）。 */
export function recordReflectionOutcome(
  state: ReflectionState,
  outcome: 'success' | 'failure',
  now: Date,
): void {
  state.breaker = nextBreakerState(state.breaker, outcome, now)
}

/** 用户手动恢复（`/memory` 面或运维动作）。 */
export function resetReflectionBreaker(state: ReflectionState, now: Date): void {
  state.breaker = nextBreakerState(state.breaker, 'manual-reset', now)
}

/** status 行渲染用的快照（不暴露可变状态）。 */
export interface ReflectionView {
  readonly windowScore: number
  readonly lastTurnScore: number | null
  readonly lastReflectionAt: string | null
  readonly lastDecision: ReflectionDecision | null
  readonly breaker: BreakerState
}

export function readReflectionView(state: ReflectionState): ReflectionView {
  return {
    windowScore: state.windowScore,
    lastTurnScore: state.lastTurnScore,
    lastReflectionAt: state.lastReflectionAt,
    lastDecision: state.lastDecision,
    breaker: state.breaker,
  }
}

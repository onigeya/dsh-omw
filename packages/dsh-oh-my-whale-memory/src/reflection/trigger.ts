/**
 * 反思触发判定与熔断（Story 7.2 / AD-37、AC:1403-1415）。
 *
 * 触发 = **三重 AND**（三项同时满足）：① 窗口兴趣分 ≥ threshold ② 会话空闲 ≥ idleWaitMs
 * ③ 距上次反思 ≥ intervalMs。熔断优先于三项判定：熔断 open 时无论三项如何都不触发。
 *
 * 纯函数：时钟由调用方传入（`now`），状态由调用方持有 —— 这样判定可单测、也可被 status 复用。
 */

// 默认值只有一份，放在 shared/（AD-33：kernel 与 domain 都不能互相 import）。
export { BREAKER_FAILURE_THRESHOLD, BREAKER_HALF_OPEN_AFTER_MS, DEFAULT_REFLECTION_THRESHOLDS }
export type { ReflectionThresholds } from '../shared/reflection-defaults.js'
import {
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_HALF_OPEN_AFTER_MS,
  DEFAULT_REFLECTION_THRESHOLDS,
} from '../shared/reflection-defaults.js'
import type { ReflectionThresholds } from '../shared/reflection-defaults.js'

export type BreakerStatus = 'closed' | 'open'

/** 熔断状态（持久化由调用方负责；本模块只算下一状态）。 */
export interface BreakerState {
  readonly status: BreakerStatus
  /** 连续失败次数（closed 时累计，成功清零）。 */
  readonly consecutiveFailures: number
  /** 最后一次失败的时刻（ISO-8601）；open 后据此计算半开窗口。 */
  readonly openedAt: string | null
  /** 半开探测是否已用过（open → 探测 1 次后要么成功复位、要么继续 open）。 */
  readonly probeUsed: boolean
}

export const INITIAL_BREAKER_STATE: BreakerState = {
  status: 'closed',
  consecutiveFailures: 0,
  openedAt: null,
  probeUsed: false,
}

export type BreakerEvent = 'success' | 'failure' | 'manual-reset'

/** 状态迁移：纯函数，时间只用来判断「半开窗口是否已到」。 */
export function nextBreakerState(
  state: BreakerState,
  event: BreakerEvent,
  now: Date,
): BreakerState {
  switch (event) {
    case 'manual-reset':
      return INITIAL_BREAKER_STATE
    case 'success':
      // 成功（含半开探测成功）一律复位：这是「误折破线即回退」的最小形态（AD-28 / INV-14）。
      return INITIAL_BREAKER_STATE
    case 'failure': {
      const failures = state.consecutiveFailures + 1
      if (state.status === 'open') {
        // open 期间的失败：保持 open，但半开探测就算失败，不再重试到下一个窗口。
        return { ...state, consecutiveFailures: failures, probeUsed: true }
      }
      if (failures >= BREAKER_FAILURE_THRESHOLD) {
        return {
          status: 'open',
          consecutiveFailures: failures,
          openedAt: now.toISOString(),
          probeUsed: false,
        }
      }
      return { ...state, consecutiveFailures: failures }
    }
  }
}

/** 熔断是否允许本次反思执行：closed 恒允许；open 只在「窗口已过且探测未用」时允许一次。 */
export function breakerAllowsRun(state: BreakerState, now: Date): boolean {
  if (state.status === 'closed') return true
  if (state.openedAt === null) return false
  if (state.probeUsed) return false
  const openedAtMs = Date.parse(state.openedAt)
  if (!Number.isFinite(openedAtMs)) return false
  return now.getTime() - openedAtMs >= BREAKER_HALF_OPEN_AFTER_MS
}

export type ReflectionTriggerReason = 'all' | 'threshold' | 'idle' | 'interval' | 'breaker'

export interface ReflectionDecisionInput {
  /** 窗口内累计兴趣分（含本 turn）。 */
  readonly windowScore: number
  /** 当前会话已空闲多久（ms）。 */
  readonly idleMs: number
  /** 距上次反思多久（ms）；从未反思过传 `null`（视为满足 ③）。 */
  readonly sinceLastReflectionMs: number | null
  readonly thresholds: ReflectionThresholds
  readonly breaker: BreakerState
  readonly now: Date
}

export interface ReflectionDecision {
  readonly trigger: boolean
  /** 未触发时给出**第一个**不满足的条件（用于 `/memory status` 的「未触发原因」）。 */
  readonly reason: ReflectionTriggerReason
}

/**
 * 三重 AND + 熔断。判定顺序：熔断 → threshold → idle → interval；
 * 这样 status 里的「未触发原因」是**最靠近阻断点**的那个，而不是随便一个。
 */
export function decideReflection(input: ReflectionDecisionInput): ReflectionDecision {
  if (!breakerAllowsRun(input.breaker, input.now)) {
    return { trigger: false, reason: 'breaker' }
  }
  if (input.windowScore < input.thresholds.threshold) {
    return { trigger: false, reason: 'threshold' }
  }
  if (input.idleMs < input.thresholds.idleWaitMs) {
    return { trigger: false, reason: 'idle' }
  }
  if (input.sinceLastReflectionMs !== null && input.sinceLastReflectionMs < input.thresholds.intervalMs) {
    return { trigger: false, reason: 'interval' }
  }
  return { trigger: true, reason: 'all' }
}

/**
 * 反思触发与熔断的单元测试（Story 7.2 第 1 轮 / AD-37）。
 *
 * 纯函数，0 开库。覆盖 spec 矩阵行 1-12：
 * 兴趣分边界（1..8、上限夹紧、非法输入）+ 三重 AND 的四种未触发原因 + 熔断状态机（3 次失败开闸、
 * 30 min 半开、探测仅 1 次、成功复位、手动恢复）。
 */
import { describe, expect, it } from 'vitest'
import { MAX_TURN_INTEREST_SCORE, scoreTurn } from '../src/reflection/score'
import {
  BREAKER_HALF_OPEN_AFTER_MS,
  DEFAULT_REFLECTION_THRESHOLDS,
  INITIAL_BREAKER_STATE,
  breakerAllowsRun,
  decideReflection,
  nextBreakerState,
  type BreakerState,
} from '../src/reflection/trigger'

const T0 = new Date('2026-06-01T00:00:00.000Z')

/** 造一个 open 的熔断态（3 次失败后）。 */
function openBreaker(openedAt: Date = T0): BreakerState {
  let state = INITIAL_BREAKER_STATE
  for (let index = 0; index < 3; index += 1) {
    state = nextBreakerState(state, 'failure', openedAt)
  }
  return state
}

describe('scoreTurn：单 turn 兴趣分（AC:1403-1405）', () => {
  it('空 turn ⇒ 基础 1 分', () => {
    expect(scoreTurn({ userChars: 0, toolCalls: 0, distinctTools: 0 })).toBe(1)
  })

  it('上限 8：超长请求 + 多工具 + 多类别也只到 8', () => {
    expect(scoreTurn({ userChars: 10_000, toolCalls: 50, distinctTools: 20 })).toBe(MAX_TURN_INTEREST_SCORE)
    expect(MAX_TURN_INTEREST_SCORE).toBe(8)
  })

  it('只有工具调用、无长文本：基础 + 工具分', () => {
    // 1 + 0（文本）+ 2（>5 次）+ 2（>3 种）= 5
    expect(scoreTurn({ userChars: 10, toolCalls: 6, distinctTools: 4 })).toBe(5)
  })

  it('长请求逐档 +1（>400 / >1200 / >2400）', () => {
    expect(scoreTurn({ userChars: 400, toolCalls: 0, distinctTools: 0 })).toBe(1)
    expect(scoreTurn({ userChars: 401, toolCalls: 0, distinctTools: 0 })).toBe(2)
    expect(scoreTurn({ userChars: 1201, toolCalls: 0, distinctTools: 0 })).toBe(3)
    expect(scoreTurn({ userChars: 2401, toolCalls: 0, distinctTools: 0 })).toBe(4)
  })

  it('非法输入（负数 / NaN / Infinity）夹紧到 0，不抛错也不给负分', () => {
    expect(scoreTurn({ userChars: -5, toolCalls: Number.NaN, distinctTools: Number.POSITIVE_INFINITY })).toBe(1)
    expect(scoreTurn({ userChars: Number.NaN, toolCalls: -1, distinctTools: -1 })).toBe(1)
  })
})

describe('decideReflection：三重 AND（AC:1408-1411）', () => {
  const base = {
    windowScore: DEFAULT_REFLECTION_THRESHOLDS.threshold,
    idleMs: DEFAULT_REFLECTION_THRESHOLDS.idleWaitMs,
    sinceLastReflectionMs: DEFAULT_REFLECTION_THRESHOLDS.intervalMs,
    thresholds: DEFAULT_REFLECTION_THRESHOLDS,
    breaker: INITIAL_BREAKER_STATE,
    now: T0,
  }

  it('三项恰好等于阈值 ⇒ 触发（≥ 而非 >）', () => {
    expect(decideReflection(base)).toEqual({ trigger: true, reason: 'all' })
  })

  it('从未反思过（sinceLastReflectionMs = null）⇒ ③ 自动满足', () => {
    expect(decideReflection({ ...base, sinceLastReflectionMs: null })).toEqual({ trigger: true, reason: 'all' })
  })

  it('窗口分不足 ⇒ threshold', () => {
    expect(decideReflection({ ...base, windowScore: 5 })).toEqual({ trigger: false, reason: 'threshold' })
  })

  it('空闲不足 ⇒ idle', () => {
    expect(decideReflection({ ...base, idleMs: 89_999 })).toEqual({ trigger: false, reason: 'idle' })
  })

  it('距上次反思不足 ⇒ interval', () => {
    expect(decideReflection({ ...base, sinceLastReflectionMs: 899_999 })).toEqual({ trigger: false, reason: 'interval' })
  })

  it('熔断 open ⇒ breaker，且优先于其它三项', () => {
    expect(decideReflection({ ...base, breaker: openBreaker(T0) })).toEqual({ trigger: false, reason: 'breaker' })
  })
})

describe('熔断状态机（AC:1413-1415）', () => {
  it('连续 3 次失败 ⇒ open；成功清零并复位', () => {
    let state = INITIAL_BREAKER_STATE
    state = nextBreakerState(state, 'failure', T0)
    state = nextBreakerState(state, 'failure', T0)
    expect(state.status).toBe('closed')
    expect(state.consecutiveFailures).toBe(2)
    state = nextBreakerState(state, 'failure', T0)
    expect(state.status).toBe('open')
    expect(state.openedAt).toBe(T0.toISOString())
    expect(nextBreakerState(state, 'success', T0)).toEqual(INITIAL_BREAKER_STATE)
  })

  it('成功一次即清零连续计数（不是按窗口累计）', () => {
    let state = nextBreakerState(INITIAL_BREAKER_STATE, 'failure', T0)
    state = nextBreakerState(state, 'failure', T0)
    state = nextBreakerState(state, 'success', T0)
    expect(state).toEqual(INITIAL_BREAKER_STATE)
  })

  it('open 后 30 min 内不允许；到点允许一次探测；探测失败不再允许', () => {
    const state = openBreaker(T0)
    const justBefore = new Date(T0.getTime() + BREAKER_HALF_OPEN_AFTER_MS - 1)
    expect(breakerAllowsRun(state, justBefore)).toBe(false)
    const atWindow = new Date(T0.getTime() + BREAKER_HALF_OPEN_AFTER_MS)
    expect(breakerAllowsRun(state, atWindow)).toBe(true)
    // 探测失败 ⇒ probeUsed=true，本窗口不再允许
    const afterProbeFailure = nextBreakerState(state, 'failure', atWindow)
    expect(afterProbeFailure.status).toBe('open')
    expect(breakerAllowsRun(afterProbeFailure, atWindow)).toBe(false)
  })

  it('手动恢复 ⇒ 立即回到 closed', () => {
    expect(nextBreakerState(openBreaker(T0), 'manual-reset', T0)).toEqual(INITIAL_BREAKER_STATE)
  })
})

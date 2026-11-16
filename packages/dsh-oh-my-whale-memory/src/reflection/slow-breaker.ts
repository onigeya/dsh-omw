/**
 * 慢路径熔断（Story 7.2 / AD-6 的 Q-4 默认值、AD-37）。
 *
 * Q-4 锁定的口径（逐字）：
 * - 开闸：**10 分钟窗**失败率 **≥ 50%** 且样本 **≥ 10**，**或**连续 **5 次**失败；
 * - open → half-open **30 分钟**，半开**探测 1 次**；
 * - 同一 run 连续 **3 次**短路/熔断 ⇒ 停慢路径至下一会话；
 * - 死信保留 **7 天**。
 *
 * 为什么与反思熔断分开：反思熔断管「触发频率」（3 次连续失败），慢路径熔断管「队列健康」
 * （失败率/样本量）。两者阈值不同、恢复时钟不同，合一会让任一方的语义被另一方污染。
 *
 * 纯函数：滑动窗口用调用方传入的事件时间戳（`now`），因此可单测。
 */
export const SLOW_BREAKER_WINDOW_MS = 10 * 60 * 1000
export const SLOW_BREAKER_MIN_SAMPLES = 10
export const SLOW_BREAKER_FAILURE_RATE = 0.5
export const SLOW_BREAKER_CONSECUTIVE_FAILURES = 5
export const SLOW_BREAKER_HALF_OPEN_AFTER_MS = 30 * 60 * 1000
export const SLOW_BREAKER_MAX_CONSECUTIVE_TRIPS = 3

export type SlowBreakerStatus = 'closed' | 'open' | 'stopped'

export interface SlowSample {
  /** 事件时刻（ms epoch）。 */
  readonly at: number
  readonly ok: boolean
}

export interface SlowBreakerState {
  readonly status: SlowBreakerStatus
  /** 滑动窗口内的样本（只保留 `windowMs` 内的；调用方每次迁移前裁剪）。 */
  readonly samples: readonly SlowSample[]
  /** 连续失败次数（成功清零）。 */
  readonly consecutiveFailures: number
  readonly openedAt: number | null
  /** 半开探测是否已用（open 后只允许 1 次探测）。 */
  readonly probeUsed: boolean
  /** 同一 run 内连续短路/熔断次数（达 3 ⇒ stopped，至下一会话）。 */
  readonly consecutiveTrips: number
}

export const INITIAL_SLOW_BREAKER: SlowBreakerState = {
  status: 'closed',
  samples: [],
  consecutiveFailures: 0,
  openedAt: null,
  probeUsed: false,
  consecutiveTrips: 0,
}

/** 裁掉窗口外的样本（纯函数，不改入参）。 */
function pruneSamples(samples: readonly SlowSample[], nowMs: number): SlowSample[] {
  return samples.filter((sample) => nowMs - sample.at <= SLOW_BREAKER_WINDOW_MS)
}

/** 窗口失败率是否达到开闸条件（样本 < 10 时一律不因失败率开闸）。 */
export function failureRateTrips(samples: readonly SlowSample[]): boolean {
  if (samples.length < SLOW_BREAKER_MIN_SAMPLES) return false
  const failed = samples.filter((sample) => !sample.ok).length
  return failed / samples.length >= SLOW_BREAKER_FAILURE_RATE
}

export type SlowBreakerEvent =
  | { readonly kind: 'success', readonly at: number }
  | { readonly kind: 'failure', readonly at: number }
  | { readonly kind: 'short-circuit', readonly at: number }
  | { readonly kind: 'manual-reset' }
  | { readonly kind: 'new-session' }

/**
 * 状态迁移。`stopped` 是「本会话不再跑慢路径」的终态，只有 `new-session` / `manual-reset` 能离开。
 */
export function nextSlowBreaker(state: SlowBreakerState, event: SlowBreakerEvent): SlowBreakerState {
  if (event.kind === 'manual-reset' || event.kind === 'new-session') {
    return INITIAL_SLOW_BREAKER
  }
  if (state.status === 'stopped') {
    // 已停到下一会话：期间的事件不再改变状态（短路计数也不再涨，避免重启后立刻又 stopped）。
    return state
  }

  const at = event.at
  const samples = pruneSamples(state.samples, at)

  // 短路与成功都不受「当前是否 open」影响：短路累计 trip（3 次 ⇒ stopped），成功一律复位。
  if (event.kind === 'short-circuit') {
    const trips = state.consecutiveTrips + 1
    return {
      ...state,
      samples,
      status: trips >= SLOW_BREAKER_MAX_CONSECUTIVE_TRIPS ? 'stopped' : 'open',
      openedAt: at,
      probeUsed: false,
      consecutiveTrips: trips,
    }
  }
  if (event.kind === 'success') {
    // 成功复位熔断与连续失败计数，但**保留窗口样本**：失败率判据需要 10 分钟内的全部样本，
    // 一次成功就把窗口清空会让「50% 失败率」永远统计不到（评审 R72 第 4 条的同类陷阱）。
    return {
      status: 'closed',
      samples: [...samples, { at, ok: true }],
      consecutiveFailures: 0,
      openedAt: null,
      probeUsed: false,
      consecutiveTrips: 0,
    }
  }

  const nextSamples = [...samples, { at, ok: false }]
  if (state.status === 'open') {
    // open 期间的失败 = 半开探测失败：继续 open，本窗口不再探测。
    return {
      ...state,
      samples: nextSamples,
      probeUsed: true,
      consecutiveFailures: state.consecutiveFailures + 1,
    }
  }

  const consecutiveFailures = state.consecutiveFailures + 1
  const trips = failureRateTrips(nextSamples) || consecutiveFailures >= SLOW_BREAKER_CONSECUTIVE_FAILURES
  if (!trips) {
    return { ...state, samples: nextSamples, consecutiveFailures }
  }
  return {
    status: 'open',
    samples: nextSamples,
    consecutiveFailures,
    openedAt: at,
    probeUsed: false,
    consecutiveTrips: state.consecutiveTrips + 1,
  }
}

/** 是否允许本次慢路径运行：closed 行；open 仅在窗口过后允许**一次**探测；stopped 一律不行。 */
export function slowBreakerAllowsRun(state: SlowBreakerState, nowMs: number): boolean {
  if (state.status === 'closed') return true
  if (state.status === 'stopped') return false
  if (state.openedAt === null || state.probeUsed) return false
  return nowMs - state.openedAt >= SLOW_BREAKER_HALF_OPEN_AFTER_MS
}

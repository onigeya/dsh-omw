/**
 * 处境条件化召回的进程内指标（Story 9.3 / T7、AD-16「P50/P95/降级率可见」）。
 *
 * 只保留最近 {@link DEFAULT_MAX_SAMPLES} 次样本的环形窗口（不落盘、不跨进程）：`/memory status`
 * 读的是**本实例**的运行态，与 `reflection` / `slow_queue` 等既有行同一取向。
 *
 * `overSoftTarget`：超过 AD-16 的 3s 用户体感软目标。它不是错误（矩阵 19），只让
 * 降级可见、并计入 `slowRate`。
 */

/** 环形窗口大小（够算 P50/P95，又不随会话无限增长）。 */
export const DEFAULT_MAX_SAMPLES = 200

export interface SituatedRecallSample {
  readonly latencyMs: number
  readonly degraded: boolean
  readonly overSoftTarget: boolean
  /** 重排模式（封闭词表；`fallback-v1` = 描述符不可构建时的 v1 回退）。 */
  readonly mode: string
  readonly degradedReason?: string
}

export interface SituatedMetricsSnapshot {
  readonly samples: number
  /** 最近窗口内的 P50 延迟（ms，四舍五入；无样本 = null）。 */
  readonly p50Ms: number | null
  /** 最近窗口内的 P95 延迟（ms，四舍五入；无样本 = null）。 */
  readonly p95Ms: number | null
  /** 降级率（0..1，3 位小数；无样本 = null）。 */
  readonly degradeRate: number | null
  /** 超软目标率（0..1，3 位小数；无样本 = null）。 */
  readonly slowRate: number | null
  /** 最近一次样本的重排模式。 */
  readonly lastMode: string | null
  /** 最近一次样本的降级原因（只含封闭前缀）。 */
  readonly lastDegradedReason: string | null
}

export interface SituatedMetrics {
  record(sample: SituatedRecallSample): void
  snapshot(): SituatedMetricsSnapshot
}

/** 最近秩百分位（`p ∈ (0,1]`；空样本由调用方拦掉）。 */
function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0
  const rank = Math.ceil(p * sortedAscending.length)
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))
  return sortedAscending[index] ?? 0
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 构造一个实例级指标窗口（每个 apply 一份；不跨实例共享）。 */
export function createSituatedMetrics(maxSamples: number = DEFAULT_MAX_SAMPLES): SituatedMetrics {
  const cap = Number.isFinite(maxSamples) && maxSamples >= 1 ? Math.trunc(maxSamples) : DEFAULT_MAX_SAMPLES
  const samples: SituatedRecallSample[] = []
  let last: SituatedRecallSample | null = null

  return {
    record(sample) {
      last = sample
      samples.push(sample)
      if (samples.length > cap) samples.splice(0, samples.length - cap)
    },
    snapshot() {
      if (samples.length === 0) {
        return {
          samples: 0,
          p50Ms: null,
          p95Ms: null,
          degradeRate: null,
          slowRate: null,
          lastMode: null,
          lastDegradedReason: null,
        }
      }
      const latencies = samples.map((sample) => Math.max(0, sample.latencyMs)).sort((left, right) => left - right)
      const degraded = samples.filter((sample) => sample.degraded).length
      const slow = samples.filter((sample) => sample.overSoftTarget).length
      return {
        samples: samples.length,
        p50Ms: Math.round(percentile(latencies, 0.5)),
        p95Ms: Math.round(percentile(latencies, 0.95)),
        degradeRate: round3(degraded / samples.length),
        slowRate: round3(slow / samples.length),
        lastMode: last?.mode ?? null,
        lastDegradedReason: last?.degradedReason ?? null,
      }
    },
  }
}

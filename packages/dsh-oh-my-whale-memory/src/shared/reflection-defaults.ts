/**
 * 反思触发阈值的**唯一**默认值来源（Story 7.2 / AD-37 / INV-12）。
 *
 * 为什么单独放 `shared/`：`config.ts` 是 kernel、`reflection/trigger.ts` 是 domain，两者都要这三个数；
 * 谁 import 谁都会破坏 AD-33 的分层方向。放到比两者都低的 `shared/` 后，两边都只依赖它，
 * 且「schema default() 与运行期兜底必须同源」这条约束由**物理上只有一份常量**保证（评审 R72 第 1 条）。
 */

export interface ReflectionThresholds {
  /** 窗口兴趣分门槛（AD-37：默认 6）。 */
  readonly threshold: number
  /** 会话空闲门槛（ms，AD-37：默认 90_000）。 */
  readonly idleWaitMs: number
  /** 距上次反思的最小间隔（ms，AD-37：默认 900_000）。 */
  readonly intervalMs: number
}

export const DEFAULT_REFLECTION_THRESHOLDS: ReflectionThresholds = {
  threshold: 6,
  idleWaitMs: 90_000,
  intervalMs: 900_000,
} as const

/** 连续失败熔断阈值（AC:1413-1415：3 次）。 */
export const BREAKER_FAILURE_THRESHOLD = 3

/** 反思熔断 open → half-open 的等待（AD-37：30 min）。 */
export const BREAKER_HALF_OPEN_AFTER_MS = 30 * 60 * 1000

/**
 * 步数计数器（Story 2.1 / AC①）：按 session 隔离，连续 step/end 满 N 才采集。
 * 「期间无其他采集」由调用方在其它采集路径上 reset() 表达（FR-2）。
 */
export interface StepCounter {
  /** 记一次 step/end；返回是否已达阈值（达阈值即清零）。 */
  recordStep(sessionId: string): boolean
  /** 其它采集发生后清零。 */
  reset(sessionId: string): void
}

export function createStepCounter(options: { readonly limit: number }): StepCounter {
  const limit = Math.max(1, Math.trunc(options.limit))
  const counts = new Map<string, number>()
  return {
    recordStep(sessionId: string): boolean {
      const next = (counts.get(sessionId) ?? 0) + 1
      if (next < limit) {
        counts.set(sessionId, next)
        return false
      }
      counts.delete(sessionId)
      return true
    },
    reset(sessionId: string): void {
      counts.delete(sessionId)
    },
  }
}

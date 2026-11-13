/**
 * 召回配额（Story 3.1 / FR-12：同一回合内召回族工具合计最多 3 次）。
 *
 * 单一实现：工具面在 `execute` 最先 `consume()`；`turn/start` 重置——`turn/end` 不重置
 * （一个 turn 的配额只属于这个 turn）。命令面（`/memory recall`）是**用户手动触发**，
 * 不计入本配额。
 *
 * 纯逻辑：不读时钟、不读库、不持有 ctx；`createQuotaResetListener` 返回可直接交给
 * `ctx.on('session/event', …)` 的监听器（与 inbox/session-events.ts 同一事件面）。
 */

/** 每轮召回族工具的调用上限（`memory_recall` + `memory_related` + `memory_expand` 合计）。 */
export const RECALL_TURN_QUOTA = 3

export interface RecallQuota {
  /** 尝试消耗一次配额；返回 false = 本轮配额已用尽（调用方据此返回失败信封）。 */
  consume(): boolean
  /** 重置本轮配额（由 `turn/start` 触发）。 */
  reset(): void
  /** 本轮已消耗次数（诊断 / 测试断言用）。 */
  used(): number
}

/** 构造每轮配额；`limit` 非正/非有限时回落到 {@link RECALL_TURN_QUOTA}。 */
export function createRecallQuota(limit: number = RECALL_TURN_QUOTA): RecallQuota {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : RECALL_TURN_QUOTA
  let used = 0
  return {
    consume() {
      if (used >= max) return false
      used += 1
      return true
    },
    reset() {
      used = 0
    },
    used() {
      return used
    },
  }
}

/**
 * `session/event` 监听器：**只认** `turn/start` 重置配额（`turn/end` 等一律忽略）。
 * 事件名/形状与 inbox/session-events.ts 的可选监听同一约定（裸 ctx 下 `on` 不存在时
 * 由调用方降级为不监听）。
 */
export function createQuotaResetListener(quota: RecallQuota): (session: unknown, event: unknown) => void {
  return (_session, event) => {
    if ((event as { readonly type?: unknown } | null | undefined)?.type === 'turn/start') {
      quota.reset()
    }
  }
}

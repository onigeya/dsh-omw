/**
 * 召回配额（Story 3.1 / FR-10：同一回合内召回族工具合计最多 3 次）。
 *
 * **按会话键计数**（`Map<string, number>`，键复用 `inboxSessionKey`，idle-gate.ts:40）：
 * 多会话并存时各自的回合各算各的，谁也不吃掉别人的额度；拿不到 session 身份时归
 * `'unknown'` 桶（保守取向与 idle-gate 一致）。
 *
 * 重置点（spec D7）：`turn/start` **与** `turn/end` 双点重置——turn/start 开新一轮、
 * turn/end 收尾即释放；任一到达都不会把上一轮的计数带进下一轮。命令面（`/memory recall`）
 * 是用户手动触发，不计入本配额。
 *
 * 纯逻辑：不读时钟、不读库、不持有 ctx；`createQuotaResetListener` 返回可直接交给
 * `ctx.on('session/event', …)` 的监听器（与 inbox/session-events.ts 同一事件面）。
 */
import { inboxSessionKey } from '../inbox/idle-gate.js'

/** 每轮召回族工具的调用上限（`memory_recall` + `memory_related` + `memory_expand` 合计）。 */
export const RECALL_TURN_QUOTA = 3

export interface RecallQuota {
  /**
   * 尝试消耗 `owner` 本轮的一次配额；返回 false = 该会话本轮配额已用尽
   * （调用方据此返回 `quota_exceeded` 失败信封）。
   */
  consume(owner: string): boolean
  /** 重置 `owner` 本轮配额（`turn/start` / `turn/end` 双点触发）。 */
  reset(owner: string): void
  /** `owner` 本轮已消耗次数（诊断 / 测试断言用）。 */
  used(owner: string): number
}

/** 构造按会话键计数的每轮配额；`limit` 非正/非有限时回落到 {@link RECALL_TURN_QUOTA}。 */
export function createRecallTurnQuota(limit: number = RECALL_TURN_QUOTA): RecallQuota {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : RECALL_TURN_QUOTA
  const used = new Map<string, number>()
  return {
    consume(owner) {
      const current = used.get(owner) ?? 0
      if (current >= max) return false
      used.set(owner, current + 1)
      return true
    },
    reset(owner) {
      // 直接删桶：条目数受活跃会话数约束，不随回合累积。
      used.delete(owner)
    },
    used(owner) {
      return used.get(owner) ?? 0
    },
  }
}

/**
 * `session/event` 监听器：`turn/start` 与 `turn/end` **双点**重置该会话的配额（spec D7）。
 * 其它事件（`step/end`、`compaction/start`、未知/缺 `type`）一律忽略。
 * 裸 ctx 下 `on` 不存在时由调用方降级为不监听（与 index.ts 既有 session 监听同款）。
 */
export function createQuotaResetListener(quota: RecallQuota): (session: unknown, event: unknown) => void {
  return (session, event) => {
    const type = (event as { readonly type?: unknown } | null | undefined)?.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    quota.reset(inboxSessionKey(session))
  }
}

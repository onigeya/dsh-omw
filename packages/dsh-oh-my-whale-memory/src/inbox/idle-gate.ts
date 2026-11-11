/**
 * 空闲闸门（Story 2.2 / AD-6）：消费者只在 turn/start ~ turn/end 窗口之外取队头。
 *
 * 多会话按**活跃 turn 计数**（同一会话 turn 嵌套也不提前放开）：只要还有任一 turn 未结束，
 * 闸门就是忙的。会话键由 inboxSessionKey 归一（拿不到 id 的会话归到 'unknown'，
 * 宁可保守地挡住消费，也不在 turn 里抢数据库）。
 */
export interface IdleGate {
  /** turn/start：该会话活跃 turn +1。 */
  enterTurn(sessionId: string): void
  /** turn/end：该会话活跃 turn -1（降到 0 即移除）。 */
  exitTurn(sessionId: string): void
  /** 是否空闲（无任何活跃 turn）。 */
  isIdle(): boolean
  /** 该会话当前活跃 turn 数（测试/诊断用）。 */
  depthFor(sessionId: string): number
}

export function createIdleGate(): IdleGate {
  const active = new Map<string, number>()
  return {
    enterTurn(sessionId) {
      active.set(sessionId, (active.get(sessionId) ?? 0) + 1)
    },
    exitTurn(sessionId) {
      const depth = active.get(sessionId) ?? 0
      if (depth <= 1) active.delete(sessionId)
      else active.set(sessionId, depth - 1)
    },
    isIdle() {
      return active.size === 0
    },
    depthFor(sessionId) {
      return active.get(sessionId) ?? 0
    },
  }
}

/** 会话键：宿主 Session 的 id；拿不到时归 'unknown'（保守挡消费）。 */
export function inboxSessionKey(session: unknown): string {
  const id = (session as { readonly id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/**
 * `compaction/start` 的孤儿检测与解阻塞（Story 8.1 / AC:1541-1544、INV-6）。
 *
 * 宿主契约（AD-7）：`compaction/start` payload 是 `{ turn: number | null }`，`null` = 独立手动触发；
 * **未配对的 `compaction/start` 会阻塞新条目**，因此必须主动解阻塞：
 * 超过 `timeoutMs`（默认 60s，与 AD-6 lease 同量级、可配）仍无配对的 `compaction/end` / `compaction/summary`
 * ⇒ 回调一次（调用方记 generation log + 回收被阻塞条目 + 解除阻塞），并保持幂等（同一次 start 只回调一次）。
 *
 * 时间与定时器可注入，因此可以脱离宿主单测（不需要真等 60 秒）。
 */
export const COMPACTION_ORPHAN_TIMEOUT_MS = 60_000

export interface OrphanInfo {
  readonly sessionId: string
  readonly turn: number | null
  readonly startedAt: number
  /** 到点时的等待时长（ms），用于账本。 */
  readonly waitedMs: number
}

export interface OrphanTrackerOptions {
  readonly timeoutMs?: number
  /** 超时回调（只会对同一次 start 触发一次）。 */
  readonly onOrphan: (info: OrphanInfo) => void
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly logger?: { warn(message: string): void }
}

export interface OrphanTracker {
  /** 记一次 `compaction/start`；同会话重复 start 会替换前一次（并取消其定时器）。 */
  noteStart(sessionId: string, payload: { readonly turn?: number | null }): void
  /** 记一次配对结束（`compaction/end` 或 `compaction/summary`）；不存在则 no-op。 */
  noteEnd(sessionId: string): void
  /** 当前仍在等待配对的会话数。 */
  pendingCount(): number
  /** 是否在等待该会话的配对。 */
  isPending(sessionId: string): boolean
  /** 停掉全部定时器（teardown 用）。 */
  stop(): void
}

export function createOrphanTracker(options: OrphanTrackerOptions): OrphanTracker {
  const timeoutMs = options.timeoutMs ?? COMPACTION_ORPHAN_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const pending = new Map<string, { handle: unknown, turn: number | null, startedAt: number }>()

  const clearSession = (sessionId: string): void => {
    const entry = pending.get(sessionId)
    if (entry === undefined) return
    clearTimer(entry.handle)
    pending.delete(sessionId)
  }

  return {
    noteStart(sessionId, payload) {
      // 同会话重复 start：替换（旧定时器必须取消，否则会误报孤儿）。
      clearSession(sessionId)
      const startedAt = now()
      const turn = typeof payload.turn === 'number' ? payload.turn : null
      const handle = setTimer(() => {
        const current = pending.get(sessionId)
        if (current === undefined) return
        pending.delete(sessionId)
        try {
          options.onOrphan({ sessionId, turn: current.turn, startedAt: current.startedAt, waitedMs: now() - current.startedAt })
        } catch (error) {
          // 回调失败不影响解阻塞（已经 delete，条目不会再被阻塞）。
          options.logger?.warn('compaction 孤儿回调失败：' + String(error))
        }
      }, timeoutMs)
      pending.set(sessionId, { handle, turn, startedAt })
    },
    noteEnd(sessionId) {
      clearSession(sessionId)
    },
    pendingCount() {
      return pending.size
    },
    isPending(sessionId) {
      return pending.has(sessionId)
    },
    stop() {
      for (const sessionId of [...pending.keys()]) clearSession(sessionId)
    },
  }
}

/** 解析 `compaction/start` payload：只接受 `{turn: number|null}`，其它形状按 `turn=null` 处理并记 note。 */
export function parseCompactionStart(payload: unknown): { readonly turn: number | null, readonly note: string | null } {
  if (payload === null || typeof payload !== 'object') {
    return { turn: null, note: 'payload-not-object' }
  }
  const record = payload as { turn?: unknown }
  if (record.turn === null || record.turn === undefined) return { turn: null, note: null }
  if (typeof record.turn === 'number' && Number.isInteger(record.turn)) return { turn: record.turn, note: null }
  return { turn: null, note: 'turn-not-integer' }
}

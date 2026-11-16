/**
 * 上下文管理的事件接线（Story 8.1 / AC:1528-1544、INV-7）。
 *
 * 三个订阅点都挂在宿主唯一的事件源 `session/event` 上（与采集同源）：
 * - `compaction/summary` → `ingestCompactionSummary`（INBOX 入图 + `compaction_run` 账本）；
 * - `compaction/start` → 记一次待配对（孤儿检测起点）；
 * - `compaction/end` → 配对结束。
 *
 * **宿主契约的确定性等级（必须如实标注）**：`compaction/summary` 的存在性与 payload 字段属
 * spike-10（gate G1）的**未实测项**。本模块因此对事件名与 payload 都按「防御式」处理：
 * 认 `compaction/summary` 与 `compaction/end` 两种结束事件（任一到达都解除孤儿），payload 缺字段时
 * 走 `compaction_summary_invalid` 并只记 warn。等 spike-10 结案后再收紧到实测形态。
 *
 * **INV-7**：`readOnly` 实例不注册本接线（由调用方在 `apply` 里判断后不调用）。
 */
import type * as lbug from '@ladybugdb/core'
import { ingestCompactionSummary } from './compaction-ingest.js'
import { createOrphanTracker, parseCompactionStart } from './compaction-orphan.js'

export const COMPACTION_EVENT_SUMMARY = 'compaction/summary'
export const COMPACTION_EVENT_START = 'compaction/start'
export const COMPACTION_EVENT_END = 'compaction/end'

export interface CompactionWiringOptions {
  readonly getConnection: () => lbug.Connection | null
  readonly configSnapshot: () => unknown
  readonly orphanTimeoutMs: number
  readonly onOrphan: (info: {
    readonly sessionId: string
    readonly turn: number | null
    readonly waitedMs: number
  }) => void
  readonly logger?: { warn(message: string): void }
  readonly now?: () => Date
}

export interface CompactionWiring {
  /** 处理一个 `session/event`；`compaction/start` 返回 false（无异步工作），其它返回 Promise 以便 await。 */
  handleEvent(session: unknown, event: unknown): Promise<void>
  /** 当前等待配对的会话数（status/测试可见）。 */
  pendingCompactions(): number
  /** 停掉孤儿定时器（teardown 用）。 */
  stop(): void
}

function readType(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

function readSessionId(session: unknown, event: unknown): string {
  const fromSession = (session as { id?: unknown } | null)?.id
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession
  const fromEvent = (event as { sessionId?: unknown } | null)?.sessionId
  return typeof fromEvent === 'string' ? fromEvent : ''
}

function readPayload(event: unknown): Record<string, unknown> {
  if (event === null || typeof event !== 'object') return {}
  const payload = (event as { payload?: unknown }).payload
  if (payload !== null && typeof payload === 'object') return payload as Record<string, unknown>
  return event as Record<string, unknown>
}

export function createCompactionWiring(options: CompactionWiringOptions): CompactionWiring {
  const now = options.now ?? (() => new Date())
  const tracker = createOrphanTracker({
    timeoutMs: options.orphanTimeoutMs,
    onOrphan: (info) => options.onOrphan(info),
    logger: options.logger,
  })

  return {
    async handleEvent(session, event) {
      const type = readType(event)
      if (type === null) return
      const sessionId = readSessionId(session, event)
      if (type === COMPACTION_EVENT_START) {
        const parsed = parseCompactionStart(readPayload(event))
        if (parsed.note !== null) options.logger?.warn('compaction/start payload 异常：' + parsed.note)
        if (sessionId === '') {
          // 没有会话归属就无法做孤儿检测：记 warn 后跳过，不猜。
          options.logger?.warn('compaction/start 缺 sessionId，跳过孤儿登记')
          return
        }
        tracker.noteStart(sessionId, { turn: parsed.turn })
        return
      }
      if (type === COMPACTION_EVENT_END) {
        if (sessionId !== '') tracker.noteEnd(sessionId)
        return
      }
      if (type !== COMPACTION_EVENT_SUMMARY) return

      if (sessionId !== '') tracker.noteEnd(sessionId)
      const connection = options.getConnection()
      if (connection === null) return
      try {
        await ingestCompactionSummary(connection, {
        // 宿主（dsh-compaction-basic）的 `compaction/summary` payload **不含 sessionId**，
        // 会话归属在 append 的目标 session 上（stock: index.js:634-649 只给 compactionId/summary/
        // shadowedSeqs/shadowedRange/…）。因此这里必须显式注入，否则 buildCompactionSummaryEntry
        // 会以 `compaction_summary_invalid` 失败、整条入图静默丢失。
        payload: { ...readPayload(event), sessionId: sessionId === '' ? undefined : sessionId } as never,
          configSnapshot: options.configSnapshot(),
          startedAt: now().toISOString(),
          nowIso: now().toISOString(),
        })
      } catch (error) {
        // AC:1536-1538：监听器抛错不影响已提交的 append（post-commit fire-and-forget）。
        options.logger?.warn('compaction/summary 入图失败：' + String(error))
      }
    },
    pendingCompactions: () => tracker.pendingCount(),
    stop: () => tracker.stop(),
  }
}

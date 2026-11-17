/**
 * `session/event` 监听器装配（Story 2.1 / 2.2 / 2.5 / 8.1）。
 *
 * 回放 turn/start、turn/end、step/end、compaction/start 到同一个空闲闸门、同一份 L1 提升
 * 触发器与同一个采集器：消费者拿到的 gate 必须就是这里驱动的那个实例（V3）。
 * 映射本体在 `inbox/session-events.ts`（可单测；这里接反了宿主级测试看不出来）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CaptureRecorder } from '../capture/recorder.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import type { PromotionTracker } from '../inbox/promotion-trigger.js'
import { createSessionEventHandler, sessionEventType } from '../inbox/session-events.js'
import type { SessionEventHost } from './host.js'

export interface SessionEventsWiringOptions {
  readonly gate: IdleGate
  readonly promotion: PromotionTracker
  readonly capture: CaptureRecorder
  /** Story 8.1：压缩事件（summary 入图 / 孤儿解除）；只读实例由 index 不传。 */
  readonly compaction?: { handleEvent(session: unknown, event: unknown): Promise<void> }
  /** Story 8.1：turn/end 的归因采集；纯内存，写者实例也接（AC:1565-1569）。 */
  readonly onTurnEnd?: (session: unknown) => void
}

export function wireSessionEvents(ctx: Context, options: SessionEventsWiringOptions): void {
  // 裸 ctx（单测）没有 `on`：可选调用降级为不监听（消费者因闸门恒空闲而空转，无副作用）。
  ;(ctx as unknown as SessionEventHost).on?.(
    'session/event',
    createSessionEventHandler({
      gate: options.gate,
      promotion: options.promotion,
      capture: options.capture,
      compaction: options.compaction,
      onTurnEnd: options.onTurnEnd,
    }),
  )
}

/**
 * 只装归因采集的 `session/event` 监听器（Story 8.1 / T4）。
 *
 * 只读实例的唯一 session 监听器：它不接闸门、采集器与压缩订阅（AC:1544 / INV-7 要求只读实例
 * 禁用压缩订阅），只把 `turn/end` 交给归因 tap —— 采集只写进程内存，零写库（AC:1581）。
 */
export function wireTurnEndCapture(ctx: Context, onTurnEnd: (session: unknown) => void): void {
  ;(ctx as unknown as SessionEventHost).on?.('session/event', (session, event) => {
    if (sessionEventType(event) === 'turn/end') onTurnEnd(session)
  })
}

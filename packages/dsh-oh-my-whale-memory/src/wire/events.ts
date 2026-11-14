/**
 * `session/event` 监听器装配（Story 2.1 / 2.2 / 2.5）。
 *
 * 回放 turn/start、turn/end、step/end、compaction/start 到同一个空闲闸门、同一份 L1 提升
 * 触发器与同一个采集器——消费者拿到的 gate 必须就是这里驱动的那个实例（V3）。
 * 映射本体在 `inbox/session-events.ts`（可单测；这里接反了宿主级测试看不出来）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CaptureRecorder } from '../capture/recorder.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import type { PromotionTracker } from '../inbox/promotion-trigger.js'
import { createSessionEventHandler } from '../inbox/session-events.js'
import type { SessionEventHost } from './host.js'

export interface SessionEventsWiringOptions {
  readonly gate: IdleGate
  readonly promotion: PromotionTracker
  readonly capture: CaptureRecorder
}

export function wireSessionEvents(ctx: Context, options: SessionEventsWiringOptions): void {
  // 裸 ctx（单测）没有 `on`：可选调用降级为不监听（消费者因闸门恒空闲而空转，无副作用）。
  ;(ctx as unknown as SessionEventHost).on?.(
    'session/event',
    createSessionEventHandler({
      gate: options.gate,
      promotion: options.promotion,
      capture: options.capture,
    }),
  )
}

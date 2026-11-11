/**
 * session/event → 空闲闸门 / L1 提升累计 / 三钩子采集 的映射（Story 2.2 + 2.1 / AD-6）。
 *
 * 抽成可直接注入依赖的工厂，而不是写在 apply 里内联：宿主只有这一个事件源，2.2 的映射是
 * 进窗（turn/start）、出窗并结算同 kind 计数（turn/end）；2.1 在同一处按 event.type 再分派
 * 三个采集钩子（step/end、compaction/start、turn/end）。apply 层能断言的只有注册了哪个事件，
 * 映射写反了宿主级测试看不出来，所以把这层单独做成可测函数。
 */
import { inboxSessionKey, type IdleGate } from './idle-gate.js'
import type { PromotionTracker } from './promotion-trigger.js'

/** 采集钩子（Story 2.1）：实现见 capture/recorder.ts。 */
export interface CaptureHooks {
  recordStepEnd(session: unknown, event: unknown): void
  recordCompactionStart(session: unknown, event: unknown): void
  recordTurnEnd(session: unknown, event: unknown): void
}

export interface SessionEventHandlerDeps {
  readonly gate: IdleGate
  readonly promotion: PromotionTracker
  /** 采集器；缺省 = 不采集（2.2 既有单测与裸 ctx 的降级形态）。 */
  readonly capture?: CaptureHooks
}

/** 返回 ctx.on('session/event', …) 的监听器：闸门/提升 + 三钩子采集分派。 */
export function createSessionEventHandler(
  deps: SessionEventHandlerDeps,
): (session: unknown, event: unknown) => void {
  return (session, event) => {
    const type = (event as { readonly type?: unknown } | null | undefined)?.type
    const sessionId = inboxSessionKey(session)
    if (type === 'turn/start') {
      deps.gate.enterTurn(sessionId)
    } else if (type === 'turn/end') {
      // 先出窗再结算，最后采集：结算与闸门无关，但顺序固定便于阅读。
      // 「会话结束」的观测边界只能是 turn/end——宿主没有会话级结束事件（core/session 的
      // known-event-types 只有 turn/start 与 turn/end，seed 事件不发布；见 U22）。
      deps.gate.exitTurn(sessionId)
      deps.promotion.recordSessionEnd({ sessionId })
      deps.capture?.recordTurnEnd(session, event)
    } else if (type === 'step/end') {
      deps.capture?.recordStepEnd(session, event)
    } else if (type === 'compaction/start') {
      deps.capture?.recordCompactionStart(session, event)
    }
  }
}

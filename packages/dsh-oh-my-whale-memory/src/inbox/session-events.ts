/**
 * session/event → 空闲闸门 / L1 提升累计 的映射（Story 2.2 / AD-6）。
 *
 * 抽成可直接注入依赖的工厂，而不是写在 apply 里内联：宿主只有这一个事件源，映射就是
 * 进窗（turn/start）、出窗并结算同 kind 计数（turn/end）。apply 层能断言的只有注册了哪个
 * 事件，映射写反了宿主级测试看不出来，所以把这层单独做成可测函数。
 */
import { inboxSessionKey, type IdleGate } from './idle-gate.js'
import type { PromotionTracker } from './promotion-trigger.js'

export interface SessionEventHandlerDeps {
  readonly gate: IdleGate
  readonly promotion: PromotionTracker
}

/** 返回 ctx.on('session/event', …) 的监听器：turn/start 进窗，turn/end 出窗并结算提升计数。 */
export function createSessionEventHandler(
  deps: SessionEventHandlerDeps,
): (session: unknown, event: unknown) => void {
  return (session, event) => {
    const type = (event as { readonly type?: unknown } | null | undefined)?.type
    const sessionId = inboxSessionKey(session)
    if (type === 'turn/start') {
      deps.gate.enterTurn(sessionId)
    } else if (type === 'turn/end') {
      // 先出窗再结算：结算与闸门无关，但顺序固定便于阅读。
      // 「会话结束」的观测边界只能是 turn/end——宿主没有会话级结束事件（core/session 的
      // known-event-types 只有 turn/start 与 turn/end，seed 事件不发布；见 U22）。
      deps.gate.exitTurn(sessionId)
      deps.promotion.recordSessionEnd({ sessionId })
    }
  }
}

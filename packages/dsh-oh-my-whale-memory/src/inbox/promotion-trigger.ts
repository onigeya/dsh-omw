/**
 * L1→L2 提升触发信号（Story 2.2 / Q-3 拍板）。
 *
 * 本 story 只负责**发出信号**：阈值成立时回调一次；L2 批量提升本体是 Story 2.5。
 * 两个阈值（epic 原文）：
 * - L1 累计满 20 条（每次跨过 20 的整数倍触发一次）；
 * - 单会话结束（观测边界是 turn/end）满 5 条**同 kind**。
 */
export const L1_PROMOTION_THRESHOLD = 20
export const SESSION_END_KIND_THRESHOLD = 5

export interface PromotionTrigger {
  readonly reason: 'l1-total' | 'session-end-same-kind'
  /** L1 累计条数（reason = l1-total 时是触发点的累计值）。 */
  readonly totalL1: number
  readonly sessionId: string
  readonly kind: string
  /** reason = session-end-same-kind 时该会话该 kind 的条数。 */
  readonly sessionKindCount: number
}

export interface PromotionTriggerState {
  readonly totalL1: number
  readonly sessionId?: string
  readonly kind?: string
  readonly sessionEndKindCount?: number
  readonly l1Threshold?: number
  readonly sessionKindThreshold?: number
}

/**
 * 纯判定：L1 累计跨过阈值优先；否则看单会话结束时的同 kind 计数。
 * 调用方每次只填与本次判定相关的字段（互不相干的两条判定不互相污染）。
 */
export function evaluatePromotionTrigger(state: PromotionTriggerState): PromotionTrigger | null {
  const l1Threshold = state.l1Threshold ?? L1_PROMOTION_THRESHOLD
  const sessionKindThreshold = state.sessionKindThreshold ?? SESSION_END_KIND_THRESHOLD
  const sessionId = state.sessionId ?? ''
  const kind = state.kind ?? ''
  if (l1Threshold > 0 && state.totalL1 > 0 && state.totalL1 % l1Threshold === 0) {
    return {
      reason: 'l1-total',
      totalL1: state.totalL1,
      sessionId,
      kind,
      sessionKindCount: state.sessionEndKindCount ?? 0,
    }
  }
  const sessionKindCount = state.sessionEndKindCount ?? 0
  if (sessionKindThreshold > 0 && sessionKindCount >= sessionKindThreshold) {
    return {
      reason: 'session-end-same-kind',
      totalL1: state.totalL1,
      sessionId,
      kind,
      sessionKindCount,
    }
  }
  return null
}

export interface PromotionTracker {
  /** 每有一条 L1 精炼落库时调用（按会话 + kind 累计）。 */
  recordL1(input: { readonly sessionId: string; readonly kind: string }): void
  /** 会话结束（turn/end）时调用：检查该会话同 kind 计数并**清空**该会话计数。 */
  recordSessionEnd(input: { readonly sessionId: string; readonly kind?: string }): void
  readonly totalL1: number
  pendingFor(sessionId: string): { readonly total: number; readonly byKind: Record<string, number> }
}

export interface PromotionTrackerOptions {
  /** 触发信号：条件成立时回调（本 story 的产出面）。 */
  readonly onTrigger: (trigger: PromotionTrigger) => void
  readonly l1Threshold?: number
  readonly sessionKindThreshold?: number
}

/**
 * 有状态累计器：按会话 + kind 计数，L1 全局累计。
 * `recordSessionEnd` 只看该会话内**条数最多的 kind**（并列取先达到者）判定「同 kind 满 5 条」，
 * L1 累计分支不在此参与；判完清掉该会话的计数（否则同一批条目会在之后每次 turn/end 重复触发）。
 */
export function createPromotionTracker(options: PromotionTrackerOptions): PromotionTracker {
  const sessionKinds = new Map<string, Map<string, number>>()
  const sessionTotals = new Map<string, number>()
  let totalL1 = 0

  const emit = (trigger: PromotionTrigger | null): void => {
    if (trigger) options.onTrigger(trigger)
  }

  return {
    get totalL1() {
      return totalL1
    },
    recordL1(input) {
      totalL1 += 1
      const kinds = sessionKinds.get(input.sessionId) ?? new Map<string, number>()
      kinds.set(input.kind, (kinds.get(input.kind) ?? 0) + 1)
      sessionKinds.set(input.sessionId, kinds)
      sessionTotals.set(input.sessionId, (sessionTotals.get(input.sessionId) ?? 0) + 1)
      emit(evaluatePromotionTrigger({
        totalL1,
        sessionId: input.sessionId,
        kind: input.kind,
        l1Threshold: options.l1Threshold,
      }))
    },
    recordSessionEnd(input) {
      const kinds = sessionKinds.get(input.sessionId)
      sessionKinds.delete(input.sessionId)
      const total = sessionTotals.get(input.sessionId) ?? 0
      sessionTotals.delete(input.sessionId)
      if (!kinds || total === 0) return
      let kind = input.kind ?? ''
      let count = kinds.get(kind) ?? 0
      if (!input.kind) {
        for (const [candidate, candidateCount] of kinds) {
          if (candidateCount > count) {
            kind = candidate
            count = candidateCount
          }
        }
      }
      // 只判「同 kind」分支（totalL1 传 0 即让累计分支不参与）：L1 累计信号归 recordL1。
      // 若这里也带上 totalL1，当它正好是阈值整数倍时 l1-total 会优先命中——既对同一计数
      // 重复发信号，又吞掉本次「会话结束」信号（会话计数随即清空，信号永久丢失）。
      const sessionTrigger = evaluatePromotionTrigger({
        totalL1: 0,
        sessionId: input.sessionId,
        kind,
        sessionEndKindCount: count,
        sessionKindThreshold: options.sessionKindThreshold,
      })
      // 判定时传 0 只为屏蔽累计分支；信号里的 totalL1 仍回填真实累计值（调用方要能读到）。
      if (sessionTrigger) emit({ ...sessionTrigger, totalL1 })
    },
    pendingFor(sessionId) {
      const kinds = sessionKinds.get(sessionId)
      return {
        total: sessionTotals.get(sessionId) ?? 0,
        byKind: kinds ? Object.fromEntries(kinds) : {},
      }
    },
  }
}

/**
 * L1→L2 提升触发信号测试（Story 2.2 / AC6）：本 story 只发信号，L2 提升本体属 Story 2.5。
 * 纯判定 + 有状态 tracker，无库、无 IO。
 */
import { describe, expect, it } from 'vitest'
import {
  L1_PROMOTION_THRESHOLD,
  SESSION_END_KIND_THRESHOLD,
  createPromotionTracker,
  evaluatePromotionTrigger,
  type PromotionTrigger,
} from '../src/inbox/promotion-trigger'

describe('阈值常量（epic 原文：20 条 L1 / 单会话结束 5 条同 kind）', () => {
  it('常量就是 20 与 5', () => {
    expect(L1_PROMOTION_THRESHOLD).toBe(20)
    expect(SESSION_END_KIND_THRESHOLD).toBe(5)
  })
})

describe('evaluatePromotionTrigger：纯判定', () => {
  it('L1 累计跨过 20 的整数倍才触发', () => {
    expect(evaluatePromotionTrigger({ totalL1: 0 })).toBeNull()
    expect(evaluatePromotionTrigger({ totalL1: 19 })).toBeNull()
    expect(evaluatePromotionTrigger({ totalL1: 20 })).toMatchObject({ reason: 'l1-total', totalL1: 20 })
    expect(evaluatePromotionTrigger({ totalL1: 21 })).toBeNull()
    expect(evaluatePromotionTrigger({ totalL1: 40 })).toMatchObject({ reason: 'l1-total', totalL1: 40 })
  })

  it('单会话结束时同 kind 满 5 条才触发', () => {
    expect(evaluatePromotionTrigger({ totalL1: 3, sessionEndKindCount: 4 })).toBeNull()
    expect(evaluatePromotionTrigger({ totalL1: 3, sessionId: 's1', kind: 'episodic', sessionEndKindCount: 5 }))
      .toMatchObject({ reason: 'session-end-same-kind', sessionId: 's1', kind: 'episodic', sessionKindCount: 5 })
  })

  it('阈值可注入（测试与后续 story 复用同一判定）', () => {
    expect(evaluatePromotionTrigger({ totalL1: 2, l1Threshold: 2 })).toMatchObject({ reason: 'l1-total' })
    expect(evaluatePromotionTrigger({ totalL1: 1, sessionEndKindCount: 2, sessionKindThreshold: 2 }))
      .toMatchObject({ reason: 'session-end-same-kind' })
    expect(evaluatePromotionTrigger({ totalL1: 5, l1Threshold: 0, sessionEndKindCount: 5, sessionKindThreshold: 6 })).toBeNull()
  })
})

describe('createPromotionTracker：累计与触发信号', () => {
  it('L1 累计到 20 时回调一次（21 不再触发）', () => {
    const triggers: PromotionTrigger[] = []
    const tracker = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
    for (let i = 0; i < L1_PROMOTION_THRESHOLD - 1; i += 1) tracker.recordL1({ sessionId: 's1', kind: 'episodic' })
    expect(triggers).toHaveLength(0)
    tracker.recordL1({ sessionId: 's1', kind: 'episodic' })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ reason: 'l1-total', totalL1: 20, sessionId: 's1' })
    expect(tracker.totalL1).toBe(20)
    tracker.recordL1({ sessionId: 's1', kind: 'work_fact' })
    expect(triggers).toHaveLength(1)
  })

  it('会话结束时同 kind 满 5 条触发，判完清空该会话计数', () => {
    const triggers: PromotionTrigger[] = []
    const tracker = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
    for (let i = 0; i < 5; i += 1) tracker.recordL1({ sessionId: 's1', kind: 'persona' })
    tracker.recordSessionEnd({ sessionId: 's1' })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ reason: 'session-end-same-kind', sessionId: 's1', kind: 'persona', sessionKindCount: 5 })
    expect(tracker.pendingFor('s1')).toEqual({ total: 0, byKind: {} })
  })

  it('不足 5 条不触发；显式 kind 时只判该 kind；跨会话互不干扰', () => {
    const triggers: PromotionTrigger[] = []
    const tracker = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
    for (let i = 0; i < 4; i += 1) tracker.recordL1({ sessionId: 's1', kind: 'instruction' })
    tracker.recordL1({ sessionId: 's1', kind: 'work_fact' })
    for (let i = 0; i < 3; i += 1) tracker.recordL1({ sessionId: 's2', kind: 'instruction' })
    expect(tracker.pendingFor('s1')).toEqual({ total: 5, byKind: { instruction: 4, work_fact: 1 } })
    tracker.recordSessionEnd({ sessionId: 's1', kind: 'instruction' })
    expect(triggers).toHaveLength(0)
    tracker.recordL1({ sessionId: 's2', kind: 'instruction' })
    tracker.recordL1({ sessionId: 's2', kind: 'instruction' })
    tracker.recordSessionEnd({ sessionId: 's2' })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ sessionId: 's2', kind: 'instruction', sessionKindCount: 5 })
    expect(tracker.pendingFor('s2')).toEqual({ total: 0, byKind: {} })
  })

  it('会话结束时不重复发 L1 累计信号，也不被它掩盖同 kind 信号', () => {
    const triggers: PromotionTrigger[] = []
    const tracker = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
    for (let i = 0; i < L1_PROMOTION_THRESHOLD; i += 1) tracker.recordL1({ sessionId: 's1', kind: 'episodic' })
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ reason: 'l1-total', totalL1: L1_PROMOTION_THRESHOLD })

    // 此刻 totalL1 仍是 20 的整数倍：会话结束只该判「同 kind」分支，
    // 不能再发一次 l1-total，也不能因为 l1-total 优先而吞掉同 kind 信号。
    tracker.recordSessionEnd({ sessionId: 's1' })

    expect(triggers).toHaveLength(2)
    expect(triggers[1]).toMatchObject({
      reason: 'session-end-same-kind',
      sessionId: 's1',
      kind: 'episodic',
      sessionKindCount: L1_PROMOTION_THRESHOLD,
    })
  })
  it('没有 L1 记录的会话结束时静默返回（不触发）', () => {
    const triggers: PromotionTrigger[] = []
    const tracker = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
    tracker.recordSessionEnd({ sessionId: 'never-seen' })
    expect(triggers).toHaveLength(0)
  })
})

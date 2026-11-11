/**
 * session/event → 闸门 / 提升映射（Story 2.2 / AC5、AC6）。
 *
 * 单独测这层的原因：apply 里只断言得到注册了哪个事件，映射写反（turn/start 与 turn/end 互换）
 * 在宿主级测试里不会变红，而后果是消费者在 turn 里抢库、turn 外空转。
 */
import { describe, expect, it } from 'vitest'
import { createIdleGate, inboxSessionKey } from '../src/inbox/idle-gate'
import { createPromotionTracker, type PromotionTrigger } from '../src/inbox/promotion-trigger'
import { createSessionEventHandler } from '../src/inbox/session-events'

function makeHandler() {
  const gate = createIdleGate()
  const triggers: PromotionTrigger[] = []
  const promotion = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger) })
  return {
    gate,
    promotion,
    triggers,
    handle: createSessionEventHandler({ gate, promotion }),
  }
}

describe('createSessionEventHandler：turn/start 进窗、turn/end 出窗', () => {
  it('turn/start 让闸门变忙，turn/end 让它变闲；多会话按各自深度计数', () => {
    const { gate, handle } = makeHandler()
    expect(gate.isIdle()).toBe(true)

    handle({ id: 's1' }, { type: 'turn/start', turn: 1 })
    expect(gate.isIdle()).toBe(false)
    expect(gate.depthFor('s1')).toBe(1)

    handle({ id: 's2' }, { type: 'turn/start', turn: 1 })
    handle({ id: 's1' }, { type: 'turn/end', turn: 1, reason: 'stop' })
    expect(gate.depthFor('s1')).toBe(0)
    expect(gate.isIdle()).toBe(false) // s2 还在窗内

    handle({ id: 's2' }, { type: 'turn/end', turn: 1, reason: 'stop' })
    expect(gate.isIdle()).toBe(true)
  })

  it('同一会话 turn 嵌套时按深度累加（不提前出窗）', () => {
    const { gate, handle } = makeHandler()
    handle({ id: 's1' }, { type: 'turn/start', turn: 1 })
    handle({ id: 's1' }, { type: 'turn/start', turn: 2 })
    expect(gate.depthFor('s1')).toBe(2)

    handle({ id: 's1' }, { type: 'turn/end', turn: 2, reason: 'stop' })
    expect(gate.isIdle()).toBe(false)

    handle({ id: 's1' }, { type: 'turn/end', turn: 3, reason: 'stop' })
    expect(gate.isIdle()).toBe(true)
  })

  it('turn/end 驱动 recordSessionEnd：该会话同 kind 满 5 条即发提升信号（totalL1 仍是真实累计）', () => {
    const { triggers, handle, promotion } = makeHandler()
    for (let i = 0; i < 5; i += 1) promotion.recordL1({ sessionId: 's1', kind: 'episodic' })
    expect(triggers).toHaveLength(0) // 只累计，未到 20 的阈值

    handle({ id: 's1' }, { type: 'turn/end', turn: 1, reason: 'stop' })

    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({
      reason: 'session-end-same-kind',
      sessionId: 's1',
      kind: 'episodic',
      sessionKindCount: 5,
      totalL1: 5,
    })
  })

  it('未知事件类型 / 拿不到 id 的会话：不抛，闸门保持空闲', () => {
    const { gate, handle } = makeHandler()
    expect(() => handle({ id: 's1' }, { type: 'turn/something' })).not.toThrow()
    expect(() => handle({ id: 's1' }, undefined)).not.toThrow()
    expect(gate.isIdle()).toBe(true)

    handle({}, { type: 'turn/start', turn: 1 })
    expect(inboxSessionKey({})).toBe('unknown')
    expect(gate.depthFor('unknown')).toBe(1)
    expect(gate.isIdle()).toBe(false)
  })
})

describe('Story 2.1：三钩子采集分派', () => {
  function makeCapture() {
    const calls: string[] = []
    return {
      calls,
      capture: {
        recordStepEnd: () => { calls.push('step') },
        recordCompactionStart: () => { calls.push('compaction') },
        recordTurnEnd: () => { calls.push('turn') },
      },
    }
  }

  it('step/end 与 compaction/start 分派给采集器；turn/end 在出窗之后分派', () => {
    const gate = createIdleGate()
    const promotion = createPromotionTracker({ onTrigger: () => {} })
    const { calls, capture } = makeCapture()
    let idleAtTurnEnd = false
    const handle = createSessionEventHandler({
      gate,
      promotion,
      capture: {
        ...capture,
        recordTurnEnd: () => { idleAtTurnEnd = gate.isIdle(); calls.push('turn') },
      },
    })

    handle({ id: 's1' }, { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 2 } })
    handle({ id: 's1' }, { type: 'compaction/start', seq: 2, time: 0, data: { compactionId: 'c1', turn: null } })
    handle({ id: 's1' }, { type: 'turn/start', turn: 1 })
    expect(gate.isIdle()).toBe(false)
    handle({ id: 's1' }, { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })

    expect(calls).toEqual(['step', 'compaction', 'turn'])
    expect(idleAtTurnEnd).toBe(true)
    expect(gate.isIdle()).toBe(true)
  })

  it('无关事件不触发采集；无 capture 时不抛（2.2 降级形态）', () => {
    const gate = createIdleGate()
    const promotion = createPromotionTracker({ onTrigger: () => {} })
    const { calls, capture } = makeCapture()
    const handle = createSessionEventHandler({ gate, promotion, capture })
    handle({ id: 's1' }, { type: 'assistant/message' })
    handle({ id: 's1' }, undefined)
    expect(calls).toEqual([])

    const plain = createSessionEventHandler({ gate, promotion })
    expect(() => plain({ id: 's2' }, { type: 'step/end', seq: 4, time: 0, data: { turn: 1, step: 1 } })).not.toThrow()
    expect(() => plain({ id: 's2' }, { type: 'compaction/start', seq: 5, time: 0, data: { turn: null } })).not.toThrow()
  })
})

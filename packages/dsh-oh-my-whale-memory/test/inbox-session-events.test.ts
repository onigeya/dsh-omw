/**
 * session/event → 闸门 / 提升映射（Story 2.2 / AC5、AC6）。
 *
 * 单独测这层的原因：apply 里只断言得到注册了哪个事件，映射写反（turn/start 与 turn/end 互换）
 * 在宿主级测试里不会变红，而后果是消费者在 turn 里抢库、turn 外空转。
 */
import { describe, expect, it, vi } from 'vitest'
import { createIdleGate, inboxSessionKey } from '../src/inbox/idle-gate'
import { createPromotionTracker, type PromotionTrigger } from '../src/inbox/promotion-trigger'
import { createSessionEventHandler } from '../src/inbox/session-events'
import { wireTurnEndCapture } from '../src/wire/events'

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

  it('session/disposed：清掉悬空 turn 计数与每会话采集/提升状态（不依赖 turn/end）', () => {
    const gate = createIdleGate()
    const promotion = createPromotionTracker({ onTrigger: () => {} })
    const resets: string[] = []
    const handle = createSessionEventHandler({
      gate,
      promotion,
      capture: {
        recordStepEnd: () => {},
        recordCompactionStart: () => {},
        recordTurnEnd: () => {},
        resetSession: (id) => { resets.push(id) },
      },
    })

    handle({ id: 's1' }, { type: 'turn/start', turn: 1 })
    promotion.recordL1({ sessionId: 's1', kind: 'user_portrait' })
    expect(gate.isIdle()).toBe(false)
    expect(promotion.pendingFor('s1').total).toBe(1)

    handle({ id: 's1' }, { type: 'session/disposed' })

    // 若 dispose 前没有 turn/end，旧实现会让闸门永久忙、消费者停摆。
    expect(gate.isIdle()).toBe(true)
    expect(gate.depthFor('s1')).toBe(0)
    expect(promotion.pendingFor('s1')).toEqual({ total: 0, byKind: {} })
    expect(resets).toEqual(['s1'])
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

describe('Story 8.1：turn/end 的归因采集（矩阵行 20）', () => {
  function makeDeps() {
    const gate = createIdleGate()
    const promotion = createPromotionTracker({ onTrigger: () => {} })
    const calls: string[] = []
    const sessions: unknown[] = []
    const handle = createSessionEventHandler({
      gate,
      promotion,
      capture: {
        recordStepEnd: () => { calls.push('step') },
        recordCompactionStart: () => { calls.push('compaction') },
        recordTurnEnd: () => { calls.push('turn') },
      },
      onTurnEnd: (session) => {
        calls.push('ledger')
        sessions.push(session)
      },
    })
    return { handle, calls, sessions }
  }

  it('turn/end ⇒ onTurnEnd 恰好一次，且排在 recordTurnEnd 之后', () => {
    const { handle, calls, sessions } = makeDeps()
    const session = { id: 's-ledger' }
    handle(session, { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })

    expect(calls).toEqual(['turn', 'ledger'])
    expect(sessions).toEqual([session])
  })

  it('turn/start / step/end / compaction/* 都不调用 onTurnEnd', () => {
    const { handle, calls } = makeDeps()
    for (const event of [
      { type: 'turn/start', turn: 1 },
      { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      { type: 'compaction/start', seq: 2, time: 0, data: { turn: null } },
      { type: 'compaction/summary', seq: 3, time: 0, data: {} },
      { type: 'compaction/end', seq: 4, time: 0, data: {} },
      { type: 'session/disposed' },
      { type: 'assistant/message' },
      undefined,
    ]) {
      handle({ id: 's-ledger' }, event)
    }
    expect(calls).toEqual(['step', 'compaction'])
  })

  it('只读形态 wireTurnEndCapture：只把 turn/end 交给 tap（INV-7 的只读采集路径）', () => {
    const listeners: Array<(session: unknown, event: unknown) => void> = []
    const ctx = {
      on: (event: string, listener: (session: unknown, event: unknown) => void) => {
        if (event === 'session/event') listeners.push(listener)
        return () => {}
      },
    }
    const captured = vi.fn()
    wireTurnEndCapture(ctx as unknown as Parameters<typeof wireTurnEndCapture>[0], captured)
    expect(listeners).toHaveLength(1)

    listeners[0]!({ id: 's-ro' }, { type: 'turn/start', turn: 1 })
    listeners[0]!({ id: 's-ro' }, { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } })
    expect(captured).not.toHaveBeenCalled()

    listeners[0]!({ id: 's-ro' }, { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(captured).toHaveBeenCalledTimes(1)
    expect(captured.mock.calls[0]?.[0]).toEqual({ id: 's-ro' })
    expect(listeners[0]!({ id: 's-ro' }, undefined)).toBeUndefined()
  })
})

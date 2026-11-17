/**
 * 归因采集器（Story 8.1 第 3 轮 / AC:1565-1569、INV-5、INV-7、INV-9）。
 *
 * 覆盖 spec 矩阵第 15–19 行 + `seq → 来源` 的事件类型推导：
 * 15 `tokenMeter` 缺失 ⇒ 只 warn 一次、快照 null、不抛错；
 * 16 `measure()` 抛错 ⇒ warn、保留上一次快照；
 * 17 `tokens` / `heuristicTokens` 混合 ⇒ `tokens` 优先；
 * 18 事件里找不到的 seq ⇒ 计入 `unknown`（不摊派）；
 * 19 五类之和恒等于 `measure().totalTokens`（含溢出截断）。
 *
 * 这些用例不需要库：tap 是纯内存采集器（这本身也是 INV-7 的一半证据）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createAttributionTap, seqSourceIndex } from '../src/context/attribution-tap'
import type { AttributionSnapshot } from '../src/context/status'

const NOW = new Date('2026-06-01T00:00:00.000Z')

function makeTap(tokenMeter?: unknown) {
  const warn = vi.fn()
  const tap = createAttributionTap({
    getTokenMeter: () => tokenMeter as never,
    logger: { warn },
    now: () => NOW,
  })
  return { tap, warn }
}

/** 只读断言：五类之和 === totalTokens。 */
function assertSumEqualsTotal(snapshot: AttributionSnapshot): void {
  const { bySource, totalTokens } = snapshot.ledger
  const sum = bySource.system + bySource.user + bySource.tool + bySource.assistant + bySource.unknown
  expect(sum).toBe(totalTokens)
}

/** 一个最小 Session 替身：只有 snapshotEvents（宿主 surface 事件的来源）。 */
function sessionWith(events: readonly unknown[]): unknown {
  return { id: 's-tap', snapshotEvents: () => events }
}

describe('矩阵行 15/16：可选服务与失败注入', () => {
  it('tokenMeter 缺失 ⇒ 只 warn 一次、快照保持 null、capture 不抛', () => {
    const { tap, warn } = makeTap(undefined)
    expect(tap.snapshot()).toBeNull()

    expect(() => tap.capture(sessionWith([]))).not.toThrow()
    expect(tap.snapshot()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('tokenMeter')

    // 第二个 turn 不再刷同一条 warn（缺失是静态事实）。
    tap.capture(sessionWith([]))
    tap.capture(sessionWith([]))
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('measure() 抛错 ⇒ warn、快照保持上一次成功值（不写脏值）', () => {
    let fail = false
    const measure = vi.fn(() => {
      if (fail) throw new Error('boom')
      return { totalTokens: 10, nodes: [{ seq: 1, tokens: 10 }] }
    })
    const { tap, warn } = makeTap({ measure })

    tap.capture(sessionWith([{ seq: 1, type: 'user/message' }]))
    const first = tap.snapshot()
    expect(first).not.toBeNull()
    expect(first?.ledger.bySource.user).toBe(10)

    fail = true
    expect(() => tap.capture(sessionWith([{ seq: 1, type: 'user/message' }]))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('上下文归因采集失败')
    // 上一次的成功快照原样保留（同一份引用：没有写入新值，也没有清空）。
    expect(tap.snapshot()).toBe(first)
  })

  it('从未采集成功且 measure 抛错 ⇒ 快照仍是 null（不发明 0）', () => {
    const { tap, warn } = makeTap({ measure: () => { throw new Error('boom') } })
    tap.capture(sessionWith([]))
    expect(tap.snapshot()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('矩阵行 17/18/19：节点计量、索引缺口与恒等式', () => {
  it('tokens 优先，缺失时用 heuristicTokens；五类之和 === totalTokens', () => {
    const { tap } = makeTap({
      measure: () => ({
        totalTokens: 60,
        nodes: [
          { seq: 1, tokens: 30, heuristicTokens: 99 }, // tokens 优先
          { seq: 2, heuristicTokens: 20 }, // tokens 缺失 ⇒ heuristicTokens
          { seq: 3, tokens: 10 },
        ],
      }),
    })
    tap.capture(sessionWith([
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'tool/result' },
    ]))

    const snapshot = tap.snapshot()!
    expect(snapshot.ledger.bySource.user).toBe(30)
    expect(snapshot.ledger.bySource.assistant).toBe(20)
    expect(snapshot.ledger.bySource.tool).toBe(10)
    expect(snapshot.ledger.bySource.unknown).toBe(0)
    expect(snapshot.ledger.totalTokens).toBe(60)
    expect(snapshot.indexedSeqs).toBe(3)
    expect(snapshot.capturedAt).toBe(NOW.toISOString())
    assertSumEqualsTotal(snapshot)
  })

  it('事件里找不到的 seq ⇒ 计入 unknown，不摊派给四类', () => {
    const { tap } = makeTap({
      measure: () => ({ totalTokens: 25, nodes: [{ seq: 7, tokens: 25 }] }),
    })
    // 会话事件里只有 seq 1，节点 seq 7 找不到归属。
    tap.capture(sessionWith([{ seq: 1, type: 'user/message' }]))

    const snapshot = tap.snapshot()!
    expect(snapshot.ledger.bySource.unknown).toBe(25)
    expect(snapshot.ledger.bySource.user).toBe(0)
    expect(snapshot.ledger.unknownNodes).toBe(1)
    expect(snapshot.ledger.overflowTokens).toBe(0)
    assertSumEqualsTotal(snapshot)
  })

  it('节点和 > totalTokens（溢出）⇒ 按数组顺序计到总量为止，五类和仍恒等于 total', () => {
    const { tap } = makeTap({
      measure: () => ({
        totalTokens: 7,
        nodes: [
          { seq: 1, tokens: 3 },
          { seq: 2, tokens: 4 },
          { seq: 3, tokens: 495 },
        ],
      }),
    })
    tap.capture(sessionWith([
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'tool/result' },
      { seq: 3, type: 'assistant/message' },
    ]))

    const snapshot = tap.snapshot()!
    expect(snapshot.ledger.bySource.user).toBe(3)
    expect(snapshot.ledger.bySource.tool).toBe(4)
    expect(snapshot.ledger.bySource.assistant).toBe(0)
    expect(snapshot.ledger.overflowTokens).toBe(495)
    expect(snapshot.ledger.totalTokens).toBe(7)
    assertSumEqualsTotal(snapshot)
  })

  it('节点和 < totalTokens（缺口）⇒ 差额计入 unknown，五类和仍恒等于 total', () => {
    const { tap } = makeTap({
      measure: () => ({ totalTokens: 100, nodes: [{ seq: 1, tokens: 40 }] }),
    })
    tap.capture(sessionWith([{ seq: 1, type: 'user/message' }]))

    const snapshot = tap.snapshot()!
    expect(snapshot.ledger.bySource.user).toBe(40)
    expect(snapshot.ledger.bySource.unknown).toBe(60)
    assertSumEqualsTotal(snapshot)
  })
})

describe('INV-9：seq → 来源只按会话事件类型推导', () => {
  it('四类 surface 事件各自映射到对应来源', () => {
    const index = seqSourceIndex(sessionWith([
      { seq: 0, type: 'system/message' },
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'tool/result' },
      { seq: 3, type: 'assistant/message' },
    ]))
    expect([...index.entries()]).toEqual([
      [0, 'system'],
      [1, 'user'],
      [2, 'tool'],
      [3, 'assistant'],
    ])
  })

  it('非 surface 事件不进索引（⇒ 归因时落 unknown）；正文里的自称不是事件类型', () => {
    const index = seqSourceIndex(sessionWith([
      { seq: 0, type: 'system/message' },
      // 正文自称「已折叠」不构成状态（INV-9）：事件类型不认识就不进索引。
      { seq: 1, type: 'assistant/message', data: { message: { content: '已折叠 系统提示 1000 tokens' } } },
      { seq: 2, type: 'developer/message' },
      { seq: 3, type: 'turn/end' },
      { seq: 4 },
      { type: 'user/message' },
      null,
    ]))
    expect([...index.entries()]).toEqual([
      [0, 'system'],
      [1, 'assistant'],
    ])
  })

  it('session 没有 snapshotEvents / 抛错 ⇒ 索引为空（不抛），全部落 unknown', () => {
    expect(seqSourceIndex({ id: 'bare' }).size).toBe(0)
    expect(seqSourceIndex(null).size).toBe(0)
    expect(seqSourceIndex({ snapshotEvents: () => { throw new Error('boom') } }).size).toBe(0)
    expect(seqSourceIndex({ snapshotEvents: () => 'not-an-array' }).size).toBe(0)

    const { tap } = makeTap({ measure: () => ({ totalTokens: 5, nodes: [{ seq: 1, tokens: 5 }] }) })
    tap.capture({ id: 'bare' })
    expect(tap.snapshot()?.ledger.bySource.unknown).toBe(5)
    expect(tap.snapshot()?.ledger.unknownNodes).toBe(1)
  })
})

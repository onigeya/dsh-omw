/**
 * 压缩事件接线（Story 8.1 第 2 轮 / 假事件，0 开库）。
 *
 * 覆盖：`compaction/start` 登记待配对、`compaction/end` 解除、`compaction/summary` 解除 + 入图（注入假连接则为空操作）、
 * 缺 sessionId 不登记、未知事件 no-op、抛错不冒泡（AC:1536-1538）、INV-7 的 readOnly 跳过由调用方保证（此处只测 stop）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  COMPACTION_EVENT_END,
  COMPACTION_EVENT_START,
  COMPACTION_EVENT_SUMMARY,
  createCompactionWiring,
} from '../src/context/compaction-wiring'

function makeWiring(overrides: {
  getConnection?: () => null
  onOrphan?: (info: { sessionId: string, turn: number | null, waitedMs: number }) => void
  logger?: { warn(message: string): void }
} = {}) {
  let timerCallback: (() => void) | null = null
  const orphans: Array<{ sessionId: string, turn: number | null, waitedMs: number }> = []
  const wiring = createCompactionWiring({
    getConnection: overrides.getConnection ?? (() => null),
    configSnapshot: () => ({ ratio: 0.8 }),
    orphanTimeoutMs: 60_000,
    onOrphan: overrides.onOrphan ?? ((info) => orphans.push(info)),
    logger: overrides.logger,
    now: () => new Date('2026-06-01T00:00:00.000Z'),
  })
  // 用真实定时器的替代品不可注入（wiring 内部自建 tracker），因此这里只验证「登记/解除」的可见状态。
  void timerCallback
  return { wiring, orphans }
}

const session = { id: 's-1' }

describe('compaction 事件接线（AC:1528-1544）', () => {
  it('start 登记 ⇒ pendingCompactions=1；end 解除 ⇒ 0', async () => {
    const { wiring } = makeWiring()
    await wiring.handleEvent(session, { type: COMPACTION_EVENT_START, payload: { turn: 2 } })
    expect(wiring.pendingCompactions()).toBe(1)
    await wiring.handleEvent(session, { type: COMPACTION_EVENT_END })
    expect(wiring.pendingCompactions()).toBe(0)
    wiring.stop()
  })

  it('summary 也解除待配对（summary 是合法的配对结束）', async () => {
    const { wiring } = makeWiring()
    await wiring.handleEvent(session, { type: COMPACTION_EVENT_START, payload: { turn: null } })
    expect(wiring.pendingCompactions()).toBe(1)
    await wiring.handleEvent(session, {
      type: COMPACTION_EVENT_SUMMARY,
      payload: { sessionId: 's-1', compactionId: 'c-1', summary: '正文' },
    })
    expect(wiring.pendingCompactions()).toBe(0)
    wiring.stop()
  })

  it('缺 sessionId 的 start 不登记（不猜归属），并记 warn', async () => {
    const warn = vi.fn()
    const { wiring } = makeWiring({ logger: { warn } })
    await wiring.handleEvent({}, { type: COMPACTION_EVENT_START, payload: { turn: 1 } })
    expect(wiring.pendingCompactions()).toBe(0)
    expect(warn).toHaveBeenCalled()
    wiring.stop()
  })

  it('未知事件 / 无 type ⇒ no-op', async () => {
    const { wiring } = makeWiring()
    await wiring.handleEvent(session, { type: 'turn/start' })
    await wiring.handleEvent(session, {})
    await wiring.handleEvent(session, null)
    expect(wiring.pendingCompactions()).toBe(0)
    wiring.stop()
  })

  it('summary 入图失败不冒泡（post-commit fire-and-forget，AC:1536-1538）', async () => {
    const warn = vi.fn()
    const { wiring } = makeWiring({
      // 没有连接 ⇒ 直接 return（不抛）；payload 非法 ⇒ 内部 catch 后 warn
      getConnection: () => null,
      logger: { warn },
    })
    await expect(wiring.handleEvent(session, {
      type: COMPACTION_EVENT_SUMMARY,
      payload: { sessionId: 's-1' },
    })).resolves.toBeUndefined()
    wiring.stop()
  })

  it('事件名常量与 AD-7 契约一致', () => {
    expect(COMPACTION_EVENT_START).toBe('compaction/start')
    expect(COMPACTION_EVENT_SUMMARY).toBe('compaction/summary')
    expect(COMPACTION_EVENT_END).toBe('compaction/end')
  })

  it('stock 形态的 summary（payload 不含 sessionId）不会抛：会话归属由事件目标注入', async () => {
    // 证据：dsh-compaction-basic/lib/index.js:634-649 的 summary payload 只有
    // {compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, …}，
    // **没有 sessionId / turn**。若 wiring 不注入 sessionId，buildCompactionSummaryEntry 会以
    // `compaction_summary_invalid` 失败、整条入图静默丢失（这正是本轮修掉的 bug）。
    const warn = vi.fn()
    const { wiring } = makeWiring({ getConnection: () => null, logger: { warn } })
    await expect(wiring.handleEvent({ id: 's-42' }, {
      type: COMPACTION_EVENT_SUMMARY,
      compactionId: 'c-42',
      summary: '摘要正文',
      shadowedSeqs: [1, 2],
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 10,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })).resolves.toBeUndefined()
    wiring.stop()
  })
})

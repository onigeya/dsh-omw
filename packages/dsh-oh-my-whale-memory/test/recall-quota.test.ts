/**
 * 召回配额纯单测（Story 3.1 / FR-10 + spec D7）：按会话键隔离计数、3 次放行第 4 次拒、
 * `turn/start` 与 `turn/end` **双点**重置、其它事件不误重置、缺 session 归 `'unknown'` 桶。
 *
 * 键与 `inboxSessionKey`（inbox/idle-gate.ts:40）同名实现：监听器收 `session` 对象，
 * 工具面收 `exec.agent.session`，两边经同一个键落到同一只桶。
 *
 * 纯逻辑：不开库、不读时钟。
 */
import { describe, expect, it } from 'vitest'
import { RECALL_TURN_QUOTA, createQuotaResetListener, createRecallTurnQuota } from '../src/tools/recall-quota'

const S1 = 'session-1'
const S2 = 'session-2'

describe('createRecallTurnQuota（按会话键计数）', () => {
  it('缺省上限 3 次；第 4 次拒绝', () => {
    expect(RECALL_TURN_QUOTA).toBe(3)
    const quota = createRecallTurnQuota()
    expect(quota.consume(S1)).toBe(true)
    expect(quota.consume(S1)).toBe(true)
    expect(quota.consume(S1)).toBe(true)
    expect(quota.used(S1)).toBe(3)
    expect(quota.consume(S1)).toBe(false)
    expect(quota.consume(S1)).toBe(false)
    expect(quota.used(S1)).toBe(3)
  })

  it('会话键隔离：一个会话耗尽不影响另一个会话（spec D7）', () => {
    const quota = createRecallTurnQuota()
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) expect(quota.consume(S1)).toBe(true)
    expect(quota.consume(S1)).toBe(false)
    // S2 从未消耗过：它的回合配额仍是满额。
    expect(quota.used(S2)).toBe(0)
    expect(quota.consume(S2)).toBe(true)
    expect(quota.consume(S2)).toBe(true)
    expect(quota.consume(S2)).toBe(true)
    expect(quota.consume(S2)).toBe(false)
  })

  it('reset(owner) 只清该会话的桶，其它会话的计数不受影响', () => {
    const quota = createRecallTurnQuota()
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume(S1)
    quota.consume(S2)
    quota.reset(S1)
    expect(quota.used(S1)).toBe(0)
    expect(quota.used(S2)).toBe(1)
    expect(quota.consume(S1)).toBe(true)
    // S2 只剩 2 次。
    expect(quota.consume(S2)).toBe(true)
    expect(quota.consume(S2)).toBe(true)
    expect(quota.consume(S2)).toBe(false)
  })

  it('自定义上限；非正/非有限回落缺省 3', () => {
    const quota = createRecallTurnQuota(2)
    expect(quota.consume(S1)).toBe(true)
    expect(quota.consume(S1)).toBe(true)
    expect(quota.consume(S1)).toBe(false)
    // 非正/非有限 limit 各自回落到缺省 3（一次消耗一个实例，不共享状态）。
    for (const fallback of [0, -1, Number.NaN]) {
      const defaulted = createRecallTurnQuota(fallback)
      for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) expect(defaulted.consume(S1)).toBe(true)
      expect(defaulted.consume(S1)).toBe(false)
    }
  })
})

describe('createQuotaResetListener（turn/start 与 turn/end 双点重置）', () => {
  it('turn/start 重置该会话配额', () => {
    const quota = createRecallTurnQuota()
    const listener = createQuotaResetListener(quota)
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume(S1)
    expect(quota.consume(S1)).toBe(false)
    listener({ id: S1 }, { type: 'turn/start' })
    expect(quota.used(S1)).toBe(0)
    expect(quota.consume(S1)).toBe(true)
  })

  it('turn/end 也重置（spec D7：收尾即释放，不把上一轮计数带进下一轮）', () => {
    const quota = createRecallTurnQuota()
    const listener = createQuotaResetListener(quota)
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume(S1)
    expect(quota.consume(S1)).toBe(false)
    listener({ id: S1 }, { type: 'turn/end' })
    expect(quota.used(S1)).toBe(0)
    expect(quota.consume(S1)).toBe(true)
  })

  it('重置只作用于事件里的那个会话键（不误清别人的配额）', () => {
    const quota = createRecallTurnQuota()
    const listener = createQuotaResetListener(quota)
    quota.consume(S2)
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume(S1)
    listener({ id: S1 }, { type: 'turn/end' })
    expect(quota.used(S1)).toBe(0)
    expect(quota.used(S2)).toBe(1)
  })

  it("turn 边界带真实 session 时也清 'unknown' 桶（F-08 混合路径）", () => {
    const quota = createRecallTurnQuota()
    const listener = createQuotaResetListener(quota)
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume('unknown')
    expect(quota.consume('unknown')).toBe(false)

    listener({ id: S1 }, { type: 'turn/start' })

    expect(quota.used('unknown')).toBe(0)
    expect(quota.consume('unknown')).toBe(true)
  })

  it('其它事件 / 缺 type / 缺 session：不重置；缺 session 归 unknown 桶', () => {
    const quota = createRecallTurnQuota()
    const listener = createQuotaResetListener(quota)
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume(S1)
    listener({ id: S1 }, { type: 'step/end' })
    listener({ id: S1 }, {})
    listener({ id: S1 }, null)
    expect(quota.consume(S1)).toBe(false)

    // 无 session 身份 ⇒ 'unknown' 桶（保守取向与 idle-gate 一致）。
    for (let i = 0; i < RECALL_TURN_QUOTA; i += 1) quota.consume('unknown')
    expect(quota.consume('unknown')).toBe(false)
    listener(null, { type: 'turn/end' })
    expect(quota.used('unknown')).toBe(0)
    expect(quota.consume('unknown')).toBe(true)
  })
})

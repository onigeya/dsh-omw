/**
 * 召回配额纯单测（Story 3.1 / FR-12）：消耗 3 次后拒绝、reset 后恢复、
 * listener 只认 `turn/start`（`turn/end` 等一律忽略）。
 *
 * 纯逻辑：不开库、不读时钟。
 */
import { describe, expect, it } from 'vitest'
import { RECALL_TURN_QUOTA, createQuotaResetListener, createRecallQuota } from '../src/recall/quota'

describe('createRecallQuota', () => {
  it('缺省上限 3 次；第 4 次拒绝', () => {
    expect(RECALL_TURN_QUOTA).toBe(3)
    const quota = createRecallQuota()
    expect(quota.consume()).toBe(true)
    expect(quota.consume()).toBe(true)
    expect(quota.consume()).toBe(true)
    expect(quota.used()).toBe(3)
    expect(quota.consume()).toBe(false)
    expect(quota.consume()).toBe(false)
    expect(quota.used()).toBe(3)
  })

  it('reset 后恢复满额', () => {
    const quota = createRecallQuota()
    for (let i = 0; i < 3; i += 1) expect(quota.consume()).toBe(true)
    expect(quota.consume()).toBe(false)
    quota.reset()
    expect(quota.used()).toBe(0)
    expect(quota.consume()).toBe(true)
  })

  it('自定义上限；非正/非有限回落缺省 3', () => {
    const quota = createRecallQuota(2)
    expect(quota.consume()).toBe(true)
    expect(quota.consume()).toBe(true)
    expect(quota.consume()).toBe(false)
    // 非正/非有限 limit 各自回落到缺省 3（一次消耗一个实例，不共享状态）。
    for (const fallback of [0, -1, Number.NaN]) {
      const defaulted = createRecallQuota(fallback)
      expect(defaulted.consume()).toBe(true)
      expect(defaulted.consume()).toBe(true)
      expect(defaulted.consume()).toBe(true)
      expect(defaulted.consume()).toBe(false)
    }
  })
})

describe('createQuotaResetListener', () => {
  it('turn/start 重置配额', () => {
    const quota = createRecallQuota()
    const listener = createQuotaResetListener(quota)
    quota.consume()
    quota.consume()
    quota.consume()
    expect(quota.consume()).toBe(false)
    listener({}, { type: 'turn/start' })
    expect(quota.consume()).toBe(true)
  })

  it('只认 turn/start：turn/end / 未知事件 / 缺 type 不重置', () => {
    const quota = createRecallQuota()
    const listener = createQuotaResetListener(quota)
    quota.consume()
    quota.consume()
    quota.consume()
    listener({}, { type: 'turn/end' })
    listener({}, { type: 'step/end' })
    listener({}, {})
    listener({}, null)
    expect(quota.consume()).toBe(false)
    listener({}, { type: 'turn/start', turn: 1 })
    expect(quota.consume()).toBe(true)
  })
})

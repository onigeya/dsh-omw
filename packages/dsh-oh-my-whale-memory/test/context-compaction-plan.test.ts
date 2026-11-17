/**
 * 压缩分档计划器（Story 8.3 第 1 轮 / AC:1693-1699、AC:1709-1711）。
 *
 * 纯函数、零宿主依赖（0 开库），覆盖：T1 四条短路、判据缺失 ⇒ T1、边界不平衡 ⇒ 整次 skip、
 * 可压预算不含 T1、交错策略两档、`compactableSpans` 的区间输出。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOW_ENTROPY_THRESHOLD,
  compactableSpans,
  planCompaction,
  type CompactionSegment,
} from '../src/context/compaction-plan'

function segment(overrides: Partial<CompactionSegment> = {}): CompactionSegment {
  return {
    start: 1,
    end: 10,
    tokens: 100,
    hasUserUtterance: false,
    hasSystemMessage: false,
    hasProtectedMemory: false,
    entropy: 0.1,
    balancedStart: true,
    balancedEnd: true,
    ...overrides,
  }
}

describe('T1 短路（AC:1693-1695）', () => {
  it('user 原话 ⇒ T1，reason=user-utterance', () => {
    const plan = planCompaction([segment({ hasUserUtterance: true })])
    expect(plan.decisions[0]?.tier).toBe('T1')
    expect(plan.decisions[0]?.reason).toBe('user-utterance')
    expect(plan.decision).toBe('skip')
    expect(plan.reason).toBe('no-compactable-segment')
  })

  it('system 消息 ⇒ T1', () => {
    const plan = planCompaction([segment({ hasSystemMessage: true })])
    expect(plan.decisions[0]?.reason).toBe('system-message')
  })

  it('受保护记忆（priority=-1 或 kind=instruction）⇒ T1', () => {
    const plan = planCompaction([segment({ hasProtectedMemory: true })])
    expect(plan.decisions[0]?.reason).toBe('protected-memory')
  })

  // Story 8.5 / T4：动态骨架段同样 T1，且计入 protectedTokens（不进可压预算）。
  it('动态骨架段（hasSkeleton）⇒ T1，reason=skeleton-fact，不计入可压预算', () => {
    const plan = planCompaction([
      segment({ start: 1, end: 10, tokens: 100, entropy: 0.1 }),
      segment({ start: 11, end: 20, tokens: 321, hasSkeleton: true }),
    ])
    expect(plan.decisions[1]?.tier).toBe('T1')
    expect(plan.decisions[1]?.reason).toBe('skeleton-fact')
    expect(plan.compactableTokens).toBe(100)
    expect(plan.protectedTokens).toBe(321)
    expect(plan.decision).toBe('compact')
    expect(compactableSpans(plan)).toEqual([{ start: 1, end: 10 }])
  })

  it('T1 不计入可压预算：一个可压段 + 一个 T1 段 ⇒ compactableTokens 只算可压段', () => {
    const plan = planCompaction([
      segment({ start: 1, end: 10, tokens: 100, entropy: 0.1 }),
      segment({ start: 11, end: 20, tokens: 999, hasUserUtterance: true }),
    ])
    expect(plan.compactableTokens).toBe(100)
    expect(plan.protectedTokens).toBe(999)
    expect(plan.decision).toBe('compact')
  })
})

describe('判据缺失 ⇒ T1 不压（AC:1697-1699）', () => {
  it('entropy=null / undefined / NaN 都归 T1 且 reason=criterion-unavailable', () => {
    for (const entropy of [null, undefined, Number.NaN]) {
      const plan = planCompaction([segment({ entropy })])
      expect(plan.decisions[0]?.tier).toBe('T1')
      expect(plan.decisions[0]?.reason).toBe('criterion-unavailable')
      expect(plan.decision).toBe('skip')
    }
  })
})

describe('边界（AC:1687 / INV-10）', () => {
  it('任一段边界不平衡 ⇒ 整次 skip（reason=unbalanced-boundary），不做部分压缩', () => {
    const plan = planCompaction([
      segment({ start: 1, end: 10 }),
      segment({ start: 11, end: 20, balancedEnd: false }),
    ])
    expect(plan.decision).toBe('skip')
    expect(plan.reason).toBe('unbalanced-boundary')
    expect(plan.compactableTokens).toBe(0)
    // 分档结果仍给出（可观测），只是不执行
    expect(plan.decisions).toHaveLength(2)
  })
})

describe('交错策略（spec-8-3 §2 的待裁决项）', () => {
  const interleaved = [
    segment({ start: 1, end: 10, tokens: 100, entropy: 0.1 }),
    segment({ start: 11, end: 20, tokens: 500, hasUserUtterance: true }),
    segment({ start: 21, end: 30, tokens: 200, entropy: 0.1 }),
  ]

  it('默认 skip：T1 夹在可压段之间 ⇒ 整次 skip（fail-closed）', () => {
    const plan = planCompaction(interleaved)
    expect(plan.layout).toBe('interleaved')
    expect(plan.decision).toBe('skip')
    expect(plan.reason).toBe('interleaved-protected')
  })

  it('fold-protected：允许压缩（T1 靠句柄折叠保护，偏离 AC:1695 字面，需裁决后启用）', () => {
    const plan = planCompaction(interleaved, { interleavedPolicy: 'fold-protected' })
    expect(plan.layout).toBe('interleaved')
    expect(plan.decision).toBe('compact')
    expect(plan.reason).toBeNull()
    expect(plan.protectedTokens).toBe(500)
  })

  it('全部可压 ⇒ layout=contiguous、decision=compact', () => {
    const plan = planCompaction([segment(), segment({ start: 11, end: 20 })])
    expect(plan.layout).toBe('contiguous')
    expect(plan.decision).toBe('compact')
  })
})

describe('分档与预算', () => {
  it('熵低于阈值 ⇒ T2；不低于 ⇒ T3', () => {
    const plan = planCompaction([
      segment({ start: 1, end: 5, entropy: 0.1 }),
      segment({ start: 6, end: 9, entropy: 0.9 }),
    ])
    expect(plan.decisions[0]?.tier).toBe('T2')
    expect(plan.decisions[1]?.tier).toBe('T3')
    expect(DEFAULT_LOW_ENTROPY_THRESHOLD).toBe(0.35)
  })

  it('空输入 ⇒ skip(no-segments)', () => {
    const plan = planCompaction([])
    expect(plan.decision).toBe('skip')
    expect(plan.reason).toBe('no-segments')
    expect(plan.layout).toBe('none')
  })

  it('compactableSpans：只返回非 T1 区间；skip 时为空', () => {
    const compact = planCompaction([
      segment({ start: 1, end: 10 }),
      segment({ start: 11, end: 20, hasUserUtterance: true }),
      segment({ start: 21, end: 30 }),
    ], { interleavedPolicy: 'fold-protected' })
    expect(compactableSpans(compact)).toEqual([
      { start: 1, end: 10 },
      { start: 21, end: 30 },
    ])
    const skipped = planCompaction([segment({ hasUserUtterance: true })])
    expect(compactableSpans(skipped)).toEqual([])
  })
})

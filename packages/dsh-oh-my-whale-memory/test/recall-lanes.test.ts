/**
 * 双路召回合并测试（Story 9.3 / T3、spec I/O 矩阵 9–11）。
 *
 * 断言对象是 `src/recall/lanes.ts` 的实际契约（AC:2023）：
 * - 矩阵 9：`limit` 1 / 2 ⇒ `reserve` 0（不保留改写 lane 槽位，原始命中不被挤空）；
 * - 矩阵 10：`limit ≥ 3` ⇒ `reserve = max(1, floor(limit/3))`，原始 lane 至少占
 *   `limit - reserve`；改写 lane 只吃保留位；
 * - 矩阵 11：两 lane 有重复 id ⇒ 去重后不超 limit（先占位的 lane 拿走那条）。
 *
 * 纯函数、无库、无时钟、无网络。
 */
import { describe, expect, it } from 'vitest'
import { conversationalReserve, mergeSituatedLanes } from '../src/recall/lanes'

/** 只要求 id 的 lane 元素（实现契约：合并只按 id 去重）。 */
function item(id: string): { readonly id: string } {
  return { id }
}

const ids = (items: readonly { readonly id: string }[]): string[] => items.map((entry) => entry.id)

describe('矩阵 9：limit=1/2 ⇒ 不保留 reserve 槽位', () => {
  it('conversationalReserve 对 1 / 2 返回 0', () => {
    expect(conversationalReserve(1)).toBe(0)
    expect(conversationalReserve(2)).toBe(0)
  })

  it('limit=1：改写 lane 一点不吃，结果只来自原始 lane', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1')],
      rewritten: [item('r1')],
      limit: 1,
    })
    expect(merged).toMatchObject({ originalCount: 1, rewrittenCount: 0, reserve: 0 })
    expect(ids(merged.items)).toEqual(['o1'])
  })

  it('limit=2 且原始不足时用改写补齐，但改写不挤掉原始命中', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1')],
      rewritten: [item('r1'), item('r2')],
      limit: 2,
    })
    expect(merged).toMatchObject({ originalCount: 1, rewrittenCount: 1, reserve: 0 })
    expect(ids(merged.items)).toEqual(['o1', 'r1'])
  })
})

describe('矩阵 10：limit≥3 ⇒ reserve=max(1,floor(limit/3))；原始 lane ≥ limit-reserve', () => {
  it('reserve 公式：3→1、5→1、6→2、9→3、20→6', () => {
    expect(conversationalReserve(3)).toBe(1)
    expect(conversationalReserve(4)).toBe(1)
    expect(conversationalReserve(5)).toBe(1)
    expect(conversationalReserve(6)).toBe(2)
    expect(conversationalReserve(9)).toBe(3)
    expect(conversationalReserve(20)).toBe(6)
  })

  it('limit=3、reserve=1：原始占 2、改写占 1', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1'), item('o2'), item('o3')],
      rewritten: [item('r1'), item('r2')],
      limit: 3,
    })
    expect(merged.reserve).toBe(1)
    expect(merged).toMatchObject({ originalCount: 2, rewrittenCount: 1 })
    // 占位顺序：原始先占 limit-reserve=2，改写吃 1 个保留位。
    expect(ids(merged.items)).toEqual(['o1', 'o2', 'r1'])
  })

  it('limit=6、reserve=2：原始占 4、改写占 2', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1'), item('o2'), item('o3'), item('o4'), item('o5'), item('o6')],
      rewritten: [item('r1'), item('r2'), item('r3')],
      limit: 6,
    })
    expect(merged.reserve).toBe(2)
    expect(merged).toMatchObject({ originalCount: 4, rewrittenCount: 2 })
    expect(ids(merged.items)).toEqual(['o1', 'o2', 'o3', 'o4', 'r1', 'r2'])
  })

  it('原始 lane 不足时改写补齐到 limit，改写 count 不超过剩余槽位', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1')],
      rewritten: [item('r1'), item('r2'), item('r3'), item('r4'), item('r5')],
      limit: 4,
    })
    // reserve = max(1, floor(4/3)) = 1；原始占 1，改写最多吃 3 个剩余槽位。
    expect(merged).toMatchObject({ originalCount: 1, rewrittenCount: 3, reserve: 1 })
    expect(ids(merged.items)).toEqual(['o1', 'r1', 'r2', 'r3'])
  })

  it('改写 lane 为空时原始 lane 独占全部 limit（不清空也不留空位）', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1'), item('o2'), item('o3')],
      rewritten: [],
      limit: 3,
    })
    expect(merged).toMatchObject({ originalCount: 3, rewrittenCount: 0, reserve: 1 })
    expect(ids(merged.items)).toEqual(['o1', 'o2', 'o3'])
  })
})

describe('矩阵 11：两 lane 重复 id 去重后不超 limit', () => {
  it('同一 id 两路都命中 ⇒ 只出现一次，计入先占位的 lane', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1'), item('dup')],
      rewritten: [item('dup'), item('r1')],
      limit: 3,
    })
    // 原始 lane 先占 limit-reserve=2，dup 被原始拿走；改写再去重丢掉它。
    expect(merged).toMatchObject({ originalCount: 2, rewrittenCount: 1 })
    expect(ids(merged.items)).toEqual(['o1', 'dup', 'r1'])
  })

  it('大量重复时结果仍 ≤ limit，且不重复 id', () => {
    const merged = mergeSituatedLanes({
      original: [item('a'), item('a'), item('b')],
      rewritten: [item('b'), item('c'), item('d'), item('e')],
      limit: 4,
    })
    expect(merged.items).toHaveLength(4)
    expect(new Set(ids(merged.items)).size).toBe(4)
  })

  it('空 id 不被当作可去重身份：宁可少一条也不让两路各塞一条（合并不抛错）', () => {
    const merged = mergeSituatedLanes({
      original: [{ id: '' }, { id: '' }],
      rewritten: [{ id: '' }],
      limit: 3,
    })
    expect(ids(merged.items)).toEqual([])
    expect(merged.originalCount).toBe(0)
    expect(merged.rewrittenCount).toBe(0)
  })

  it('limit ≤ 0 / NaN 按 1 处理（合并本身不抛错）', () => {
    for (const limit of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const merged = mergeSituatedLanes({ original: [item('o1')], rewritten: [item('r1')], limit })
      expect(merged.items).toHaveLength(1)
      expect(merged.reserve).toBe(0)
    }
  })

  it('显式 reserve 覆盖默认公式（调用方改配额时尊重）', () => {
    const merged = mergeSituatedLanes({
      original: [item('o1'), item('o2'), item('o3')],
      rewritten: [item('r1')],
      limit: 3,
      reserve: 2,
    })
    expect(merged.reserve).toBe(2)
    // 原始先占 limit-reserve=1（o1）→ 改写吃 2 个保留位但只有 r1 唯一 → 补位阶段原始再进 o2。
    expect(ids(merged.items)).toEqual(['o1', 'r1', 'o2'])
    expect(merged).toMatchObject({ originalCount: 2, rewrittenCount: 1 })
  })
})
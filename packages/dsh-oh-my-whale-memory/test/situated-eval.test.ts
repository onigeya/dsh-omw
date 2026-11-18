/**
 * A/B 评估测试（Story 9.3 / T8、AC:2020-2024、I/O 矩阵 20–21）。
 *
 * 20. 无对照组 ⇒ lift=null + reason，不得声称有效；
 * 21. 有对照组 ⇒ lift 可复算并记录（记录只含 id 与数值，可检视、无正文）。
 *
 * 纯函数：输入两个命中集与真值集，不读库、不看时钟。
 */
import { describe, expect, it } from 'vitest'
import {
  SITUATED_EVAL_ACTION,
  computeHitRate,
  evaluateSituatedRecall,
  situatedEvalLogDetail,
} from '../src/recall/situated-eval'

describe('computeHitRate（命中率口径）', () => {
  it('去重 + 稳定序；命中率 = |hits ∩ relevant| / |relevant|', () => {
    const rate = computeHitRate({ hits: ['b', 'a', 'a'], relevant: ['a', 'c', 'a'] })
    expect(rate).toMatchObject({ hits: 2, relevant: 2, hitRate: 0.5 })
    expect(rate.hitIds).toEqual(['a', 'b'])
  })

  it('真值集为空 ⇒ hitRate null（不静默按 0 计）', () => {
    const rate = computeHitRate({ hits: ['a'], relevant: [] })
    expect(rate.hitRate).toBeNull()
    expect(rate.relevant).toBe(0)
  })
})

describe('矩阵 20：无对照组（边界 ⇒ 不得声称有效）', () => {
  it('control 缺失 / null ⇒ lift null + reason=no-control', () => {
    for (const control of [undefined, null]) {
      const result = evaluateSituatedRecall({
        situated: { hits: ['a', 'b'], relevant: ['a', 'b'] },
        ...(control === undefined ? {} : { control }),
      })
      expect(result.lift).toBeNull()
      expect(result.reason).toBe('no-control')
      expect(result.control).toBeNull()
      // 处境侧命中率照算（可检视），但「提升」不成立。
      expect(result.situated.hitRate).toBe(1)
    }
  })

  it('对照组真值集为空 ⇒ control-empty；为零 ⇒ control-zero（除零不产生无限提升）', () => {
    const emptyControl = evaluateSituatedRecall({
      situated: { hits: ['a'], relevant: ['a'] },
      control: { hits: ['a'], relevant: [] },
    })
    expect(emptyControl).toMatchObject({ lift: null, reason: 'control-empty' })

    const zeroControl = evaluateSituatedRecall({
      situated: { hits: ['a'], relevant: ['a'] },
      // 对照组有真值但一条都没命中 ⇒ 命中率 0（不是「无真值」）。
      control: { hits: ['z'], relevant: ['y'] },
    })
    expect(zeroControl).toMatchObject({ lift: null, reason: 'control-zero' })
  })

  it('处境侧真值集为空 ⇒ situated-empty（宁可 null，不给伪 lift）', () => {
    const result = evaluateSituatedRecall({
      situated: { hits: ['a'], relevant: [] },
      control: { hits: ['a'], relevant: ['a'] },
    })
    expect(result).toMatchObject({ lift: null, reason: 'situated-empty' })
  })

  it('评估记录（detail）在 lift=null 时如实记 null 与 reason，不写「有效」结论', () => {
    const result = evaluateSituatedRecall({ situated: { hits: ['a'], relevant: ['a'] } })
    const detail = situatedEvalLogDetail(result)
    const parsed = JSON.parse(detail) as Record<string, any>
    expect(parsed.lift).toBeNull()
    expect(parsed.reason).toBe('no-control')
    expect(detail).not.toContain('valid')
    expect(detail).not.toContain('有效')
  })
})

describe('矩阵 21：有对照组（lift 可复算并记录）', () => {
  it('lift = 处境命中率 / 对照组命中率', () => {
    const result = evaluateSituatedRecall({
      situated: { hits: ['a', 'b', 'c'], relevant: ['a', 'b'] },
      control: { hits: ['a'], relevant: ['a', 'b', 'c', 'd'] },
    })
    // 处境 2/2=1；对照 1/4=0.25 → lift 4。
    expect(result.situated.hitRate).toBe(1)
    expect(result.control?.hitRate).toBe(0.25)
    expect(result.lift).toBeCloseTo(4, 10)
    // 可复算：拿两项命中率再除一遍得到同一数。
    expect(result.lift).toBeCloseTo(result.situated.hitRate! / result.control!.hitRate!, 10)
  })

  it('lift < 1（处境侧更差）也要如实报（评估不是营销）', () => {
    const result = evaluateSituatedRecall({
      situated: { hits: ['a'], relevant: ['a', 'b', 'c', 'd'] },
      control: { hits: ['a', 'b'], relevant: ['a', 'b', 'c', 'd'] },
    })
    expect(result.lift).toBeCloseTo(0.5, 10)
  })

  it('detail 记录 lift 与两侧计数 / id（可检视）；命中 id 截到 20 条', () => {
    const many = Array.from({ length: 25 }, (_, index) => `id-${index}`)
    const result = evaluateSituatedRecall({
      situated: { hits: many, relevant: many },
      control: { hits: many.slice(0, 5), relevant: many },
    })
    const parsed = JSON.parse(situatedEvalLogDetail(result)) as Record<string, any>
    expect(parsed.lift).toBe(5)
    expect(parsed.situated).toMatchObject({ hits: 25, relevant: 25, hitRate: 1 })
    expect(parsed.control).toMatchObject({ hits: 5, relevant: 25, hitRate: 0.2 })
    // 只留 id 与数值：截 20 条，且不含正文 / 查询文本。
    expect(parsed.situated.hitIds).toHaveLength(20)
    expect(parsed.control.hitIds).toHaveLength(5)
  })

  it('评估记录的 action 是封闭值（按它筛 generation_log）', () => {
    expect(SITUATED_EVAL_ACTION).toBe('situated_eval')
  })
})
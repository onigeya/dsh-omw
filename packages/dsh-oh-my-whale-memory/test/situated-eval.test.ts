/**
 * 处境条件化召回的 A/B 评估测试（Story 9.3 / T8、spec I/O 矩阵 20–21）。
 *
 * 断言对象是 `src/recall/situated-eval.ts` 的实际契约（AC:2022）：
 * - 矩阵 20：**无对照组不得给 lift**（`lift: null` + 封闭 reason），防自证有效；
 * - 矩阵 21：有对照组 ⇒ `lift = 处境命中率 / embedding-only 命中率`，可复算，且
 *   评估记录只含 id 与数值（不含记忆正文 / 查询文本 / 凭据）。
 *
 * 纯函数、无库、无时钟、无网络。
 */
import { describe, expect, it } from 'vitest'
import {
  SITUATED_EVAL_ACTION,
  SITUATED_EVAL_KIND,
  computeHitRate,
  evaluateSituatedRecall,
  situatedEvalLogDetail,
  type SituatedHitSet,
} from '../src/recall/situated-eval'

/** 一组固定的真值：四条相关记忆（`|relevant| = 4`）。 */
const RELEVANT = ['m1', 'm2', 'm3', 'm4']

function hitSet(hits: readonly string[], relevant: readonly string[] = RELEVANT): SituatedHitSet {
  return { hits, relevant }
}

describe('矩阵 20：无对照组 ⇒ lift=null + reason（不得声称有效）', () => {
  it('control 缺省 / null ⇒ lift 必为 null（即使处境侧命中率很好）', () => {
    const situated = hitSet(['m1', 'm2', 'm3', 'm4']) // 命中率 1.0，最容易「自证有效」
    for (const control of [undefined, null]) {
      const result = evaluateSituatedRecall({ situated, control })
      expect(result.lift).toBeNull()
      expect(result.reason).toBe('no-control')
      expect(result.control).toBeNull()
      // 自身命中率照报（不隐藏数据），只是不给 lift。
      expect(result.situated.hitRate).toBe(1)
    }
  })

  it('对照组真值集为空 ⇒ lift=null + control-empty（比率无定义，不按 0 计）', () => {
    const result = evaluateSituatedRecall({ situated: hitSet(['m1']), control: hitSet(['m1'], []) })
    expect(result.lift).toBeNull()
    expect(result.reason).toBe('control-empty')
    expect(result.control?.hitRate).toBeNull()
  })

  it('对照组命中率为 0 ⇒ lift=null + control-zero（除零不产生「无限提升」）', () => {
    const result = evaluateSituatedRecall({ situated: hitSet(['m1']), control: hitSet(['mx', 'my']) })
    expect(result.lift).toBeNull()
    expect(result.reason).toBe('control-zero')
    expect(result.control?.hitRate).toBe(0)
  })

  it('处境侧真值集为空 ⇒ lift=null + situated-empty（对照组有值也不硬比）', () => {
    const result = evaluateSituatedRecall({ situated: hitSet(['m1'], []), control: hitSet(['m1']) })
    expect(result.lift).toBeNull()
    expect(result.reason).toBe('situated-empty')
  })

  it('reason 是封闭词表（四种取值之一），不含自由文本', () => {
    const cases = evaluateSituatedRecall({ situated: hitSet([]), control: hitSet(['mx']) })
    expect(['no-control', 'control-empty', 'control-zero', 'situated-empty']).toContain(cases.reason)
  })
})

describe('矩阵 21：有对照组 ⇒ lift = 命中率比，可复算', () => {
  it('处境 2/4、对照 1/4 ⇒ lift = 2.0', () => {
    const result = evaluateSituatedRecall({
      situated: hitSet(['m1', 'm2', 'noise']),
      control: hitSet(['m1', 'noise2']),
    })
    expect(result.situated.hitRate).toBe(0.5)
    expect(result.control?.hitRate).toBe(0.25)
    expect(result.lift).toBe(2)
    expect(result.reason).toBeUndefined()
  })

  it('lift 可由两侧 hitRate 复算（记录可检视，不是黑箱）', () => {
    const result = evaluateSituatedRecall({
      situated: hitSet(['m1', 'm2', 'm3']),   // 3/4
      control: hitSet(['m1', 'm2']),          // 2/4
    })
    expect(result.situated.hitRate).toBe(0.75)
    expect(result.control?.hitRate).toBe(0.5)
    expect(result.lift).toBeCloseTo(1.5, 12)
    expect(result.lift).toBe((result.situated.hitRate ?? 0) / (result.control?.hitRate ?? 1))
  })

  it('处境更差时 lift < 1（不隐瞒劣化）', () => {
    const result = evaluateSituatedRecall({
      situated: hitSet(['m1']),
      control: hitSet(['m1', 'm2', 'm3', 'm4']),
    })
    expect(result.lift).toBe(0.25)
  })

  it('computeHitRate：去重 + 升序 + 命中 id 可检视；超集真值不虚增', () => {
    const rate = computeHitRate(hitSet(['m2', 'm1', 'm2', 'noise']))
    expect(rate).toEqual({ hits: 3, relevant: 4, hitRate: 0.5, hitIds: ['m1', 'm2', 'noise'] })
  })

  it('评估记录只含 id 与数值：不含记忆正文 / 查询文本 / 凭据（NFR9）', () => {
    const result = evaluateSituatedRecall({
      situated: hitSet(['m1', 'm2']),
      control: hitSet(['m1']),
    })
    const detail = situatedEvalLogDetail(result)
    const parsed = JSON.parse(detail) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['control', 'lift', 'situated'])
    expect(Object.keys(parsed.situated as object).sort()).toEqual(['hitIds', 'hitRate', 'hits', 'relevant'])
    expect(parsed.lift).toBe(2)
    expect(detail).not.toContain('纯文本')
    expect(detail).not.toContain('token')
    // 审计行的 kind/action 是封闭常量（写 generation_log 时按它筛）。
    expect(SITUATED_EVAL_KIND).toBe('recall')
    expect(SITUATED_EVAL_ACTION).toBe('situated_eval')
  })

  it('lift=null 时 detail 带 reason，control 为 null（不编造对照组）', () => {
    const detail = situatedEvalLogDetail(evaluateSituatedRecall({ situated: hitSet(['m1']) }))
    const parsed = JSON.parse(detail) as { lift: unknown; reason: string; control: unknown }
    expect(parsed.lift).toBeNull()
    expect(parsed.reason).toBe('no-control')
    expect(parsed.control).toBeNull()
  })

  it('命中 id 超过 20 条时 detail 截断（不膨胀日志）', () => {
    const many = Array.from({ length: 30 }, (_, index) => 'm' + String(index).padStart(2, '0'))
    const detail = situatedEvalLogDetail(evaluateSituatedRecall({
      situated: hitSet(many, many),
      control: hitSet(many, many),
    }))
    const parsed = JSON.parse(detail) as { situated: { hits: number; hitIds: string[] } }
    expect(parsed.situated.hits).toBe(30)
    expect(parsed.situated.hitIds).toHaveLength(20)
  })
})
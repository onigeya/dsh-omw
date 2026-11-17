/**
 * 阈值自调护栏（Story 8.4 / T7、矩阵行 13–14、AC:1737-1740、INV-14）。
 *
 * 覆盖：单步 ≤10%、±50% 拒绝、硬下界/上界双侧拒绝、非数值拒绝、拒绝时数值不变、
 * 成功时给出审计素材、以及「只改数值」的签名形态（判据结构不在入参里）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_STEP_RATIO,
  TUNING_REASON_ABOVE_HARD_MAX,
  TUNING_REASON_BELOW_HARD_MIN,
  TUNING_REASON_INVALID_BOUNDS,
  TUNING_REASON_NON_NUMERIC,
  TUNING_REASON_STEP_TOO_LARGE,
  applyTuning,
  formatTuningAudit,
  lengthMinTuningBounds,
} from '../src/context/criteria-tuner'

const BOUNDS = { min: 500, max: 4000 }

describe('矩阵行 13：+50% / 低于硬下界 ⇒ rejected + reason，数值不变', () => {
  it('+50% 被单步上限拒绝（10%）', () => {
    const result = applyTuning({ current: 1000, suggestion: 1500, bounds: BOUNDS })
    expect(result).toEqual({ ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE })
    expect('value' in result).toBe(false)
  })

  it('-50% 同样被拒绝（护栏是双侧的，不是只防上调）', () => {
    expect(applyTuning({ current: 1000, suggestion: 500, bounds: BOUNDS }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE })
  })

  it('低于硬下界 ⇒ below-hard-min（即使步长很小也拒绝）', () => {
    // 510 → 499：步长 2.2% 远低于 10%，但越过硬下界 500，必须拒绝。
    expect(applyTuning({ current: 510, suggestion: 499, bounds: BOUNDS }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_BELOW_HARD_MIN })
    // 恰在下界上则接受（区间是闭的）。
    expect(applyTuning({ current: 505, suggestion: 500, bounds: BOUNDS }).ok).toBe(true)
  })

  it('高于硬上界 ⇒ above-hard-max', () => {
    expect(applyTuning({ current: 3900, suggestion: 4001, bounds: BOUNDS }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_ABOVE_HARD_MAX })
  })

  it('单步恰为 10% ⇒ 接受；10.0001% ⇒ 拒绝（边界不漏）', () => {
    const accepted = applyTuning({ current: 1000, suggestion: 1100, bounds: BOUNDS })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.value).toBe(1100)

    const rejected = applyTuning({ current: 1000, suggestion: 1100.01, bounds: BOUNDS })
    expect(rejected).toEqual({ ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE })
  })
})

describe('矩阵行 14：自调只改数值', () => {
  it('签名只收数值：成功返回的是同一个数值类型与审计素材，没有判据结构', () => {
    const result = applyTuning({ current: 1200, suggestion: 1080, bounds: { min: 200, max: 8000 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(typeof result.value).toBe('number')
    expect(typeof result.audit.delta).toBe('number')
    expect(typeof result.audit.ratio).toBe('number')
    // 不变量集合/判据形态不可能被改动：返回值里根本没有这类字段。
    expect(Object.keys(result).sort()).toEqual(['audit', 'ok', 'value'])
    expect(Object.keys(result.audit).sort()).toEqual(['delta', 'from', 'ratio', 'stepLimit', 'to'])
    expect(result.audit.from).toBe(1200)
    expect(result.audit.to).toBe(1080)
    expect(result.audit.delta).toBe(-120)
    expect(result.audit.ratio).toBeCloseTo(-0.1, 10)
  })

  it('非数值建议（字符串 / NaN / Infinity / null）一律拒绝，不抛', () => {
    for (const suggestion of ['1500', Number.NaN, Number.POSITIVE_INFINITY, null] as unknown[]) {
      const result = applyTuning({ current: 1000, suggestion: suggestion as number, bounds: BOUNDS })
      expect(result).toEqual({ ok: false, rejected: true, reason: TUNING_REASON_NON_NUMERIC })
    }
  })

  it('bounds 非法（min<=0 / max<min）⇒ invalid-bounds；非数值 bounds ⇒ non-numeric', () => {
    for (const bounds of [{ min: 0, max: 10 }, { min: 10, max: 5 }]) {
      expect(applyTuning({ current: 5, suggestion: 5, bounds }))
        .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_INVALID_BOUNDS })
    }
    expect(applyTuning({ current: 5, suggestion: 5, bounds: { min: Number.NaN, max: 5 } }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_NON_NUMERIC })
  })

  it('无变化 ⇒ 接受但值是原点（便于调用方按同一路径记审计）', () => {
    const result = applyTuning({ current: 1000, suggestion: 1000, bounds: BOUNDS })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(1000)
      expect(result.audit.delta).toBe(0)
      expect(formatTuningAudit('criteria.lengthMin', result.audit)).toBe('criteria.lengthMin: 1000 -> 1000 (0.0%)')
    }
  })

  it('单步上限可配置（更小的偏置更容易被拒）', () => {
    expect(applyTuning({ current: 1000, suggestion: 1030, bounds: BOUNDS, maxStepRatio: 0.05 }).ok).toBe(true)
    expect(applyTuning({ current: 1000, suggestion: 1060, bounds: BOUNDS, maxStepRatio: 0.05 }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE })
    expect(DEFAULT_MAX_STEP_RATIO).toBe(0.1)
  })

  it('审计行素材：from/to/delta/ratio 与格式化文本一致', () => {
    const result = applyTuning({ current: 800, suggestion: 880, bounds: { min: 100, max: 2000 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(formatTuningAudit('expandCountThreshold', result.audit)).toBe('expandCountThreshold: 800 -> 880 (+10.0%)')
    expect(result.audit.stepLimit).toBe(DEFAULT_MAX_STEP_RATIO)
  })
})

describe('lengthMin 硬下界与自调边界（AC:1798-1801）', () => {
  it('下界 = user.original 最大长度 + 余量；余量可覆盖', () => {
    expect(lengthMinTuningBounds(1000).min).toBe(1200)
    expect(lengthMinTuningBounds(1000, 50).min).toBe(1050)
    expect(lengthMinTuningBounds(0, 200).min).toBe(200)
  })

  it('自调不得把 lengthMin 降到该下界以下（越界即 rejected）', () => {
    const bounds = { min: lengthMinTuningBounds(1000).min, max: 8000 }
    expect(applyTuning({ current: 1200, suggestion: 1100, bounds }))
      .toEqual({ ok: false, rejected: true, reason: TUNING_REASON_BELOW_HARD_MIN })
    // 小步上调是合法的。
    const up = applyTuning({ current: 1200, suggestion: 1300, bounds })
    expect(up.ok).toBe(true)
  })
})

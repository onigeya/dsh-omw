/**
 * 策略采纳门的单元测试（Story 7.3 第 1 轮 / AD-20）。
 *
 * 纯函数，0 开库。覆盖 spec 矩阵行 1-10：空 case 集（evidence=none）、全等、逐 case 回归、
 * 多通过一个、丢 check（总分不降也拒）、权重（Must=2）、复算差边界、NaN 夹紧、minConfidence。
 */
import { describe, expect, it } from 'vitest'
import {
  MUST_CHECK_WEIGHT,
  NORMAL_CHECK_WEIGHT,
  RECOMPUTE_TOLERANCE,
  aggregateScore,
  checkWeight,
  evaluateCandidate,
  evaluateCase,
  normalizedScore,
  recomputeMatches,
  type GateCaseInput,
  type StrategyCheck,
} from '../src/strategy/gate'

/** 便捷构造：`p('a', true)` = 普通通过；`m('b', false)` = Must 未通过。 */
function p(id: string, passed: boolean): StrategyCheck {
  return { id, must: false, passed }
}
function m(id: string, passed: boolean): StrategyCheck {
  return { id, must: true, passed }
}

function gateCase(caseId: string, champion: StrategyCheck[], challenger: StrategyCheck[]): GateCaseInput {
  return { caseId, champion, challenger }
}

describe('权重与归一化分数（AC:1482）', () => {
  it('Must=2、普通=1；1 Must 通过 + 1 普通失败 = 2/3', () => {
    expect(MUST_CHECK_WEIGHT).toBe(2)
    expect(NORMAL_CHECK_WEIGHT).toBe(1)
    expect(checkWeight(m('x', false))).toBe(2)
    expect(checkWeight(p('y', false))).toBe(1)
    const score = normalizedScore([m('x', true), p('y', false)])
    expect(score).toBeCloseTo(2 / 3, 12)
  })

  it('空 check 集 ⇒ 0（不是 NaN，也不是 1）', () => {
    expect(normalizedScore([])).toBe(0)
  })

  it('全通过 ⇒ 1；全失败 ⇒ 0', () => {
    expect(normalizedScore([m('a', true), p('b', true)])).toBe(1)
    expect(normalizedScore([m('a', false), p('b', false)])).toBe(0)
  })
})

describe('逐 case 判定（AC:1481）', () => {
  it('全等 ⇒ 非回归且不丢 check', () => {
    const evaluation = evaluateCase('c1', [m('a', true), p('b', false)], [m('a', true), p('b', false)])
    expect(evaluation.nonRegressed).toBe(true)
    expect(evaluation.noLostChecks).toBe(true)
  })

  it('challenger 某 case 分数更低 ⇒ 非回归失败', () => {
    const evaluation = evaluateCase('c1', [m('a', true)], [m('a', false)])
    expect(evaluation.nonRegressed).toBe(false)
    expect(evaluation.challengerScore).toBeLessThan(evaluation.championScore)
  })

  it('challenger 多通过一个 ⇒ 非回归成立、不丢 check', () => {
    const evaluation = evaluateCase('c1', [m('a', true), p('b', false)], [m('a', true), p('b', true)])
    expect(evaluation.nonRegressed).toBe(true)
    expect(evaluation.noLostChecks).toBe(true)
  })

  it('丢了一个 champion 通过的 check（总分不降也拒）', () => {
    // champion: a(Must,通过) + b(普通,失败) = 2/3；challenger: a(Must,通过) + c(普通,通过) = 3/3
    // 分数更高，但 b 被换成 c ⇒ champion 通过的 a 仍在、b 是失败的，所以这里用「a 消失」构造丢 check。
    const evaluation = evaluateCase('c1', [m('a', true), p('b', false)], [p('c', true), p('b', true)])
    expect(evaluation.challengerScore).toBeGreaterThanOrEqual(evaluation.championScore)
    expect(evaluation.noLostChecks).toBe(false)
    expect(evaluation.lostChecks).toEqual(['a'])
  })
})

describe('采纳门主判定（AC:1479-1490）', () => {
  it('空 case 集 ⇒ 不采纳 + evidence=none（AD-20：不得据此宣称有效）', () => {
    const decision = evaluateCandidate({ cases: [], minConfidence: 0.6 })
    expect(decision.adopted).toBe(false)
    expect(decision.evidence).toBe('none')
    expect(decision.reasons[0]).toContain('no-cases')
  })

  it('全等 ⇒ 采纳（非回归 + 分数 ≥ minConfidence）', () => {
    const decision = evaluateCandidate({
      cases: [gateCase('c1', [m('a', true), p('b', true)], [m('a', true), p('b', true)])],
      minConfidence: 0.6,
    })
    expect(decision.adopted).toBe(true)
    expect(decision.challengerScore).toBe(1)
    expect(decision.recomputed).toBe(false)
  })

  it('低于 minConfidence ⇒ 不采纳（即使非回归）', () => {
    const decision = evaluateCandidate({
      cases: [gateCase('c1', [m('a', true), p('b', false), p('c', false)], [m('a', true), p('b', false), p('c', false)])],
      minConfidence: 0.6,
    })
    // 2/(2+1+1) = 0.5 < 0.6
    expect(decision.challengerScore).toBeCloseTo(0.5, 12)
    expect(decision.adopted).toBe(false)
    expect(decision.reasons.some((reason) => reason.includes('minConfidence'))).toBe(true)
  })

  it('逐 case 回归 ⇒ 不采纳且原因点名该 case', () => {
    const decision = evaluateCandidate({
      cases: [
        gateCase('c1', [m('a', true)], [m('a', true)]),
        gateCase('c2', [m('b', true), p('c', true)], [m('b', true), p('c', false)]),
      ],
      minConfidence: 0.6,
    })
    expect(decision.adopted).toBe(false)
    expect(decision.reasons.some((reason) => reason.includes('c2'))).toBe(true)
  })

  it('复算不一致 ⇒ 不采纳（差 ≥ 1e-8）', () => {
    const decision = evaluateCandidate({
      cases: [gateCase('c1', [m('a', true)], [m('a', true)])],
      minConfidence: 0.6,
      recomputedScore: 1 - 1e-8,
    })
    expect(decision.adopted).toBe(false)
    expect(decision.reasons.some((reason) => reason.includes('复算不一致'))).toBe(true)
  })

  it('复算一致（差 1e-9）⇒ 可采纳且 recomputed=true', () => {
    const decision = evaluateCandidate({
      cases: [gateCase('c1', [m('a', true)], [m('a', true)])],
      minConfidence: 0.6,
      recomputedScore: 1 - 1e-9,
    })
    expect(decision.adopted).toBe(true)
    expect(decision.recomputed).toBe(true)
  })

  it('aggregateScore 跨 case 摊平（不是逐 case 平均）', () => {
    const cases = [
      gateCase('c1', [m('a', true), p('b', true)], []),
      gateCase('c2', [p('c', false)], []),
    ]
    // champion 摊平：2+1+1 = 4 权重，通过 3 ⇒ 0.75
    expect(aggregateScore(cases, 'champion')).toBeCloseTo(0.75, 12)
  })
})

describe('复算边界（AC:1486）', () => {
  it('差 < 1e-8 判一致；差 = 1e-8 判不一致；NaN 判不一致', () => {
    expect(RECOMPUTE_TOLERANCE).toBe(1e-8)
    expect(recomputeMatches(0.5, 0.5 + 9e-9)).toBe(true)
    expect(recomputeMatches(0.5, 0.5 + 1e-8)).toBe(false)
    expect(recomputeMatches(Number.NaN, 0.5)).toBe(false)
    expect(recomputeMatches(Number.POSITIVE_INFINITY, 0.5)).toBe(false)
  })
})

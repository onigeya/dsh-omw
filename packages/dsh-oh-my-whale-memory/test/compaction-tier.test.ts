/**
 * 长度三带定档（Story 8.4 / T3、矩阵行 1–5、AC:1713-1721、AC:1798-1801）。
 *
 * 覆盖：两条阈值的边界（含左右闭开）、受保护内容短路优先、判据缺失/NaN 的 fail-closed
 * （不抛）、`(sessionId, compactionId)` 重放时用同一份 criteria 得到逐位相同的档位、
 * 以及 `lengthMin` 硬下界（低于 ⇒ 拒绝，不静默夹紧）。
 */
import { describe, expect, it } from 'vitest'
import { renderRegionText } from '../src/context/compaction-t1'
import { estimateTokens } from '../src/context/fold'
import { DEFAULT_PURIFY_OPTIONS, purifyText } from '../src/context/purify'
import {
  LENGTH_MIN_SAFETY_MARGIN_TOKENS,
  TIER_REASON_BELOW_LENGTH_MIN,
  TIER_REASON_CRITERIA_UNAVAILABLE,
  TIER_REASON_LENGTH_MIN_FLOOR,
  TIER_REASON_MID_BAND,
  TIER_REASON_PROTECTED,
  TIER_REASON_T3_CANDIDATE,
  TIER_REASON_TOKENS_INVALID,
  checkLengthMinFloor,
  decideTier,
  isCriteriaUsable,
  planRegionTier,
} from '../src/context/compaction-tier'
import type { T1MessageLike } from '../src/context/compaction-t1'
import { SKELETON_SOURCE_KIND } from '../src/shared/injection-vocab'

const CRITERIA = { lengthMin: 1200, t3Threshold: 8000 }

describe('矩阵行 1：< lengthMin ⇒ T1；= lengthMin ⇒ T2', () => {
  it('lengthMin - 1 / lengthMin 两个边界', () => {
    expect(decideTier({ tokens: CRITERIA.lengthMin - 1 }, CRITERIA)).toEqual({
      tier: 'T1',
      reason: TIER_REASON_BELOW_LENGTH_MIN,
    })
    expect(decideTier({ tokens: CRITERIA.lengthMin }, CRITERIA)).toEqual({
      tier: 'T2',
      reason: TIER_REASON_MID_BAND,
    })
  })

  it('覆盖非默认阈值（Config 运行期覆盖后同一函数仍正确）', () => {
    const crit = { lengthMin: 50, t3Threshold: 100 }
    expect(decideTier({ tokens: 49 }, crit).tier).toBe('T1')
    expect(decideTier({ tokens: 50 }, crit).tier).toBe('T2')
  })
})

describe('矩阵行 2：< t3Threshold ⇒ T2；= t3Threshold ⇒ T3', () => {
  it('t3Threshold - 1 / t3Threshold 两个边界', () => {
    expect(decideTier({ tokens: CRITERIA.t3Threshold - 1 }, CRITERIA)).toEqual({
      tier: 'T2',
      reason: TIER_REASON_MID_BAND,
    })
    expect(decideTier({ tokens: CRITERIA.t3Threshold }, CRITERIA)).toEqual({
      tier: 'T3',
      reason: TIER_REASON_T3_CANDIDATE,
    })
  })

  it('远超阈值仍是 T3（上带无上限）', () => {
    expect(decideTier({ tokens: 10_000_000 }, CRITERIA).tier).toBe('T3')
  })
})

describe('矩阵行 3：受保护内容短路优先于长度', () => {
  it('任意长度 + protectedContent ⇒ T1', () => {
    for (const tokens of [0, 1, CRITERIA.lengthMin, 5000, 50_000]) {
      expect(decideTier({ tokens, protectedContent: true }, CRITERIA)).toEqual({
        tier: 'T1',
        reason: TIER_REASON_PROTECTED,
      })
    }
  })

  it('短路优先于「判据算不出」：两者同时成立时理由仍是受保护', () => {
    expect(decideTier({ tokens: 999, protectedContent: true }, null)).toEqual({
      tier: 'T1',
      reason: TIER_REASON_PROTECTED,
    })
  })
})

describe('矩阵行 4：判据缺字段 / NaN ⇒ T1，不抛', () => {
  const badCriteria: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['lengthMin=NaN', { lengthMin: Number.NaN, t3Threshold: 8000 }],
    ['t3Threshold=Infinity', { lengthMin: 1200, t3Threshold: Number.POSITIVE_INFINITY }],
    ['lengthMin=0', { lengthMin: 0, t3Threshold: 8000 }],
    ['三带反转', { lengthMin: 8000, t3Threshold: 1200 }],
    ['两侧相等', { lengthMin: 1200, t3Threshold: 1200 }],
  ]

  it('全部归 T1 且 reason=criteria-unavailable', () => {
    for (const [label, criteria] of badCriteria) {
      expect(() => decideTier({ tokens: 9999 }, criteria as never), label).not.toThrow()
      expect(decideTier({ tokens: 9999 }, criteria as never), label).toEqual({
        tier: 'T1',
        reason: TIER_REASON_CRITERIA_UNAVAILABLE,
      })
      expect(isCriteriaUsable(criteria as never), label).toBe(false)
    }
  })

  it('tokens 非法（NaN / Infinity / 负数）⇒ T1，不按长度分带', () => {
    for (const tokens of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(decideTier({ tokens }, CRITERIA)).toEqual({ tier: 'T1', reason: TIER_REASON_TOKENS_INVALID })
    }
    // 0 是合法长度（空区间）：按三带归 T1，理由不是 tokens-invalid。
    expect(decideTier({ tokens: 0 }, CRITERIA)).toEqual({ tier: 'T1', reason: TIER_REASON_BELOW_LENGTH_MIN })
  })
})

describe('矩阵行 5：同一 (sessionId, compactionId) 重放 ⇒ 档位逐位相同', () => {
  it('同一份 criteria（含 JSON 往返）给出完全相同的决定', () => {
    // AD-26：重放读的是 compaction_run.config_snapshot_json 里的 criteria，不是当前 Config。
    const snapshot = JSON.parse(JSON.stringify({ criteria: CRITERIA, sessionId: 's-1', compactionId: 'c-1' }))
    const inputs = [0, 1199, 1200, 7999, 8000, 99_999]
    for (const tokens of inputs) {
      const first = decideTier({ tokens }, snapshot.criteria)
      const second = decideTier({ tokens }, snapshot.criteria)
      expect(second).toEqual(first)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    }
  })

  it('判据变化会改变结果（证明上面的「相同」不是恒等）', () => {
    const tokens = 3000
    expect(decideTier({ tokens }, { lengthMin: 1200, t3Threshold: 8000 }).tier).toBe('T2')
    expect(decideTier({ tokens }, { lengthMin: 1200, t3Threshold: 2000 }).tier).toBe('T3')
  })
})

describe('lengthMin 硬下界（AC:1798-1801：不用分位数、不静默夹紧）', () => {  it('= 最大值 + 余量 ⇒ 通过；差 1 ⇒ 拒绝并报出 requiredMin', () => {
    const maxUserOriginalTokens = 1000
    const required = maxUserOriginalTokens + LENGTH_MIN_SAFETY_MARGIN_TOKENS
    expect(checkLengthMinFloor({ lengthMin: required, maxUserOriginalTokens })).toEqual({ ok: true, requiredMin: required })
    const rejected = checkLengthMinFloor({ lengthMin: required - 1, maxUserOriginalTokens })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.reason).toBe(TIER_REASON_LENGTH_MIN_FLOOR)
      expect(rejected.requiredMin).toBe(required)
    }
  })

  it('余量可覆盖；无 user 原话时下界就是余量本身', () => {
    expect(checkLengthMinFloor({ lengthMin: 10, maxUserOriginalTokens: 0, marginTokens: 10 })).toEqual({
      ok: true,
      requiredMin: 10,
    })
    expect(checkLengthMinFloor({ lengthMin: 9, maxUserOriginalTokens: 0, marginTokens: 10 }).ok).toBe(false)
  })

  it('非法 lengthMin（NaN）同样拒绝，不抛', () => {
    const rejected = checkLengthMinFloor({ lengthMin: Number.NaN, maxUserOriginalTokens: 0 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe(TIER_REASON_LENGTH_MIN_FLOOR)
  })
})

describe('planRegionTier：区间定档（长度三带 + 硬下界的组合入口）', () => {
  const assistantText = (size: number): T1MessageLike => ({ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(size) }] })
  const userText = (text: string): T1MessageLike => ({ role: 'user', content: [{ type: 'text', text }] })

  it('短区间即使没有 user 原话也归 T1（长度三带优先于 role 分类）', () => {
    const plan = planRegionTier({ messages: [assistantText(10)], criteria: CRITERIA })
    expect(plan.tier).toBe('T1')
    expect(plan.reason).toBe(TIER_REASON_BELOW_LENGTH_MIN)
    expect(plan.protectedContent).toBe(false)
    expect(plan.tokens).toBeGreaterThan(0)
    // 下界总是可观测：无 user 原话时它等于安全余量本身。
    expect(plan.requiredMin).toBe(LENGTH_MIN_SAFETY_MARGIN_TOKENS)
  })

  it('长区间（无 user 原话）按 t3Threshold 进 T2 / T3', () => {
    // estimateTokens：非 CJK 按 4 字符 1 token 折算。
    expect(planRegionTier({ messages: [assistantText(6000)], criteria: CRITERIA }).tier).toBe('T2')
    expect(planRegionTier({ messages: [assistantText(40_000)], criteria: CRITERIA }).tier).toBe('T3')
  })

  it('user 原话 ⇒ T1 且 protectedContent=true（不论长度）', () => {
    const plan = planRegionTier({ messages: [assistantText(40_000), userText('别忘这件事')], criteria: CRITERIA })
    expect(plan.tier).toBe('T1')
    expect(plan.reason).toBe(TIER_REASON_PROTECTED)
    expect(plan.protectedContent).toBe(true)
  })

  it('user 原话超过 lengthMin - 余量 ⇒ 下界越界可见；受保护内容仍短路成 T1', () => {    // 一条约 1500 token 的 user 原话 + 余量 200 > lengthMin 1200 ⇒ 越界。
    const longUser = 'u'.repeat(6000)
    const plan = planRegionTier({ messages: [assistantText(40_000), userText(longUser)], criteria: CRITERIA })
    expect(plan.tier).toBe('T1')
    expect(plan.reason).toBe(TIER_REASON_PROTECTED)
    // 下界是可观测证据：requiredMin 超过配置的 lengthMin，说明这份 lengthMin 撑不住真实语料。
    expect(plan.requiredMin).toBeGreaterThan(CRITERIA.lengthMin)

    // 没有 user 原话时，下界本身就能把判据否成 T1（不静默夹紧 lengthMin）。
    const floorOnly = planRegionTier({ messages: [assistantText(40_000)], criteria: { lengthMin: 100, t3Threshold: 8000 } })
    expect(floorOnly.tier).toBe('T1')
    expect(floorOnly.reason).toBe(TIER_REASON_LENGTH_MIN_FLOOR)
    expect(floorOnly.requiredMin).toBe(LENGTH_MIN_SAFETY_MARGIN_TOKENS)
  })

  it('动态骨架消息 ⇒ T1 且 protectedContent=true（Story 8.5 / T4：骨架不计可压预算）', () => {
    const skeleton: T1MessageLike = {
      role: 'assistant',
      content: [{ type: 'text', text: '记忆骨架（本会话不可删）' }],
      source: { kind: SKELETON_SOURCE_KIND },
    }
    const plan = planRegionTier({ messages: [assistantText(40_000), skeleton], criteria: CRITERIA })
    expect(plan.tier).toBe('T1')
    expect(plan.reason).toBe(TIER_REASON_PROTECTED)
    expect(plan.protectedContent).toBe(true)
  })

  it('判据缺失 ⇒ T1 且不做硬下界计算（不抛）', () => {
    expect(planRegionTier({ messages: [assistantText(40_000)], criteria: null })).toMatchObject({
      tier: 'T1',
      reason: TIER_REASON_CRITERIA_UNAVAILABLE,
      requiredMin: 0,
    })
  })
})

describe('Story 8.6 / T6：档位判据与净化解耦（矩阵行 13 / INV-16）', () => {
  /** 高填充密度的一段：净化后 token 数会跌进下带。 */
  const DIRTY = [
    ...Array.from({ length: 40 }, () => 'Let me…'),
    ...Array.from({ length: 6 }, () => 'Repeated statement line for the collapse rule.'),
    'The migration ordering is documented in AD-34 and the schema version must equal the largest migration number in the migrations directory.',
    'Compaction keeps the retained tail and prices every decision with the effective token meter so the budget stays honest.',
  ].join('\n')

  const dirtyMessage = (): T1MessageLike => ({ role: 'assistant', content: [{ type: 'text', text: DIRTY }] })

  it('用净化后文本算会改档，但 planRegionTier 只读原文 ⇒ 净化前后档位不变', () => {
    const message = dirtyMessage()
    const rawTokens = estimateTokens(renderRegionText([message]))
    const purified = purifyText(DIRTY, DEFAULT_PURIFY_OPTIONS)
    const purifiedTokens = estimateTokens(purified.text)

    // 构造「原文落 T2、净化后落 T1」的三带
    const criteria = { lengthMin: 200, t3Threshold: rawTokens + 20 }
    expect(rawTokens).toBeGreaterThan(200)
    expect(purified.changed).toBe(true)
    expect(purifiedTokens).toBeLessThan(200)

    // 判据入口只看原文 ⇒ T2（不会因为净化变短而折成 T1）
    const plan = planRegionTier({ messages: [message], criteria })
    expect(plan.tier).toBe('T2')
    expect(plan.reason).toBe(TIER_REASON_MID_BAND)
    expect(plan.tokens).toBe(rawTokens)

    // 反证：若拿净化后的 token 去判，会掉到下带（这正是 INV-16 禁止的耦合）
    expect(decideTier({ tokens: purifiedTokens }, criteria).tier).toBe('T1')
  })

  it('受保护内容判据也在原文上算：净化不改 classifyT1 的结论', () => {
    const criteria = { lengthMin: 200, t3Threshold: 100_000 }
    const plan = planRegionTier({ messages: [dirtyMessage()], criteria })
    expect(plan.protectedContent).toBe(false)
    expect(plan.tier).toBe('T2')
  })
})
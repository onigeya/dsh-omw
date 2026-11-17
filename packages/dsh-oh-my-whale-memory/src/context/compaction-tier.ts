/**
 * 长度三带定档（Story 8.4 / T3、AC:1713-1721、INV-3、INV-12）。
 *
 * **纯函数、零宿主依赖、零 LLM**：同步压缩路径的档位只由代码侧确定性判据决定
 * （NFR17 / AD-7：LLM 只做分段，且只在空闲闸门内异步跑）。
 *
 * 判定顺序（先短路、后分带）：
 * 1. 受保护内容（user 原话 / system 消息 / `priority=-1` / `kind=instruction`）⇒ **T1**，
 *    且不计入可压预算（AC:1693-1695：短路规则优先于熵与长度）；
 * 2. 判据算不出（缺字段 / NaN / 非法三带）⇒ **T1 fail-closed**，不抛（AC:1697-1699）；
 * 3. 否则 `< lengthMin ⇒ T1`、`[lengthMin, t3Threshold) ⇒ T2`、`>= t3Threshold ⇒ T3`。
 *
 * 阈值来自 Config（`.volatile()`，运行期可覆盖，INV-12），本模块不写死任何数字；
 * `lengthMin` 的**硬下界**（不得低于滚动窗口内 `user.original` 最大长度 + 余量，AC:1798-1801）
 * 由调用方用 {@link checkLengthMinFloor} 校验——越界即拒绝该判据，不静默夹紧。
 */
import type { CompactionTier } from './compaction-plan.js'
import { classifyT1, regionMessages, renderRegionText, type T1MessageLike } from './compaction-t1.js'
import { estimateTokens } from './fold.js'

/** 判据：两条长度阈值（tokens）。字段可缺省，缺省即「算不出」⇒ T1。 */
export interface CompactionCriteria {
  readonly lengthMin?: number | null
  readonly t3Threshold?: number | null
}

export interface TierInput {
  /** 区间 token 数（调用方按同一 token 估算口径算好）。 */
  readonly tokens: number
  /**
   * 区间内是否含受保护内容：user-role 原话 / system 消息 / `priority=-1` / `kind=instruction`。
   * 缺省 false（调用方必须显式传入「已判定没有」）。
   */
  readonly protectedContent?: boolean
}

export interface TierDecision {
  readonly tier: CompactionTier
  /** 判定理由（可读、进 `compaction_run.plan_json` 与审计）。 */
  readonly reason: string
}

/** 理由常量：测试与账本都按这些串断言/统计，别在别处另写字面量。 */
export const TIER_REASON_PROTECTED = 'protected-content'
export const TIER_REASON_TOKENS_INVALID = 'tokens-invalid'
export const TIER_REASON_CRITERIA_UNAVAILABLE = 'criteria-unavailable'
export const TIER_REASON_LENGTH_MIN_FLOOR = 'length-min-below-floor'
export const TIER_REASON_BELOW_LENGTH_MIN = 'below-length-min'
export const TIER_REASON_MID_BAND = 'mid-band'
export const TIER_REASON_T3_CANDIDATE = 't3-candidate'

/** 判据是否可用：两条阈值都是有限正数，且构成合法三带（lengthMin < t3Threshold）。 */
export function isCriteriaUsable(criteria: CompactionCriteria | null | undefined): boolean {
  if (criteria === null || criteria === undefined) return false
  const { lengthMin, t3Threshold } = criteria
  if (typeof lengthMin !== 'number' || !Number.isFinite(lengthMin) || lengthMin <= 0) return false
  if (typeof t3Threshold !== 'number' || !Number.isFinite(t3Threshold)) return false
  // 相等/反转会让 `[lengthMin, t3Threshold)` 成空集、T3 抢走 T1 下带：不是合法三带。
  return t3Threshold > lengthMin
}

/**
 * 决定一个区间的档位。**不抛错**（fail-closed 到 T1）：判据问题不得把「保守不压」变成异常。
 */
export function decideTier(input: TierInput, criteria: CompactionCriteria | null | undefined): TierDecision {
  if (input.protectedContent === true) {
    return { tier: 'T1', reason: TIER_REASON_PROTECTED }
  }
  const tokens = input.tokens
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    return { tier: 'T1', reason: TIER_REASON_TOKENS_INVALID }
  }
  if (!isCriteriaUsable(criteria)) {
    return { tier: 'T1', reason: TIER_REASON_CRITERIA_UNAVAILABLE }
  }
  // 到这里两条阈值都是有限正数且 lengthMin < t3Threshold。
  const lengthMin = (criteria as CompactionCriteria).lengthMin as number
  const t3Threshold = (criteria as CompactionCriteria).t3Threshold as number
  if (tokens < lengthMin) return { tier: 'T1', reason: TIER_REASON_BELOW_LENGTH_MIN }
  if (tokens < t3Threshold) return { tier: 'T2', reason: TIER_REASON_MID_BAND }
  return { tier: 'T3', reason: TIER_REASON_T3_CANDIDATE }
}

/**
 * `lengthMin` 相对滚动窗口内 `user.original` 最大长度的安全余量（tokens）。
 *
 * **经验值**（AC:1806 的标注要求）：没有语料标定，取一个足以容纳 role 头与渲染换行的常量；
 * 它不是阈值本身（阈值仍来自 Config），只在硬下界校验里用。
 */
export const LENGTH_MIN_SAFETY_MARGIN_TOKENS = 200

export interface LengthMinFloorInput {
  /** Config 里的 `compactionLengthMin`。 */
  readonly lengthMin: number
  /** 滚动窗口内 `user.original` 的最大长度（tokens；调用方按同一估算口径算）。 */
  readonly maxUserOriginalTokens: number
  readonly marginTokens?: number
}

export type LengthMinFloorCheck =
  | { readonly ok: true, readonly requiredMin: number }
  | { readonly ok: false, readonly reason: string, readonly requiredMin: number }

/**
 * 阈值硬下界（AC:1798-1801）：`lengthMin >= 滚动窗口 user.original 最大长度 + 余量`。
 *
 * **不用分位数**（AC 逐字要求）；越界返回 `ok:false` 由调用方拒绝该判据（fail-closed 到 T1），
 * 不在这里夹紧成合法值。
 */
export function checkLengthMinFloor(input: LengthMinFloorInput): LengthMinFloorCheck {
  const margin = typeof input.marginTokens === 'number' && Number.isFinite(input.marginTokens) && input.marginTokens >= 0
    ? input.marginTokens
    : LENGTH_MIN_SAFETY_MARGIN_TOKENS
  const maxUser = Number.isFinite(input.maxUserOriginalTokens) && input.maxUserOriginalTokens > 0
    ? input.maxUserOriginalTokens
    : 0
  const requiredMin = maxUser + margin
  const current = Number.isFinite(input.lengthMin) ? input.lengthMin : Number.NaN
  if (!Number.isFinite(current) || current < requiredMin) {
    return { ok: false, reason: TIER_REASON_LENGTH_MIN_FLOOR, requiredMin }
  }
  return { ok: true, requiredMin }
}

/**
 * 滚动窗口（本区间）内 `user.original` 的最大长度（tokens）。
 *
 * 只算 role === 'user' 的消息（system head 已由 `renderRegionText` 去掉）；渲染口径与
 * 句柄正文一致，避免「判据用一套、折叠用另一套」。没有任何 user 消息时返回 0。
 */
export function maxUserOriginalTokens(messages: readonly T1MessageLike[]): number {
  let max = 0
  for (const message of regionMessages(messages)) {
    if (message.role !== 'user') continue
    const tokens = estimateTokens(renderRegionText([message]))
    if (tokens > max) max = tokens
  }
  return max
}

/** 一个区间的定档结果（含可观测证据）。 */
export interface RegionTierPlan {
  readonly tier: CompactionTier
  readonly reason: string
  /** 区间 token 数（T1 折叠正文的估算口径）。 */
  readonly tokens: number
  readonly protectedContent: boolean
  /** 硬下界：`lengthMin` 至少应为多少（未触发校验时为 0）。 */
  readonly requiredMin: number
}

/**
 * 把一个区间定档（`decideTier` + `lengthMin` 硬下界的组合，供压缩引擎一次调用）。
 *
 * 硬下界越界**不夹紧阈值**：把该区间降成 T1（不压）并把理由记成 `length-min-below-floor`，
 * 让越界在账本上可见（AC:1798-1801）。
 */
export function planRegionTier(input: {
  readonly messages: readonly T1MessageLike[]
  readonly criteria: CompactionCriteria | null | undefined
}): RegionTierPlan {
  const tokens = estimateTokens(renderRegionText(input.messages))
  const protectedContent = classifyT1(input.messages)
  let decision = decideTier({ tokens, protectedContent }, input.criteria)
  let requiredMin = 0
  if (isCriteriaUsable(input.criteria)) {
    // 硬下界总是算（即使本区间已因受保护内容短路成 T1）：`requiredMin` 是可观测证据，
    // 用于回答「这份 lengthMin 相对真实语料够不够」，不能只在会改判的分支里算。
    const floor = checkLengthMinFloor({
      lengthMin: (input.criteria as CompactionCriteria).lengthMin as number,
      maxUserOriginalTokens: maxUserOriginalTokens(input.messages),
    })
    requiredMin = floor.requiredMin
    if (!floor.ok && decision.tier !== 'T1') decision = { tier: 'T1', reason: floor.reason }
  }
  return { ...decision, tokens, protectedContent, requiredMin }
}

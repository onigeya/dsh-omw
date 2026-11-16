/**
 * champion-challenger 采纳门（Story 7.3 / AD-20、FR-21）。
 *
 * 三条判据（AD-20 逐字）：
 * 1. **逐 case 非回归**：challenger 在每个 case 上的判定不差于 champion；
 * 2. **不丢既有通过 check**：champion 通过的 check，challenger 必须仍通过（即便总分不降也拒）；
 * 3. **分数判据**：归一化分数 = Σ通过 check 权重 / Σ全部权重（Must = 2、普通 = 1）；低于
 *    `strategyGate.minConfidence`（默认 0.6）不采纳；同一候选两次独立计算差 **< 1e-8** 才可信。
 *
 * 空 case 集是**允许的降级态**（AD-20 末段）：采纳门退化为「不回归既有 champion」，裁决记
 * `evidence: 'none'`，**不得据此宣称策略有效**；本模块因此返回 `adopted: false`（没有证据就不是采纳）。
 *
 * 纯函数：无 I/O、无时钟、无随机；分数用 `number` 但对外只暴露有限值（NaN 一律夹紧为 0）。
 */

/** Must 检查的权重（AD-20：Must=2）。 */
export const MUST_CHECK_WEIGHT = 2
/** 普通检查的权重（AD-20：普通=1）。 */
export const NORMAL_CHECK_WEIGHT = 1
/** 复算一致的阈值（AD-20：差 < 1e-8）。 */
export const RECOMPUTE_TOLERANCE = 1e-8

export interface StrategyCheck {
  readonly id: string
  /** Must 检查（权重 2）；非 Must 权重 1。 */
  readonly must: boolean
  readonly passed: boolean
}

export interface StrategyCaseResult {
  readonly caseId: string
  readonly checks: readonly StrategyCheck[]
}

/** 单个 case 的逐项判定结果。 */
export interface CaseEvaluation {
  readonly caseId: string
  /** challenger 的分数不差于 champion。 */
  readonly nonRegressed: boolean
  /** champion 通过的 check，challenger 全部仍通过。 */
  readonly noLostChecks: boolean
  readonly championScore: number
  readonly challengerScore: number
  /** 丢掉的 check id（`noLostChecks=false` 时用于 status/reason）。 */
  readonly lostChecks: readonly string[]
}

export function checkWeight(check: StrategyCheck): number {
  return check.must ? MUST_CHECK_WEIGHT : NORMAL_CHECK_WEIGHT
}

/**
 * 归一化分数：Σ(通过 check 权重) / Σ(全部 check 权重)。
 * 空 check 集返回 0（**不是** NaN，也不是 1 —— 「没有判据」不能当作「全通过」）。
 */
export function normalizedScore(checks: readonly StrategyCheck[]): number {
  let total = 0
  let passed = 0
  for (const check of checks) {
    const weight = checkWeight(check)
    total += weight
    if (check.passed) passed += weight
  }
  if (total === 0) return 0
  return passed / total
}

/** 逐 case 判定：非回归 + 不丢既有通过 check。 */
export function evaluateCase(
  caseId: string,
  champion: readonly StrategyCheck[],
  challenger: readonly StrategyCheck[],
): CaseEvaluation {
  const championScore = normalizedScore(champion)
  const challengerScore = normalizedScore(challenger)
  // 丢 check：champion 通过的 id 在 challenger 里必须仍通过（按 id 匹配；缺失也算丢）。
  const challengerById = new Map(challenger.map((check) => [check.id, check.passed]))
  const lostChecks = champion
    .filter((check) => check.passed && challengerById.get(check.id) !== true)
    .map((check) => check.id)
  return {
    caseId,
    nonRegressed: challengerScore >= championScore,
    noLostChecks: lostChecks.length === 0,
    championScore,
    challengerScore,
    lostChecks,
  }
}

/** 两次独立计算的分数是否一致（严格小于 1e-8；任一非有限值都判不一致）。 */
export function recomputeMatches(first: number, second: number): boolean {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false
  return Math.abs(first - second) < RECOMPUTE_TOLERANCE
}

export interface GateCaseInput {
  readonly caseId: string
  readonly champion: readonly StrategyCheck[]
  readonly challenger: readonly StrategyCheck[]
}

export interface GateInput {
  readonly cases: readonly GateCaseInput[]
  /** `strategyGate.minConfidence`（默认 0.6）。 */
  readonly minConfidence: number
  /**
   * 第二次独立计算得到的 challenger 总分（双重哈希回测的复算值）。省略 = 不做复算校验，
   * 此时 `recomputed === false`（调用方应在可见面标注「仅单次计算」）。
   */
  readonly recomputedScore?: number
}

export type GateEvidence = 'none' | 'measured'

export interface GateDecision {
  readonly adopted: boolean
  /** challenger 的总体归一化分数（跨 case 汇总）。 */
  readonly challengerScore: number
  /** champion 的总体归一化分数。 */
  readonly championScore: number
  readonly evidence: GateEvidence
  readonly recomputed: boolean
  /** 未采纳/降级的原因（按判定顺序，首个阻断原因在最前）。 */
  readonly reasons: readonly string[]
  readonly cases: readonly CaseEvaluation[]
}

/** 跨 case 汇总：把所有 check **摊平**后按权重求和（AD-20 的公式是「Σ通过权重/Σ全部权重」）。 */
export function aggregateScore(cases: readonly GateCaseInput[], side: 'champion' | 'challenger'): number {
  const all = cases.flatMap((entry) => entry[side])
  return normalizedScore(all)
}

/**
 * 采纳门主判定。顺序：空 case 集 → 逐 case 非回归/不丢 check → 分数下限 → 复算一致。
 */
export function evaluateCandidate(input: GateInput): GateDecision {
  const championScore = aggregateScore(input.cases, 'champion')
  const challengerScore = aggregateScore(input.cases, 'challenger')
  const cases = input.cases.map((entry) => evaluateCase(entry.caseId, entry.champion, entry.challenger))
  const reasons: string[] = []

  if (input.cases.length === 0) {
    return {
      adopted: false,
      challengerScore,
      championScore,
      evidence: 'none',
      recomputed: false,
      reasons: ['no-cases：无 case 集，采纳门退化为「不回归既有 champion」，不得据此宣称有效'],
      cases,
    }
  }

  for (const evaluation of cases) {
    if (!evaluation.nonRegressed) {
      reasons.push(`case ${evaluation.caseId}：分数回归 ${evaluation.challengerScore.toFixed(6)} < ${evaluation.championScore.toFixed(6)}`)
    }
    if (!evaluation.noLostChecks) {
      reasons.push(`case ${evaluation.caseId}：丢失既有通过 check（${evaluation.lostChecks.join(', ')}）`)
    }
  }
  if (challengerScore < input.minConfidence) {
    reasons.push(`分数低于 minConfidence：${challengerScore.toFixed(6)} < ${input.minConfidence.toFixed(6)}`)
  }
  const recomputed = input.recomputedScore !== undefined
  // AD-20：「必须对既有 champion 做**两轮独立回测**」；评审 R73 第 2 条指出原先省略复算仍可采纳，
  // 等于把强制判据降级为调用方自觉。这里改为「未提供复算值 ⇒ 不采纳」，并在 reasons 里说明。
  if (!recomputed) {
    reasons.push('no-recompute：缺少第二次独立计算，按 AD-20 不得采纳（回测必须两轮）')
  }
  if (input.recomputedScore !== undefined && !recomputeMatches(challengerScore, input.recomputedScore)) {
    reasons.push(
      `复算不一致：${challengerScore.toFixed(12)} vs ${input.recomputedScore.toFixed(12)}（差 ≥ ${RECOMPUTE_TOLERANCE}）`,
    )
  }

  return {
    adopted: reasons.length === 0,
    challengerScore,
    championScore,
    evidence: 'measured',
    recomputed,
    reasons,
    cases,
  }
}

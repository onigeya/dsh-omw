/**
 * 压缩分档计划器（Story 8.3 第 1 轮 / AC:1693-1699、AC:1709-1711）。
 *
 * **纯函数、零宿主依赖**：输入是一段段的「候选区间 + 已算好的特征」，输出是每段该走哪一档、
 * 以及本次到底压不压。这样分档规则可以完全脱离宿主测试，等装配面（G2/spike-13）落地后
 * 再接 `CompactionEngine` 的公开方法。
 *
 * 三条纪律：
 * 1. **T1 短路优先于一切**（AC:1693-1695）：段内含 user 原话 / system 消息 / 受保护记忆
 *    （`priority=-1` 或 `kind=instruction`）⇒ 直接 T1，且**不计入可压预算**；
 * 2. **判据算不出 ⇒ T1 不压**（AC:1697-1699）：分档失败时宁可不压（与 fail-open 方向相反，
 *    因为「压了」是不可逆的内容损失）；
 * 3. **边界不平衡 ⇒ 整次放弃**（AC:1687 / INV-10）：stock 的 `compactRegion` 会直接抛错，
 *    我们不能假设它会被修好，所以提前 skip。
 *
 * T1 的交错策略留成**显式参数**（见 `interleavedPolicy`）：这是 spec-8-3 §2 的待裁决项，
 * 默认 `skip`（fail-closed），裁决后改一行即可切到 `fold-protected`。
 */

/** 三个档位。T1 不改写内容（无损折叠），T2/T3 允许摘要压缩。 */
export type CompactionTier = 'T1' | 'T2' | 'T3'

/** 输入：一个候选区间及其特征（特征由调用方从 distinct 的来源算好，本模块不读库）。 */
export interface CompactionSegment {
  /** 区间起点 seq（含）。 */
  readonly start: number
  /** 区间终点 seq（含）。 */
  readonly end: number
  readonly tokens: number
  /** 段内含 user-role 原话（AC:1695 短路条件之一）。 */
  readonly hasUserUtterance: boolean
  /** 段内含 system 消息（AC:1695 短路条件之一）。 */
  readonly hasSystemMessage: boolean
  /** 段内含受保护记忆：`priority=-1` 或 `kind=instruction`（AC:1695）。 */
  readonly hasProtectedMemory: boolean
  /** 熵判据；`null`/`undefined` = 算不出 ⇒ T1。 */
  readonly entropy?: number | null
  /** 起点是否 tool-call/result 平衡（调用方用 `toolPairingBalancedBefore` 判定）。 */
  readonly balancedStart: boolean
  /** 终点是否平衡（调用方用 `toolPairingBalancedAfter` 判定）。 */
  readonly balancedEnd: boolean
}

export interface CompactionTierDecision {
  readonly start: number
  readonly end: number
  readonly tier: CompactionTier
  /** 判定理由（可读，进账本）。 */
  readonly reason: string
}

export interface CompactionPlanOptions {
  /** 熵低于该值的段归 T2（可压），否则归 T3。 */
  readonly lowEntropyThreshold?: number
  /**
   * T1 段夹在可压段之间时的处理：
   * - `skip`（默认）：整次放弃压缩（fail-closed，最保守）；
   * - `fold-protected`：整段交给 stock 压，T1 段靠句柄折叠在执行副本上保护
   *   （**偏离 AC:1695 的字面**，需裁决后启用）。
   */
  readonly interleavedPolicy?: 'skip' | 'fold-protected'
}

export interface CompactionPlan {
  readonly decisions: readonly CompactionTierDecision[]
  /** 布局：全部可压 = `contiguous`；有 T1 夹在中间 = `interleaved`；无可压段 = `none`。 */
  readonly layout: 'contiguous' | 'interleaved' | 'none'
  readonly decision: 'compact' | 'skip'
  /** skip 的原因（compact 时为 null）。 */
  readonly reason: string | null
  /** 可压预算（T2/T3 的 tokens 之和，**不含 T1**）。 */
  readonly compactableTokens: number
  /** 受保护（T1）的 tokens 之和，仅用于可观测性。 */
  readonly protectedTokens: number
}

export const DEFAULT_LOW_ENTROPY_THRESHOLD = 0.35

function classify(segment: CompactionSegment, lowEntropyThreshold: number): CompactionTierDecision {
  const span = { start: segment.start, end: segment.end }
  if (segment.hasUserUtterance) return { ...span, tier: 'T1', reason: 'user-utterance' }
  if (segment.hasSystemMessage) return { ...span, tier: 'T1', reason: 'system-message' }
  if (segment.hasProtectedMemory) return { ...span, tier: 'T1', reason: 'protected-memory' }
  if (segment.entropy === null || segment.entropy === undefined || !Number.isFinite(segment.entropy)) {
    // 判据算不出：不压（AC:1697-1699）。
    return { ...span, tier: 'T1', reason: 'criterion-unavailable' }
  }
  if (segment.entropy < lowEntropyThreshold) return { ...span, tier: 'T2', reason: 'low-entropy' }
  return { ...span, tier: 'T3', reason: 'high-entropy' }
}

/**
 * 计算一次压缩的分档计划。**不抛错**（除入参明显非法时返回 skip）：
 * 分档器位于压缩决策路径上，抛错会把「保守不压」变成「异常」。
 */
export function planCompaction(
  segments: readonly CompactionSegment[],
  options: CompactionPlanOptions = {},
): CompactionPlan {
  const threshold = Number.isFinite(options.lowEntropyThreshold)
    ? Math.trunc(options.lowEntropyThreshold as number)
    : DEFAULT_LOW_ENTROPY_THRESHOLD
  const policy = options.interleavedPolicy ?? 'skip'

  if (segments.length === 0) {
    return { decisions: [], layout: 'none', decision: 'skip', reason: 'no-segments', compactableTokens: 0, protectedTokens: 0 }
  }

  // 边界不平衡 ⇒ stock 的 compactRegion 会抛「would split a step」；整次放弃（INV-10）。
  const unbalanced = segments.find((segment) => !segment.balancedStart || !segment.balancedEnd)
  if (unbalanced !== undefined) {
    return {
      decisions: segments.map((segment) => classify(segment, threshold)),
      layout: 'none',
      decision: 'skip',
      reason: 'unbalanced-boundary',
      compactableTokens: 0,
      protectedTokens: 0,
    }
  }

  const decisions = segments.map((segment) => classify(segment, threshold))
  let compactableTokens = 0
  let protectedTokens = 0
  let seenCompactable = false
  let interleaved = false
  let protectedBetween = false
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index] as CompactionTierDecision
    const tokens = segments[index]?.tokens ?? 0
    if (decision.tier === 'T1') {
      protectedTokens += tokens
      if (seenCompactable) protectedBetween = true
      continue
    }
    compactableTokens += tokens
    if (protectedBetween) interleaved = true
    seenCompactable = true
  }

  if (!seenCompactable) {
    return { decisions, layout: 'none', decision: 'skip', reason: 'no-compactable-segment', compactableTokens: 0, protectedTokens }
  }
  if (interleaved) {
    if (policy === 'skip') {
      return { decisions, layout: 'interleaved', decision: 'skip', reason: 'interleaved-protected', compactableTokens, protectedTokens }
    }
    return { decisions, layout: 'interleaved', decision: 'compact', reason: null, compactableTokens, protectedTokens }
  }
  return { decisions, layout: 'contiguous', decision: 'compact', reason: null, compactableTokens, protectedTokens }
}

/** 计划要压哪些连续区间（供 8.3 第 2 轮调 `super.compactRegion`）。 */
export function compactableSpans(plan: CompactionPlan): ReadonlyArray<{ readonly start: number, readonly end: number }> {
  if (plan.decision !== 'compact') return []
  return plan.decisions
    .filter((decision) => decision.tier !== 'T1')
    .map((decision) => ({ start: decision.start, end: decision.end }))
}

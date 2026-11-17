/**
 * 阈值自调护栏（Story 8.4 / T7、AC:1737-1740、AD-28 / INV-14）。
 *
 * **纯函数、只收数值**：自调只能改数值，不能改判据形态、不能改不变量集合——这条纪律由
 * 函数签名本身保证（入参里没有任何判据结构，只有 `current` / `suggestion` / `bounds`）。
 *
 * 三道护栏（任一不满足即 `rejected`，**数值原样不动**）：
 * 1. 入参必须是有限数值；`bounds` 必须自洽（`0 < min <= max`）；
 * 2. 单步幅度 ≤ `maxStepRatio`（缺省 10%），防止一次跳到另一个判据区间；
 * 3. 硬上/下界双侧：低于 `bounds.min` 或高于 `bounds.max` 一律拒绝（不静默夹紧）。
 *
 * 成功时返回新值与**审计行素材**（from/to/delta/ratio），供调用方落 `generation_log`
 * 并据此回滚。LLM 只提建议、代码决定数值：本函数不调 LLM、不读 Config。
 */
import { LENGTH_MIN_SAFETY_MARGIN_TOKENS } from './compaction-tier.js'

/** 单步幅度上限（AC:1739-1740 的「小步长」；10% 是 v1 落地值）。 */
export const DEFAULT_MAX_STEP_RATIO = 0.1

/** 拒绝理由常量（测试与账本按这些串断言）。 */
export const TUNING_REASON_NON_NUMERIC = 'non-numeric'
export const TUNING_REASON_INVALID_BOUNDS = 'invalid-bounds'
export const TUNING_REASON_STEP_TOO_LARGE = 'step-too-large'
export const TUNING_REASON_BELOW_HARD_MIN = 'below-hard-min'
export const TUNING_REASON_ABOVE_HARD_MAX = 'above-hard-max'
export const TUNING_REASON_UNCHANGED = 'unchanged'

/** 阈值双侧硬界（调用方按判据语义给出；本函数只做区间判断）。 */
export interface TuningBounds {
  readonly min: number
  readonly max: number
}

export interface TuningRequest {
  /** 当前生效值。 */
  readonly current: number
  /** 建议值（来自反思/人工，未经校验）。 */
  readonly suggestion: number
  /** 该判据的硬下界 / 硬上界。 */
  readonly bounds: TuningBounds
  /** 单步幅度上限占比，缺省 {@link DEFAULT_MAX_STEP_RATIO}。 */
  readonly maxStepRatio?: number
}

/** 审计行素材（一片可落库的纯数据，不含原文/凭据）。 */
export interface TuningAudit {
  readonly from: number
  readonly to: number
  readonly delta: number
  /** `delta / current`（`current > 0` 恒成立，故不会除零）。 */
  readonly ratio: number
  /** 本次生效的单步上限占比（便于事后解释为什么拒/为什么允）。 */
  readonly stepLimit: number
}

export type TuningResult =
  | { readonly ok: true, readonly value: number, readonly audit: TuningAudit }
  | { readonly ok: false, readonly rejected: true, readonly reason: string }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 应用一次自调建议。
 *
 * 顺序（先绝对护栏、后相对步长）：非数值 → 界限非法 → 越硬界 → 步长过大 → 成功。
 * 拒绝时**不返回新值**（调用方拿不到可写的数，避免「rejected 但被照用」）。
 */
export function applyTuning(request: TuningRequest): TuningResult {
  const { current, suggestion, bounds } = request
  if (!isFiniteNumber(current) || !isFiniteNumber(suggestion) || !isFiniteNumber(bounds?.min) || !isFiniteNumber(bounds?.max)) {
    return { ok: false, rejected: true, reason: TUNING_REASON_NON_NUMERIC }
  }
  if (bounds.min <= 0 || bounds.max < bounds.min) {
    return { ok: false, rejected: true, reason: TUNING_REASON_INVALID_BOUNDS }
  }
  const stepLimit = isFiniteNumber(request.maxStepRatio) && request.maxStepRatio > 0
    ? request.maxStepRatio
    : DEFAULT_MAX_STEP_RATIO

  if (suggestion < bounds.min) {
    return { ok: false, rejected: true, reason: TUNING_REASON_BELOW_HARD_MIN }
  }
  if (suggestion > bounds.max) {
    return { ok: false, rejected: true, reason: TUNING_REASON_ABOVE_HARD_MAX }
  }

  const delta = suggestion - current
  // current 必须是正数（上一步已由 bounds.min > 0 与 current 自身校验保证语义）；
  // current <= 0 时任何非零移动都会得到无穷比例，按「步长过大」拒绝（fail-closed）。
  if (current <= 0) {
    if (delta === 0) return { ok: true, value: current, audit: { from: current, to: current, delta: 0, ratio: 0, stepLimit } }
    return { ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE }
  }
  if (Math.abs(delta) / current > stepLimit + Number.EPSILON) {
    return { ok: false, rejected: true, reason: TUNING_REASON_STEP_TOO_LARGE }
  }
  if (delta === 0) {
    return {
      ok: true,
      value: current,
      audit: { from: current, to: current, delta: 0, ratio: 0, stepLimit },
    }
  }
  return {
    ok: true,
    value: suggestion,
    audit: { from: current, to: suggestion, delta, ratio: delta / current, stepLimit },
  }
}

/**
 * 审计行文本（一片证据，供 `generation_log.reason`）：`<field>: <from> -> <to> (<±ratio>%)`。
 * `field` 由调用方给（本模块不认识 Config 字段名）。
 */
export function formatTuningAudit(field: string, audit: TuningAudit): string {
  const percent = (audit.ratio * 100).toFixed(1)
  const signed = audit.delta > 0 ? '+' + percent : percent
  return field + ': ' + String(audit.from) + ' -> ' + String(audit.to) + ' (' + signed + '%)'
}

/**
 * `lengthMin` 的硬下界（AC:1798-1801，与 `compaction-tier.checkLengthMinFloor` 同一口径）：
 * 自调不得把 `lengthMin` 降到「滚动窗口内 user.original 最大长度 + 余量」以下。
 */
export function lengthMinTuningBounds(
  maxUserOriginalTokens: number,
  marginTokens: number = LENGTH_MIN_SAFETY_MARGIN_TOKENS,
): TuningBounds {
  const maxUser = isFiniteNumber(maxUserOriginalTokens) && maxUserOriginalTokens > 0 ? maxUserOriginalTokens : 0
  const margin = isFiniteNumber(marginTokens) && marginTokens >= 0 ? marginTokens : LENGTH_MIN_SAFETY_MARGIN_TOKENS
  // 上界不在这里拍：调用方按 t3Threshold - 1 之类的语义收紧（见 spec 的三带约束）。
  return { min: Math.trunc(maxUser + margin), max: Number.MAX_SAFE_INTEGER }
}

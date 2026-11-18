/**
 * 处境条件化召回的 A/B 评估（Story 9.3 / T8、AC:2020-2024、I/O 矩阵 20–21）。
 *
 * 口径（AC:2022 逐字）：以 **embedding-only 为对照组**，报告
 * `lift = 处境条件化召回命中率 / embedding-only 命中率`；**无对照组不得声称有效**（防自证有效）。
 *
 * 纯函数：输入是两个命中集与各自的相关集（真值），输出 `{lift, control}` 与可检视明细；
 * 不读库、不看时钟、无随机。评估记录由调用方写 `generation_log`（detail 见
 * {@link situatedEvalLogDetail}，只含 id 与数值，不含记忆正文）。
 */

/** 评估行的 action（`generation_log.action`；`/memory status` 或结论文档按它筛）。 */
export const SITUATED_EVAL_ACTION = 'situated_eval'

/** 评估写入的 kind（审计动作语汇：召回侧的评估不是写路径）。 */
export const SITUATED_EVAL_KIND = 'recall'

/** 一个召回配置的命中集与真值集。 */
export interface SituatedHitSet {
  /** 本次召回返回的记忆 id。 */
  readonly hits: readonly string[]
  /** 判定为相关的记忆 id（人工/离线标注的真值）。 */
  readonly relevant: readonly string[]
}

/** 命中率（`null` = 真值集为空，比率无定义；不静默按 0 计）。 */
export interface SituatedHitRate {
  readonly hits: number
  readonly relevant: number
  /** `|hits ∩ relevant| / |relevant|`；真值集为空时为 null。 */
  readonly hitRate: number | null
  /** 本次命中 id（去重、升序；供评估记录检视，不含正文）。 */
  readonly hitIds: readonly string[]
}

/** 不给 lift 的原因（封闭词表）。 */
export type SituatedEvalReason = 'no-control' | 'control-empty' | 'control-zero' | 'situated-empty'

export interface SituatedEvalResult {
  readonly situated: SituatedHitRate;
  /** 对照组（embedding-only）；缺失为 null。 */
  readonly control: SituatedHitRate | null
  /** 命中率比；null = 不得给（见 {@link SituatedEvalReason}）。 */
  readonly lift: number | null
  /** lift 为 null 时的原因（封闭词表）。 */
  readonly reason?: SituatedEvalReason
}

/** 冻结的去重 id 列表（稳定序，便于逐行对比两次评估）。 */
function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/** 计算命中率；真值集为空 ⇒ null（矩阵 20 的「不得声称有效」从数据源头开始）。 */
export function computeHitRate(set: SituatedHitSet): SituatedHitRate {
  const hits = uniqueIds(set.hits)
  const relevant = uniqueIds(set.relevant)
  if (relevant.length === 0) return { hits: hits.length, relevant: 0, hitRate: null, hitIds: hits }
  const relevantSet = new Set(relevant)
  const matched = hits.filter((id) => relevantSet.has(id)).length
  return { hits: hits.length, relevant: relevant.length, hitRate: matched / relevant.length, hitIds: hits }
}

/**
 * 评估一次处境条件化召回（矩阵 20–21）。
 *
 * - 无对照组 ⇒ `lift: null` + `reason: 'no-control'`（不得声称有效）；
 * - 对照组真值集为空 ⇒ `lift: null` + `'control-empty'`；
 * - 对照组命中率为 0 ⇒ `lift: null` + `'control-zero'`（除零不产生「无限提升」的假结论）；
 * - 处境侧真值集为空 ⇒ `lift: null` + `'situated-empty'`；
 * - 其余 ⇒ `lift = situated.hitRate / control.hitRate`（有限数，可检视）。
 */
export function evaluateSituatedRecall(input: {
  readonly situated: SituatedHitSet
  readonly control?: SituatedHitSet | null
}): SituatedEvalResult {
  const situated = computeHitRate(input.situated)
  if (input.control === undefined || input.control === null) {
    return { situated, control: null, lift: null, reason: 'no-control' }
  }
  const control = computeHitRate(input.control)
  if (situated.hitRate === null) return { situated, control, lift: null, reason: 'situated-empty' }
  if (control.hitRate === null) return { situated, control, lift: null, reason: 'control-empty' }
  if (control.hitRate === 0) return { situated, control, lift: null, reason: 'control-zero' }
  return { situated, control, lift: situated.hitRate / control.hitRate }
}

/**
 * 评估记录的 `generation_log.detail`（矩阵 21「记录可检视」）。
 *
 * 只含 id 与数值：不含记忆正文、不含查询文本、不含凭据（NFR9）。
 * 命中 id 截到 20 条（与 FR-12 的结果上限同量级），超出只记数量。
 */
export function situatedEvalLogDetail(result: SituatedEvalResult): string {
  const cap = (values: readonly string[]): string[] => values.slice(0, 20)
  return JSON.stringify({
    lift: result.lift,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    situated: {
      hits: result.situated.hits,
      relevant: result.situated.relevant,
      hitRate: result.situated.hitRate,
      hitIds: cap(result.situated.hitIds),
    },
    control: result.control === null
      ? null
      : {
        hits: result.control.hits,
        relevant: result.control.relevant,
        hitRate: result.control.hitRate,
        hitIds: cap(result.control.hitIds),
      },
  })
}

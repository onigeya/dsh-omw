/**
 * `memory_related` / `/memory related` 的**共享塑形与判定件**（Story 3.2 / F-02·F-04·F-05）。
 *
 * 两个可见面必须同口径，故 D4/D5/hint/截断只在这里实现一次：
 * - **AC:889 evidence expired**：用**截断前**的 `anyValidPath` 判定（F-02）——有效路径可能
 *   来自第 21+ 名邻居，用 20 条 `results` 判断会误报；
 * - **起点不参与判定**（F-04）：起点失效 + 仍有有效邻居 ⇒ 返回邻居 + hint「起点已失效」；
 *   起点失效 + 全部邻居无有效路径 ⇒ evidence expired 空结果（不是「返回邻居」）；
 * - 单条 text 走 3.1 的 256-token 截断（`recall/core.ts` 的唯一实现，不复制规则）。
 *
 * 纯函数：无 I/O、无时钟；工具面与命令面只负责把本 view 映射到各自的输出契约。
 */
import type { RelatedTraversalItem, RelatedTraversalResult } from '../db/edges.js'
import { truncateRecallText } from '../recall/core.js'

/** 起点不存在（AC:882-884：成功值 + hint，不抛错）。 */
export const RELATED_HINT_START_MISSING = '未找到该记忆。'
/** 无有效证据链（AC:889）。 */
export const RELATED_HINT_EVIDENCE_EXPIRED = 'evidence expired'
/** 遍历超时后以 depth=1 返回的部分结果（AC:891-893）。 */
export const RELATED_HINT_PARTIAL = 'partial'
/** 起点自身失效的附加说明（spec D5 ②）。 */
export const RELATED_HINT_START_INVALID = '起点已失效，结果为邻居记忆'

/** 一条邻居的视图项（camelCase，工具面在输出边界再映射成 AC:880 的 snake_case）。 */
export interface RelatedViewEntry {
  readonly id: string
  readonly layer: string
  readonly hops: number
  readonly edgeType: 'EVIDENCE' | 'RELATED'
  readonly reason?: string
  readonly text: string
  readonly truncated?: boolean
  readonly invalid?: boolean
  readonly invalidAt?: string
  readonly expiredAt?: string
}

/** 两个可见面共用的成功视图。 */
export interface RelatedSuccessView {
  readonly id: string
  readonly depth: number
  /** 去重归并后（20 条截断前）的邻居总数；evidence expired 空结果时为 0。 */
  readonly total: number
  readonly results: RelatedViewEntry[]
  readonly hint?: string
  readonly partial?: boolean
}

/** 内核条目 → 视图项（256-token 截断在此统一执行）。 */
function toViewEntry(item: RelatedTraversalItem): RelatedViewEntry {
  const text = truncateRecallText(item.text)
  return {
    id: item.id,
    layer: item.layer,
    hops: item.hops,
    edgeType: item.edgeType,
    ...(item.reason === null ? {} : { reason: item.reason }),
    text: text.text,
    ...(text.truncated ? { truncated: true } : {}),
    ...(item.invalid ? { invalid: true } : {}),
    ...(item.invalidAt === null ? {} : { invalidAt: item.invalidAt }),
    ...(item.expiredAt === null ? {} : { expiredAt: item.expiredAt }),
  }
}

/**
 * 由遍历结果组装成功视图（工具面与命令面共用；`partial` 只属工具面的 depth=1 降级，
 * 命令面不降级——spec D8 有意为之，调用方不传即为 false）。
 */
export function toRelatedSuccessView(
  result: RelatedTraversalResult,
  options: { readonly partial?: boolean } = {},
): RelatedSuccessView {
  const partial = options.partial === true
  if (!result.startFound) {
    return { id: result.id, depth: result.depth, total: 0, results: [], hint: RELATED_HINT_START_MISSING }
  }
  // AC:889 + F-02 + F-04：只看邻居侧是否存在有效路径（截断前聚合），起点不参与。
  if (result.total > 0 && !result.anyValidPath) {
    return { id: result.id, depth: result.depth, total: 0, results: [], hint: RELATED_HINT_EVIDENCE_EXPIRED }
  }
  const hintParts: string[] = []
  if (partial) hintParts.push(RELATED_HINT_PARTIAL)
  if (result.start.invalid) hintParts.push(RELATED_HINT_START_INVALID)
  return {
    id: result.id,
    depth: result.depth,
    total: result.total,
    results: result.results.map(toViewEntry),
    ...(hintParts.length === 0 ? {} : { hint: hintParts.join('；') }),
    ...(partial ? { partial: true } : {}),
  }
}

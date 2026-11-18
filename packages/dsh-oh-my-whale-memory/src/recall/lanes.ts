/**
 * 处境条件化召回的双路合并（Story 9.3 / T3、AC:2023、I/O 矩阵 9–11）。
 *
 * 两路：**原始查询 lane**（用户请求文本）与**处境改写 lane**（改写 + HyDE 的检索结果）。
 * 合并规则逐字取 AC:2023（参数与命名参照 cognee `merge_results.py:20-28`，不另立权重）：
 * - `conversationalReserve = max(1, limit // 3)`，给改写 lane 保留约 1/3 槽位；
 * - `limit < 3` 时不保留该保留位（没有空间可言，留位只会挤掉原始命中）；
 * - 原始 lane 至少占 `limit - reserve`；
 * - 去重按 id（同一条记忆两路都命中时只出现一次，计入先占位的 lane）；
 * - 任一 lane 不足时用另一 lane 补齐，最终条数 ≤ limit。
 *
 * 纯函数：不读库、不看时钟、不抛错。
 */

/** 改写 lane 的保留槽位（AC:2023；`limit < 3` ⇒ 0；非有限值按 0，保持纯函数全域可定义）。 */
export function conversationalReserve(limit: number): number {
  const clamped = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
  return clamped < 3 ? 0 : Math.max(1, Math.floor(clamped / 3))
}

/** 合并只要求 id（两路元素同形，由调用方决定附加字段）。 */
export interface SituatedLaneItem {
  readonly id: string
}

export interface MergeSituatedLanesInput<T extends SituatedLaneItem> {
  /** 原始查询 lane（已按既有融合分排序）。 */
  readonly original: readonly T[]
  /** 处境改写 lane（同上）。 */
  readonly rewritten: readonly T[]
  /** 期望条数（≤0 / 非有限值按 1 处理：合并本身不抛错）。 */
  readonly limit: number
  /** 覆盖保留位（缺省 {@link conversationalReserve}；仅供调用方显式改配额）。 */
  readonly reserve?: number
}

export interface MergeSituatedLanesResult<T> {
  /** 合并后的结果（≤ limit，按占位顺序）。 */
  readonly items: readonly T[]
  /** 结果里来自原始 lane 的条数。 */
  readonly originalCount: number
  /** 结果里来自改写 lane 的条数。 */
  readonly rewrittenCount: number
  /** 本次实际使用的保留位。 */
  readonly reserve: number
}

/**
 * 合并两路命中（矩阵 9–11）。
 *
 * 占位顺序：原始 lane 先占 `limit - reserve` → 改写 lane 占 `reserve` → 两路轮流补齐。
 * 这条顺序保证「保留位被改写 lane 用掉」与「原始命中不被改写 lane 挤空」同时成立。
 */
export function mergeSituatedLanes<T extends SituatedLaneItem>(
  input: MergeSituatedLanesInput<T>,
): MergeSituatedLanesResult<T> {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit)) : 1
  const defaultReserve = conversationalReserve(limit)
  // 显式覆盖位同样夹紧（非有限值退回默认，不让 NaN 把槽位计算整条弄丢）。
  const reserveOverride = input.reserve === undefined || Number.isFinite(input.reserve)
    ? input.reserve
    : defaultReserve
  const reserve = Math.min(limit, Math.max(0, Math.trunc(reserveOverride ?? defaultReserve)))
  const originalTarget = limit - reserve

  const seen = new Set<string>()
  const items: T[] = []
  let originalCount = 0
  let rewrittenCount = 0
  let originalCursor = 0
  let rewrittenCursor = 0

  /** 取一条；重复 id / 已满 ⇒ false。返回是否真的占位。 */
  const take = (item: T): boolean => {
    if (items.length >= limit) return false
    const id = typeof item?.id === 'string' ? item.id : ''
    // 空 id 不是可去重身份：丢弃（宁可少一条，也不让两路各塞一条「同一条记忆」）。
    if (id === '' || seen.has(id)) return false
    seen.add(id)
    items.push(item)
    return true
  }

  while (originalCursor < input.original.length && items.length < originalTarget) {
    if (take(input.original[originalCursor++]!)) originalCount += 1
  }
  let reservedTaken = 0
  while (rewrittenCursor < input.rewritten.length && reservedTaken < reserve && items.length < limit) {
    if (take(input.rewritten[rewrittenCursor++]!)) {
      rewrittenCount += 1
      reservedTaken += 1
    }
  }
  while (originalCursor < input.original.length && items.length < limit) {
    if (take(input.original[originalCursor++]!)) originalCount += 1
  }
  while (rewrittenCursor < input.rewritten.length && items.length < limit) {
    if (take(input.rewritten[rewrittenCursor++]!)) rewrittenCount += 1
  }

  return { items, originalCount, rewrittenCount, reserve }
}

/**
 * 处境匹配与条件化排序（Story 9.3 / T4、AC:2011-2014、I/O 矩阵 12–14）。
 *
 * 口径（AC:2013 逐字）：最终分 = 语义相似度 × 处境匹配度 × 置信度 × 时效性。
 * 本仓的「语义相似度」就是内核的融合分（RRF × 层权重 × priority 系数，见 recall/core.ts），
 * 「置信度」沿用 FR-16 的 priority 二次加权系数（不另立第二套标尺）。
 *
 * 三条硬约束：
 * 1. `priority === -1`（全局强规则）**恒置顶且不参与竞争**：不乘任何处境/时效因子
 *    （AC:2014；与内核排序键同一口径）。
 * 2. 处境匹配 0 **不得挤掉高层权重条目**（矩阵 13）：处境因子被压在
 *    `[SITUATED_SCORE_FLOOR, 1]`，即处境匹配最多把一条劣势候选的增益限制在 2 倍以内；
 *    融合分高于两倍的条目不会被仅凭处境匹配反超。
 * 3. 描述符不可构建 ⇒ 退回 v1 排序并标降级（矩阵 14／AC:2016-2018），不报错、不阻塞。
 *
 * 纯函数：不读库、不看时钟（`now` 注入）、无随机。
 */
import type { SituationDescriptor } from './situation.js'

/**
 * 处境因子的下界：0 匹配时仍保留 50% 融合分。
 * 这是矩阵 13「处境匹配 0 不得挤掉高层权重条目」的量化实现——增益上界 = 1/0.5 = 2 倍。
 */
export const SITUATED_SCORE_FLOOR = 0.5

/** 时效性半衰期（天）：30 天前的记忆保留 50% 时效权重。经验值，非实测标定。 */
export const SITUATED_RECENCY_HALF_LIFE_DAYS = 30

/** 时效因子下界：极旧记忆仍保留 30% 权重（不让「新」单独决定排序）。 */
export const SITUATED_RECENCY_FLOOR = 0.3

/** 处境匹配的三组词项权重（结构化标识 > 话题词 > 错误档）。 */
export const SITUATED_WEIGHT_IDENTIFIERS = 0.35
export const SITUATED_WEIGHT_TOPIC = 0.45
export const SITUATED_WEIGHT_ERRORS = 0.2

/** 参与排序的候选（内核结果的附加视图；额外字段原样透传）。 */
export interface SituatedRankCandidate {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  /** 记录时间（UTC ISO-8601；空/非法 ⇒ 不施加时效惩罚）。 */
  readonly recordedAt: string
  /** 既有融合分（同类内可比，跨类不可比）。 */
  readonly similarity: number
}

export interface SituatedRankOptions {
  /** 处境描述符；`null` = 不可构建 ⇒ v1 排序 + 降级标记。 */
  readonly descriptor: SituationDescriptor | null
  /** 当前时刻（UTC ISO-8601；注入，不取时钟）。 */
  readonly now: string
  /** priority 二次加权系数（Config `priorityWeight`）。 */
  readonly priorityWeight: number
  /** 时效半衰期覆盖（天；测试注入）。 */
  readonly halfLifeDays?: number
}

export interface SituatedRankedItem<T> {
  readonly item: T
  /** 最终排序分（pinned 条目即融合分，不乘任何因子）。 */
  readonly finalScore: number
  /** 处境匹配度（0..1；pinned/降级为 0）。 */
  readonly situated: number
  /** 时效因子（0..1；pinned/无法判定为 1）。 */
  readonly recency: number
}

export interface SituatedRankResult<T> {
  readonly items: readonly SituatedRankedItem<T>[]
  readonly degraded: boolean
  readonly degradedReason?: 'no-descriptor'
}

/* ------------------------------------------------------------------------- *
 * 处境匹配度
 * ------------------------------------------------------------------------- */

const LATIN_WORD = /[a-z0-9_]{3,}/gu
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/gu

/** 词项切分（英文单词 ≥3 字符 + CJK 二元组；全部小写）。 */
function termsOf(text: string): Set<string> {
  const lower = text.toLowerCase()
  const terms = new Set<string>()
  for (const match of lower.matchAll(LATIN_WORD)) terms.add(match[0])
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2))
  }
  return terms
}

/** 路径的 basename（`a/b/c.ts` → `c.ts`）。 */
function basenameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * 处境匹配度（0..1）：封闭词表的命中比例。
 *
 * 三组分别计命中率，按非空组的权重归一：结构化标识（工具名按词项、文件按路径子串）、
 * 话题词（goal + 最近用户回合的词项）、错误档（词项）。`descriptor` 为 null ⇒ 0。
 */
export function situatedScore(
  candidate: { readonly text: string },
  descriptor: SituationDescriptor | null,
): number {
  if (descriptor === null) return 0
  const text = candidate.text.toLowerCase()
  const textTerms = termsOf(text)

  // 组 1：结构化标识（工具名 + 文件路径）。
  const identifierTerms: boolean[] = []
  for (const tool of descriptor.tools) identifierTerms.push(textTerms.has(tool.toLowerCase()))
  for (const file of descriptor.files) {
    const lower = file.toLowerCase()
    const base = basenameOf(lower)
    identifierTerms.push(text.includes(lower) || (base.length >= 3 && text.includes(base)))
  }

  // 组 2：话题词（goal + 最近用户回合）。空描述符时该组为空，不参与归一。
  const topicTerms = new Set<string>()
  for (const term of termsOf(descriptor.goal)) topicTerms.add(term)
  for (const turn of descriptor.recentUserTurns) for (const term of termsOf(turn)) topicTerms.add(term)
  const topicHits = [...topicTerms].filter((term) => textTerms.has(term)).length

  // 组 3：错误档（封闭词表里的档名落进正文才算命中）。
  const errorHits = descriptor.errors.filter((kind) => textTerms.has(kind) || text.includes(kind)).length

  const groups: Array<{ weight: number; hits: number; total: number }> = []
  if (identifierTerms.length > 0) {
    groups.push({
      weight: SITUATED_WEIGHT_IDENTIFIERS,
      hits: identifierTerms.filter(Boolean).length,
      total: identifierTerms.length,
    })
  }
  if (topicTerms.size > 0) groups.push({ weight: SITUATED_WEIGHT_TOPIC, hits: topicHits, total: topicTerms.size })
  if (descriptor.errors.length > 0) {
    groups.push({ weight: SITUATED_WEIGHT_ERRORS, hits: errorHits, total: descriptor.errors.length })
  }
  if (groups.length === 0) return 0
  const weightSum = groups.reduce((sum, group) => sum + group.weight, 0)
  const score = groups.reduce((sum, group) => sum + group.weight * (group.hits / group.total), 0) / weightSum
  return Math.min(1, Math.max(0, score))
}

/* ------------------------------------------------------------------------- *
 * 时效性与置信度
 * ------------------------------------------------------------------------- */

/** 解析记录时间；不可解析 / 缺失 ⇒ null（不施加时效惩罚）。 */
function parseRecordedAt(value: string): number | null {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/** 时效因子（0..1；半衰期指数衰减，下界 `SITUATED_RECENCY_FLOOR`）。 */
export function recencyFactor(recordedAt: string, now: string, halfLifeDays: number): number {
  const recorded = parseRecordedAt(recordedAt)
  const reference = parseRecordedAt(now)
  if (recorded === null || reference === null) return 1
  const ageDays = Math.max(0, (reference - recorded) / 86_400_000)
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : SITUATED_RECENCY_HALF_LIFE_DAYS
  const decay = Math.pow(0.5, ageDays / halfLife)
  return Math.min(1, Math.max(SITUATED_RECENCY_FLOOR, decay))
}

/** 置信度：复用 FR-16 的 `1 + weight × priority/100`（与内核同一公式，不另立标尺）。 */
function confidenceFactor(priority: number, priorityWeight: number): number {
  const weight = Number.isFinite(priorityWeight) ? Math.max(0, priorityWeight) : 0
  const value = 1 + weight * (Number.isFinite(priority) ? priority : 0) / 100
  return value > 0 ? value : 1
}

/* ------------------------------------------------------------------------- *
 * 排序
 * ------------------------------------------------------------------------- */

/** code unit 升序（跨机器稳定，不用 localeCompare）。 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * 一次条件化排序（矩阵 12–14）。
 *
 * - `priority === -1`：单独成组置顶，按 recordedAt 降序 → id 升序，不乘任何因子；
 * - 其余：`finalScore = similarity × situatedFactor × confidence × recency`；
 * - 排序键：pinned 组在前 → finalScore 降序 → recordedAt 降序 → id 升序（稳定）；
 * - `descriptor === null`：完全退回 v1 排序（similarity 降序 → recordedAt 降序 → id 升序）并标降级。
 */
export function rankSituated<T extends SituatedRankCandidate>(
  candidates: readonly T[],
  options: SituatedRankOptions,
): SituatedRankResult<T> {
  const descriptor = options.descriptor
  const halfLife = options.halfLifeDays ?? SITUATED_RECENCY_HALF_LIFE_DAYS

  const ranked: SituatedRankedItem<T>[] = candidates.map((item) => {
    const pinned = item.priority === -1
    const similarity = Number.isFinite(item.similarity) ? item.similarity : 0
    if (pinned) return { item, finalScore: similarity, situated: 0, recency: 1 }
    // 降级态只按 v1 融合分排，不乘任何处境因子（矩阵 14：退回 v1 排序）。
    if (descriptor === null) return { item, finalScore: similarity, situated: 0, recency: 1 }
    const situated = situatedScore(item, descriptor)
    const recency = recencyFactor(item.recordedAt, options.now, halfLife)
    const situatedFactor = SITUATED_SCORE_FLOOR + (1 - SITUATED_SCORE_FLOOR) * situated
    const finalScore = similarity * situatedFactor * confidenceFactor(item.priority, options.priorityWeight) * recency
    return { item, finalScore, situated, recency }
  })

  ranked.sort((left, right) => {
    const leftPinned = left.item.priority === -1 ? 0 : 1
    const rightPinned = right.item.priority === -1 ? 0 : 1
    if (leftPinned !== rightPinned) return leftPinned - rightPinned
    if (left.finalScore !== right.finalScore) return right.finalScore - left.finalScore
    if (left.item.recordedAt !== right.item.recordedAt) return left.item.recordedAt < right.item.recordedAt ? 1 : -1
    return compareCodeUnits(left.item.id, right.item.id)
  })

  return descriptor === null
    ? { items: ranked, degraded: true, degradedReason: 'no-descriptor' }
    : { items: ranked, degraded: false }
}

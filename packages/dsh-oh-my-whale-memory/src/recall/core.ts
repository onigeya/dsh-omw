/**
 * 混合检索内核（Story 3.1 / FR-11、FR-12 —— 全仓唯一检索实现）。
 *
 * 两路各取 `retrievalTopK` 条（Config，缺省 50）：
 * - 语义向量路：`QUERY_VECTOR_INDEX`，余弦距离升序（lower = better）；
 *   只看 `embedding_model_id` 与库内 pin 一致的节点（不做跨模型向量相似度）；
 * - 关键词路：`QUERY_FTS_INDEX`（BM25，K=1.2 / B=0.75），score 降序。
 *
 * 合流（探针锁定，见 spec Design Notes）：
 * - RRF `1/(rrfK + rank)`，rank 从 1 计，**只按 rank 参与**——语义距离与 BM25 分
 *   不可比，绝不把两路分数放在同一数轴上；
 * - 层权重是排序分数的乘法系数（L2 / L1，未知层 1），再乘 priority 系数
 *   `1 + priority/100`（保守默认，Lead 可推翻）；
 * - 排序键：`priority === -1` 恒置顶 → score 降序 → recorded_at 降序 → id 升序
 *   （同一输入在任何会话/进程下返回同一序）；
 * - 层过滤 → `limit` 截断（夹紧 [1,20]，缺省 5）。
 *
 * 只读：本模块不写库、不触发写路径、不建索引（索引由 database.ts 建库时创建）。
 *
 * 安全（探针 P2）：FTS 查询串**必须内联字面量**——`$q` 参数绑定会静默返回空；
 * 转义反斜杠与单引号后拼进语句，注入尝试被当字面量处理。快照过滤在 Cypher 内
 * 完成（`WITH node, score MATCH (node) WHERE <共享谓词>`，探针 P1）。
 */
import type * as lbug from '@ladybugdb/core'
import { collectRows } from '../db/rows.js'
import { currentSnapshotPredicate } from '../db/snapshot.js'
import { FTS_INDEX_NAME, MEMORY_TABLE, VECTOR_INDEX_NAME } from '../db/schema.js'

/** BM25 查询期参数（FR-11：K=1.2 / B=0.75；建索引时用官方默认，见 schema.ts）。 */
export const BM25_K = 1.2
export const BM25_B = 0.75

/** `limit` 夹紧区间（FR-12：缺省 5，上限 20，下限 1）。 */
export const RECALL_DEFAULT_LIMIT = 5
export const RECALL_MAX_LIMIT = 20
export const RECALL_MIN_LIMIT = 1

/** `truncated` 判据：单条 text 的 code point 数 > 512（≈256 tokens，2 chars/token 的保守近似）。 */
export const RECALL_TRUNCATE_CODE_POINTS = 512

/** `limit` 夹紧的唯一实现（工具面与命令面共用，绝不各写一份）。 */
export function clampRecallLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECALL_DEFAULT_LIMIT
  return Math.min(RECALL_MAX_LIMIT, Math.max(RECALL_MIN_LIMIT, Math.trunc(limit)))
}

/**
 * FTS 查询串的内联转义（探针 P2：必须内联，`''` 双写解析失败）：
 * 反斜杠 → `\\`，单引号 → `\'`。注入尝试（`x\' OR 1=1 --`）被当字面量处理。
 */
export function escapeFtsQuery(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export interface RecallLayerWeights {
  readonly l2: number
  readonly l1: number
}

export interface RecallCoreInput {
  readonly connection: lbug.Connection
  /** 检索文本（同时是关键词路的 FTS 查询串）。 */
  readonly query: string
  /**
   * 查询向量；`null` = 无向量（embedding disabled / 查询 embed 失败）→ 只走关键词单路
   * 并标 `degraded: true`。
   */
  readonly queryVector: readonly number[] | null
  /** 库内 pin 的 embedding 模型 id（`db.modelId`）；模型不符的节点不进向量路。 */
  readonly embeddingModelId: string
  /** RRF 平滑常数（Config `rrfK`，缺省 60）。 */
  readonly rrfK: number
  /** 每路取回条数（Config `retrievalTopK`，缺省 50）。 */
  readonly retrievalTopK: number
  readonly layerWeights: RecallLayerWeights
  /** 结果条数（夹紧 [1,20]，缺省 5）。 */
  readonly limit: number
  /** 层过滤（`'L1' | 'L2'`）；缺省不过滤（未指定时 L2 优先于 L1 由层权重承载）。 */
  readonly layer?: string | null
  /** 当前时刻（缺省 `new Date().toISOString()`；测试注入）。 */
  readonly now?: string
}

export interface RecallResultItem {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  /** text 超过 RECALL_TRUNCATE_CODE_POINTS 个 code point 时为 true（标记不丢节点）。 */
  readonly truncated?: boolean
  /** 非空 `source_refs`（证据引用）；空时缺省，不出现空数组。 */
  readonly evidence?: readonly string[]
}

export interface RecallCoreResult {
  readonly total: number
  readonly results: readonly RecallResultItem[]
  /** true = 只走了关键词单路（无查询向量），降级必须可见（FR-11）。 */
  readonly degraded: boolean
  readonly hint: string
}

/** 向量路（探针 P3）：`WHERE <共享谓词> AND node.embedding_model_id = $model_id`；
 * 次级键 `id ASC` 钉住引擎同距并列时的次序（否则 rank 分配不稳定 ⇒ RRF 跨进程漂移）。 */
const VECTOR_PATH_STATEMENT = [
  `CALL QUERY_VECTOR_INDEX('${MEMORY_TABLE}', '${VECTOR_INDEX_NAME}', $q, $k)`,
  'WITH node, distance',
  'MATCH (node)',
  'WHERE node.embedding_model_id = $model_id',
  '  AND ' + currentSnapshotPredicate('node'),
  'RETURN node.id AS id, node.layer AS layer, node.kind AS kind, node.priority AS priority,',
  '  node.text AS text, node.recorded_at AS recorded_at, node.source_refs AS source_refs, distance',
  'ORDER BY distance, id ASC',
].join('\n')

/** 关键词路（探针 P1）：查询串内联字面量；K/B/TOP 经参数绑定。
 * 次级键 `id ASC` 钉住同分并列时的次序（否则 rank 分配不稳定 ⇒ RRF 跨进程漂移）。 */
function keywordPathStatement(query: string): string {
  // 内联前把行终止符归一为空格：Cypher 单引号字面量不跨行，多行 query 原样内联会
  // 直接解析失败（不是命中面问题，是语句级语法错误）。对 BM25 分词，换行与空格等价。
  const singleLine = query.replace(/\r/g, ' ').replace(/\n/g, ' ')
  return [
    `CALL QUERY_FTS_INDEX('${MEMORY_TABLE}', '${FTS_INDEX_NAME}', '${escapeFtsQuery(singleLine)}', K := $k, B := $b, TOP := $top)`,
    'WITH node, score',
    'MATCH (node)',
    'WHERE ' + currentSnapshotPredicate('node'),
    'RETURN node.id AS id, node.layer AS layer, node.kind AS kind, node.priority AS priority,',
    '  node.text AS text, node.recorded_at AS recorded_at, node.source_refs AS source_refs, score',
    'ORDER BY score DESC, id ASC',
  ].join('\n')
}

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/** 融合前的候选（携带两路累计的 RRF 分）。 */
interface RecallCandidate {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  readonly recordedAt: string
  readonly sourceRefs: string[]
  rrf: number
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

/** 把一路的命中行按 rank 累计进候选表（同 id 在两路都命中时 RRF 相加）。 */
function addRankedRows(
  candidates: Map<string, RecallCandidate>,
  rows: readonly Record<string, unknown>[],
  rrfK: number,
): void {
  for (const [index, row] of rows.entries()) {
    const id = String(row.id)
    const existing = candidates.get(id)
    // rank 从 1 计（数组下标 0 → rank 1）。
    const rrf = 1 / (rrfK + index + 1)
    if (existing !== undefined) {
      existing.rrf += rrf
      continue
    }
    candidates.set(id, {
      id,
      layer: String(row.layer ?? ''),
      kind: row.kind === null || row.kind === undefined ? '' : String(row.kind),
      priority: Number(row.priority ?? 0),
      text: String(row.text ?? ''),
      recordedAt: String(row.recorded_at ?? ''),
      sourceRefs: toStringArray(row.source_refs),
      rrf,
    })
  }
}

/**
 * 混合检索：两路各取 `retrievalTopK` → RRF 融合 → 层权重 × priority 加权 →
 * 排序（-1 恒置顶 → score 降序 → recorded_at 降序 → id 升序）→ 层过滤 → 截断。
 *
 * 查询出错（扩展缺失、索引缺失等）原样冒泡——工具面负责收敛成失败信封；
 * 无命中不是错误：返回 `total: 0` 的正常成功值。
 */
export async function runRecallCore(input: RecallCoreInput): Promise<RecallCoreResult> {
  const now = input.now ?? new Date().toISOString()
  const rrfK = input.rrfK
  const topK = Math.max(1, Math.trunc(input.retrievalTopK))
  const query = input.query.trim()
  const candidates = new Map<string, RecallCandidate>()

  // ---- 向量路：有查询向量才走；模型不符的节点已在 Cypher 内排除。 ----
  const vectorRows = input.queryVector === null || input.queryVector.length === 0
    ? []
    : await queryRows(input.connection, VECTOR_PATH_STATEMENT, {
      q: [...input.queryVector],
      k: topK,
      model_id: input.embeddingModelId,
      now,
    })
  addRankedRows(candidates, vectorRows, rrfK)

  // ---- 关键词路：FTS 查询串必须内联（P2）；空串不发查询。 ----
  const keywordRows = query === ''
    ? []
    : await queryRows(input.connection, keywordPathStatement(query), {
      k: BM25_K,
      b: BM25_B,
      top: topK,
      now,
    })
  addRankedRows(candidates, keywordRows, rrfK)

  const degraded = input.queryVector === null || input.queryVector.length === 0

  // ---- RRF → 层权重 × priority 乘法系数（score 只作排序，不外发）。 ----
  const layerWeightOf = (layer: string): number => {
    if (layer === 'L2') return input.layerWeights.l2
    if (layer === 'L1') return input.layerWeights.l1
    return 1
  }
  const scored = [...candidates.values()].map((candidate) => ({
    candidate,
    score: candidate.rrf * layerWeightOf(candidate.layer) * (1 + candidate.priority / 100),
  }))

  // ---- 排序：-1 恒置顶 → score 降序 → recorded_at 降序 → id 升序（稳定次级键）。 ----
  scored.sort((a, b) => {
    const aPinned = a.candidate.priority === -1 ? 0 : 1
    const bPinned = b.candidate.priority === -1 ? 0 : 1
    if (aPinned !== bPinned) return aPinned - bPinned
    if (a.score !== b.score) return b.score - a.score
    if (a.candidate.recordedAt !== b.candidate.recordedAt) {
      return a.candidate.recordedAt < b.candidate.recordedAt ? 1 : -1
    }
    if (a.candidate.id === b.candidate.id) return 0
    return a.candidate.id < b.candidate.id ? -1 : 1
  })

  // ---- 层过滤 → limit 截断 → truncated / evidence 标注。 ----
  const layerFilter = input.layer?.trim()
  const filtered = layerFilter ? scored.filter((entry) => entry.candidate.layer === layerFilter) : scored
  const limit = clampRecallLimit(input.limit)
  const results: RecallResultItem[] = filtered.slice(0, limit).map(({ candidate }) => {
    const truncated = [...candidate.text].length > RECALL_TRUNCATE_CODE_POINTS
    return {
      id: candidate.id,
      layer: candidate.layer,
      kind: candidate.kind,
      priority: candidate.priority,
      text: candidate.text,
      ...(truncated ? { truncated: true } : {}),
      ...(candidate.sourceRefs.length > 0 ? { evidence: candidate.sourceRefs } : {}),
    }
  })

  const hint = degraded
    ? results.length === 0
      ? '无匹配记忆（embedding 不可用，本次仅关键词单路）。'
      : '降级检索：embedding 不可用，本次仅走关键词单路（语义向量路未参与）。'
    : results.length === 0
      ? '无匹配记忆。'
      : '混合检索（语义向量路 + 关键词路，RRF 融合排序）。'

  return { total: results.length, results, degraded, hint }
}

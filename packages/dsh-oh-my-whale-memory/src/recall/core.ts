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
 *   `1 + priorityWeight × priority/100`（priorityWeight 由 Config 提供，缺省 0.5，spec D4）；
 * - 排序键：`priority === -1` 恒置顶 → score 降序 → recorded_at 降序 → id 升序
 *   （同一输入在任何会话/进程下返回同一序）；
 * - 层过滤 → `limit` 截断（夹紧 [1,20]，缺省 5）。
 *
 * 只读：本模块不写库、不触发写路径、不建索引（索引由 database.ts 建库时创建）。
 *
 * 安全（P2 复测 + F-03）：FTS 查询串经 `$q` **参数绑定**送进语句（prepare+execute，
 * 绝不内联）——2026-11-14 双后端复测证明 0.22.3 上绑定可用（见 ledger-3-1.tsv 的
 * P2 复测行）；入参仍先经 `sanitizeFtsQuery` 剥离 C0 控制字符并限长 256 code points。
 * 快照过滤在 Cypher 内完成（`WITH node, score MATCH (node) WHERE <共享谓词>`，探针 P1）。
 */
import type * as lbug from '@ladybugdb/core'
import { collectRows } from '../db/rows.js'
import { currentSnapshotPredicate } from '../db/snapshot.js'
import { FTS_INDEX_NAME, MEMORY_TABLE, VECTOR_INDEX_NAME } from '../db/schema.js'
import { estimateTokens, splitToBudget } from '../distill/llm-refine.js'

/** BM25 查询期参数（FR-11：K=1.2 / B=0.75；建索引时用官方默认，见 schema.ts）。 */
export const BM25_K = 1.2
export const BM25_B = 0.75

/** `limit` 夹紧区间（FR-12：缺省 5，上限 20，下限 1）。 */
export const RECALL_DEFAULT_LIMIT = 5
export const RECALL_MAX_LIMIT = 20
export const RECALL_MIN_LIMIT = 1

/**
 * 单条召回文本的 token 预算（spec Always 第 6 条）：超过即截断到首段 + `…`。
 * 与精炼侧「每条 ≤150 token」是不同口径——召回给的是**摘要预览**，256 让 Agent 一眼读懂
 * 一条记忆的主干，又不至于把一次召回塞满上下文。
 */
export const RECALL_TEXT_TOKEN_BUDGET = 256

/**
 * 召回侧真截断（spec Always 第 6 条）：复用精炼侧同一 token 估算与切分器
 * （`estimateTokens` / `splitToBudget`，distill/llm-refine.ts:133/150），取**首段**并追加
 * `…`。只改返回的 text，**不改节点集合**：命中不丢，需要全文时按 id 另查（`/memory show`）。
 */
export function truncateRecallText(text: string): { readonly text: string; readonly truncated: boolean } {
  if (estimateTokens(text) <= RECALL_TEXT_TOKEN_BUDGET) return { text, truncated: false }
  const first = splitToBudget(text, RECALL_TEXT_TOKEN_BUDGET)[0]
  // splitToBudget 对非空超预算文本至少返回一段；兜底仅为不让 undefined 漏进结果。
  return { text: first === undefined ? text : `${first}…`, truncated: true }
}

/**
 * priority 二次加权乘法系数（spec D4 / FR-16）：
 * `1 + weight × priority/100` —— 线性、单调、可解释；`weight` 由 Config `priorityWeight`
 * 提供（缺省 0.5 ⇒ priority=100 得 ×1.5），层权重之后再乘一次，排序仍以 RRF 融合分为主。
 *
 * `priority === -1`（全局强规则）**不进本公式**：它的恒置顶由排序阶段的独立分组承载
 * （见 {@link runRecallCore} 的排序键），函数本身不做特判——把 -1 代入只会得到 1 - weight/100，
 * 与「恒置顶」无关。
 */
function priorityFactor(priority: number, weight: number): number {
  return 1 + weight * priority / 100
}

/** `limit` 夹紧的唯一实现（工具面与命令面共用，绝不各写一份）。 */
export function clampRecallLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECALL_DEFAULT_LIMIT
  return Math.min(RECALL_MAX_LIMIT, Math.max(RECALL_MIN_LIMIT, Math.trunc(limit)))
}

/**
 * FTS 查询串的 code point 上限（F-03）：FTS 引擎按整串分词，超长 query 只会放大
 * 分词与匹配成本，不会更准。超限截断（不是错误）：召回是软目标。
 */
export const RECALL_FTS_QUERY_MAX_CODE_POINTS = 256

/**
 * FTS 查询串净化（F-03）：剥离 C0 控制字符（含 NUL——它们会让 FTS 引擎的查询解析
 * 出错，叠加向量路异常时会连关键词路一起丢）、连续空白归一为单空格、trim，并按
 * {@link RECALL_FTS_QUERY_MAX_CODE_POINTS} 截断 code points。
 *
 * 净化后的串经 `$q` **参数绑定**送进语句（prepare+execute，绝不内联）——注入片段
 * 天然被当数据。探针 P2 复测（2026-11-14，@ladybugdb/core 0.22.3，native 与 wasm
 * 双后端实测，见 ledger-3-1.tsv）：`$q` 绑定在完整语句形态下均可正常命中，缺参抛
 * `Parameter q not found.`——实现期「绑定静默返回空、必须内联」的结论不可复现。
 */
export function sanitizeFtsQuery(query: string): string {
  const singleLine = query.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return Array.from(singleLine).slice(0, RECALL_FTS_QUERY_MAX_CODE_POINTS).join('')
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
  /**
   * priority 二次加权系数（Config `priorityWeight`，缺省 0.5）：排序分再乘
   * `1 + priorityWeight × priority/100`。0 = 关闭 priority 影响（spec D4）。
   */
  readonly priorityWeight: number
  /** 结果条数（夹紧 [1,20]，缺省 5）。 */
  readonly limit: number
  /** 层过滤（`'L1' | 'L2'`）；缺省不过滤（未指定时 L2 优先于 L1 由层权重承载）。 */
  readonly layer?: string | null
  /** 当前时刻（缺省 `new Date().toISOString()`；测试注入）。 */
  readonly now?: string
  /**
   * 调用方的取消信号（F-09：宿主 `ToolExecutionInput.signal` 透传）。
   * LadybugDB 0.22.3 无查询取消 API，故这里只在**每条语句前后**检查：已取消则不再发下一条、
   * 原样抛出取消原因（由工具面收敛为失败信封），绝不让中断后的召回继续跑完整流程。
   */
  readonly signal?: AbortSignal
}

export interface RecallResultItem {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  /** text 超过 {@link RECALL_TEXT_TOKEN_BUDGET} token 时已截断为「首段 + …」，此处为 true。 */
  readonly truncated?: boolean
  /** 非空 `source_refs`（证据引用）；空时缺省，不出现空数组。 */
  readonly evidence?: readonly string[]
}

export interface RecallCoreResult {
  readonly total: number
  readonly results: readonly RecallResultItem[]
  /** true = 只走了关键词单路（无查询向量，或向量路查询异常降级），降级必须可见（FR-11）。 */
  readonly degraded: boolean
  readonly hint: string
  /**
   * 向量路查询异常的原因（仅诊断用，最多给 `ctx.logger.warn`；**不外发**到工具/命令输出）。
   * 缺省 = 向量路没有失败（含「本来就没有查询向量」的配置态降级）。
   */
  readonly vectorError?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** 关键词路（探针 P1）：查询串经 `$q` **绑定**（绝不内联，spec Never 条），入参先过
 * {@link sanitizeFtsQuery}；K/B/TOP 同样经参数绑定。
 * 次级键 `id ASC` 钉住同分并列时的次序（否则 rank 分配不稳定 ⇒ RRF 跨进程漂移）。 */
const KEYWORD_PATH_STATEMENT = [
  `CALL QUERY_FTS_INDEX('${MEMORY_TABLE}', '${FTS_INDEX_NAME}', $q, K := $k, B := $b, TOP := $top)`,
  'WITH node, score',
  'MATCH (node)',
  'WHERE ' + currentSnapshotPredicate('node'),
  'RETURN node.id AS id, node.layer AS layer, node.kind AS kind, node.priority AS priority,',
  '  node.text AS text, node.recorded_at AS recorded_at, node.source_refs AS source_refs, score',
  'ORDER BY score DESC, id ASC',
].join('\n')

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
 * 降级阶梯（spec I/O 矩阵「向量路异常」行）：向量路查询异常（扩展未装 / 索引缺失 /
 * `QUERY_VECTOR_INDEX` 抛错）**只降级向量路**——继续关键词路、结果标 `degraded: true`、
 * 原因经 {@link RecallCoreResult.vectorError} 交给调用方记 warn。关键词路的命中绝不因
 * 向量路故障丢失。仅当**两路都失败**时才抛（工具面收敛为失败信封）。
 *
 * 无命中不是错误：返回 `total: 0` 的正常成功值。
 */
export async function runRecallCore(input: RecallCoreInput): Promise<RecallCoreResult> {
  const now = input.now ?? new Date().toISOString()
  const rrfK = input.rrfK
  const topK = Math.max(1, Math.trunc(input.retrievalTopK))
  // F-03：关键词路的查询串一律先净化（剥离 C0 控制字符 + 限长 256 code points）再绑定。
  // 净化只作用于 FTS 面：向量路仍用原始 query（embedding 侧无解析面）。
  const query = sanitizeFtsQuery(input.query)
  const candidates = new Map<string, RecallCandidate>()
  const hasQueryVector = input.queryVector !== null && input.queryVector.length > 0

  // ---- 向量路：有查询向量才走；模型不符的节点已在 Cypher 内排除。 ----
  // 异常不冒泡（F-01）：本路失败只降级，关键词路有独立预算（spec I/O 矩阵 :65）。
  let vectorRows: Record<string, unknown>[] = []
  let vectorError: string | undefined
  if (hasQueryVector) {
    // F-09：发语句前先看取消信号；catch 里若已取消则原样抛（不当作「向量路异常降级」）。
    input.signal?.throwIfAborted()
    try {
      vectorRows = await queryRows(input.connection, VECTOR_PATH_STATEMENT, {
        q: [...input.queryVector!],
        k: topK,
        model_id: input.embeddingModelId,
        now,
      })
    } catch (error) {
      if (input.signal?.aborted) throw error
      vectorError = errorMessage(error)
    }
  }
  addRankedRows(candidates, vectorRows, rrfK)

  // ---- 关键词路：FTS 查询串经 $q 绑定（P2 复测：绑定可用，内联弃用）；空串不发查询。 ----
  let keywordRows: Record<string, unknown>[] = []
  let keywordError: unknown
  if (query !== '') {
    input.signal?.throwIfAborted()
    try {
      keywordRows = await queryRows(input.connection, KEYWORD_PATH_STATEMENT, {
        q: query,
        k: BM25_K,
        b: BM25_B,
        top: topK,
        now,
      })
    } catch (error) {
      if (input.signal?.aborted) throw error
      keywordError = error
    }
  }
  // 两路都失败 ⇒ 没有任何可用结果，原样抛（工具面收敛成 failed 信封，不静默返回空）。
  input.signal?.throwIfAborted()
  if (vectorError !== undefined && keywordError !== undefined) throw keywordError
  addRankedRows(candidates, keywordRows, rrfK)

  const degraded = !hasQueryVector || vectorError !== undefined

  // ---- RRF → 层权重 × priority 乘法系数（score 只作排序，不外发）。 ----
  const layerWeightOf = (layer: string): number => {
    if (layer === 'L2') return input.layerWeights.l2
    if (layer === 'L1') return input.layerWeights.l1
    return 1
  }
  const scored = [...candidates.values()].map((candidate) => ({
    candidate,
    score: candidate.rrf * layerWeightOf(candidate.layer) * priorityFactor(candidate.priority, input.priorityWeight),
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

  // ---- 层过滤 → 标注 truncated / evidence，再 limit 截断。 ----
  const layerFilter = input.layer?.trim()
  const filtered = layerFilter ? scored.filter((entry) => entry.candidate.layer === layerFilter) : scored
  const limit = clampRecallLimit(input.limit)
  // total 语义（spec D6）：limit 截断**前**的融合命中总数；results.length = min(limit, total)。
  // 没有命中时即 0——limit 并存时 total 才有信息量（「还有多少没显示」）。
  const total = filtered.length
  const results: RecallResultItem[] = filtered.slice(0, limit).map(({ candidate }) => {
    const truncated = truncateRecallText(candidate.text)
    return {
      id: candidate.id,
      layer: candidate.layer,
      kind: candidate.kind,
      priority: candidate.priority,
      text: truncated.text,
      ...(truncated.truncated ? { truncated: true } : {}),
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

  return {
    total,
    results,
    degraded,
    hint,
    ...(vectorError !== undefined ? { vectorError } : {}),
  }
}

/**
 * 写入去重与指纹幂等（Story 2.4；契约见 epic-2-context.md:25 的『写入去重双路径』）。
 *
 * `writeDeduplicatedMemory` 是**按 layer 参数化**的写入原语（U9：2.5 复用同一原语写 L2），
 * 按顺序判定三条路径：
 * ① 指纹幂等——同 (layer, 归一化 text) 已有节点：走既有 MERGE 语义（追加 source_refs、
 *    保留最早 recorded_at、kind/priority 以最新写入为准），不新建节点；
 * ② 语义重复——cosine ≥ 0.97 命中同 layer 有效节点：向**最近**命中节点追加 source_refs，
 *    **不新建节点**，也不改目标的 kind/priority/recorded_at（AC 只要求追加 source_refs）；
 * ③ 版本作废——cosine ∈ [0.90, 0.97) 且 source_refs 有非空交集、且**唯一命中**：
 *    旧节点置 invalid_at、新节点记 parent_id = 旧 id（prd.md:172 权威读法：parent_id 挂新节点）。
 *
 * 判定前置（U8）：`embedding` 缺省/null（Epic 1 直写、写时嵌入失败、embedding disabled）时
 * **整段跳过** ANN——不查库、不发网络，只走路径①。库内 pin 的 dim 缺失或与本次向量长度不符时
 * 同样跳过：绝不把未校验的维度拼进语句。
 *
 * 审计（U10，沿用写路径既有先例）：路径②写 `merge_semantic`、路径③写 `invalidate_version`，
 * 均 kind='capture'、policy=DEFAULT_CAPTURE_POLICY，reason 写明相似度/距离与阈值。
 * AD-10 置序：**同一事务内先写 log、后写节点/指针**（本原语不自开事务——必须由调用方开，
 * 与 writeMemoryVersion 同一契约；直接调 upsertMemory 会在事务内重入）。
 * 本 story **刻意不用 keyed_decision**：AD-18 的键式裁决属 Story 2.6 的核实/裁决范围，
 * 2.4 只做写入去重，复用既有 generation_log 15 列即可。
 *
 * 阈值语义（U7）：0.97 与 0.90 均为**自定初值**，原『取自 Hindsight 实测』已作废，
 * 待首周冒烟用真实语料标定——改动只允许动本文件的常量。
 */
import type * as lbug from '@ladybugdb/core'
import {
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  INVALIDATE_VERSION_ACTION,
  MERGE_SEMANTIC_ACTION,
  insertGenerationLog,
} from './audit.js'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import {
  getMemoryById,
  writeMemoryVersion,
  type MemoryConnection,
  type UpsertMemoryInput,
} from './memory.js'
import { collectRows } from './rows.js'
import { META_KEYS, META_TABLE, MEMORY_TABLE, VECTOR_INDEX_NAME } from './schema.js'

/** 语义重复阈值（cosine）：≥ 该值判为同一条事实的另一种表述（epic-2-context.md:25）。 */
export const SEMANTIC_DUP_THRESHOLD = 0.97

/** 版本亲缘窗口下界（cosine）：[下界, 语义重复阈值) 才可能是同一事实的新旧版本。 */
export const VERSION_AFFINITY_MIN_SIMILARITY = 0.9

/**
 * ANN 取回的候选数（U3）。ANN 之后还要按 layer / 有效性 / 亲缘过滤，会吃掉一部分命中，
 * 所以 k 必须显著大于「期望的有效近邻数」，不能按需要的条数取。
 */
export const DEDUP_TOP_K = 20

/**
 * 单次 ANN 粗筛的 distance 上界 = 1 − 版本亲缘下界 + 1e-4 浮点余量（0.1001）。
 *
 * distance = 1 − cosine，故 [0.90, 0.97) 的 cosine 对应 distance ∈ (0.03, 0.10]。
 * 若粗筛仍按「语义重复」的 0.03 取，版本链候选永远取不回来（U2 整条死路）——
 * 所以这里一次粗筛就放到 0.10，再由下面的精确余弦复核分路，避免跑两次 ANN。
 * 该上界由 Lead 在 2026-11-12 明确批准（见 spec 的 Spec Change Log）。
 */
export const SEMANTIC_WINDOW_MAX_DISTANCE = 1 - VERSION_AFFINITY_MIN_SIMILARITY + 1e-4

/** 一条写入的判定结果。`created` 表示没有命中任何去重路径、写入了新节点。 */
export type DedupOutcome =
  | 'fingerprint-merge'
  | 'semantic-merge'
  | 'version-invalidated'
  | 'created'

export interface DedupWriteResult {
  /** 本次写入最终归属的节点 id（路径①②是既有节点，路径③/new 是新节点）。 */
  id: string
  /** 该节点最终的 recorded_at（路径①可能比本次写入更早）。 */
  recordedAt: string
  outcome: DedupOutcome
  /** 仅在版本作废路径出现：新节点挂的 parent_id（= 被作废的旧版本 id）。 */
  parentId?: string | null
}

export interface DedupOptions {
  /** 操作时间来源（测试注入用）。 */
  now?: () => Date
  /** 去重扫描失败时的告警出口（去重是守门而非致命，失败只告警不阻塞写入）。 */
  logger?: { warn(message: string): void }
}

/** ANN 粗筛：`WITH node, distance MATCH (node) WHERE ...` 的谓词顺序由 brief-2-4:10-93 探针锁定。 */
const ANN_CANDIDATE_STATEMENT = [
  `CALL QUERY_VECTOR_INDEX('${MEMORY_TABLE}', '${VECTOR_INDEX_NAME}', $q, $k)`,
  'WITH node, distance',
  'MATCH (node)',
  'WHERE node.layer = $layer',
  '  AND node.id <> $self_id',
  '  AND node.valid_at <= $now AND node.recorded_at <= $now',
  '  AND node.invalid_at IS NULL AND node.expired_at IS NULL',
  '  AND distance <= $max_distance',
  'RETURN node.id AS id, node.source_refs AS source_refs,',
  '       node.invalid_at AS invalid_at, node.expired_at AS expired_at',
  'ORDER BY distance',
].join('\n')

const MERGE_SOURCE_REFS_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.id = $id',
  'SET m.source_refs = list_distinct(list_concat(m.source_refs, $source_refs))',
  'RETURN m.recorded_at AS recorded_at',
].join('\n')

const INVALIDATE_NODE_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.id = $id',
  'SET m.invalid_at = $invalid_at',
  'RETURN m.id AS id',
].join('\n')

interface DedupCandidate {
  id: string
  sourceRefs: string[]
  invalidAt: string | null
  expiredAt: string | null
  similarity: number
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

function nullishString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

async function queryRows(
  connection: MemoryConnection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/** 库内 pin 的 embedding 维度；缺失或非正整数一律 null（不信任库外输入）。 */
async function readPinnedEmbeddingDim(connection: MemoryConnection): Promise<number | null> {
  const rows = await queryRows(
    connection,
    `MATCH (m:${META_TABLE}) WHERE m.key = $key RETURN m.value AS value`,
    { key: META_KEYS.embeddingDim },
  )
  const raw = rows[0]?.value
  if (raw === undefined || raw === null) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

/** 精确余弦复核（U4）：`array_cosine_similarity` + CAST 到库内 pin 的 dim，不用 float32 近似值。 */
async function preciseSimilarity(
  connection: MemoryConnection,
  id: string,
  vector: readonly number[],
  dim: number,
): Promise<number> {
  const rows = await queryRows(
    connection,
    `MATCH (m:${MEMORY_TABLE}) WHERE m.id = $id ` +
      `RETURN array_cosine_similarity(m.embedding, CAST($q AS FLOAT[${dim}])) AS sim`,
    { id, q: [...vector] },
  )
  const sim = rows[0]?.sim
  return typeof sim === 'number' ? sim : Number(sim ?? 0)
}

/** 同 layer（U6）+ 仍有效的候选；逐条再算精确相似度。 */
async function findSemanticCandidates(
  connection: MemoryConnection,
  input: { layer: string; vector: readonly number[]; dim: number; selfId: string; nowIso: string },
): Promise<DedupCandidate[]> {
  const rows = await queryRows(connection, ANN_CANDIDATE_STATEMENT, {
    q: [...input.vector],
    k: DEDUP_TOP_K,
    layer: input.layer,
    self_id: input.selfId,
    now: input.nowIso,
    max_distance: SEMANTIC_WINDOW_MAX_DISTANCE,
  })
  const candidates: DedupCandidate[] = []
  for (const row of rows) {
    const id = String(row.id)
    candidates.push({
      id,
      sourceRefs: toStringArray(row.source_refs),
      invalidAt: nullishString(row.invalid_at),
      expiredAt: nullishString(row.expired_at),
      similarity: await preciseSimilarity(connection, id, input.vector, input.dim),
    })
  }
  return candidates
}

/** 两条 source_refs 是否有非空交集（U2 的亲缘判据②）。 */
function hasSourceRefOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false
  const seen = new Set(left)
  return right.some((ref) => seen.has(ref))
}

/**
 * 旧版本的 invalid_at（X4，照 AD-19:177）：新旧事实区间**重叠**时对齐**触发事实的 valid_at**
 * （即新节点 valid_at），**不重叠**才用 now。旧节点仍有效时其区间上界为无穷，必然重叠。
 */
function computeInvalidationAt(
  oldInvalidAt: string | null,
  oldExpiredAt: string | null,
  newValidAt: string,
  nowIso: string,
): string {
  const oldEnd = oldInvalidAt ?? oldExpiredAt
  if (oldEnd !== null && newValidAt >= oldEnd) return nowIso
  return newValidAt
}

/** 路径②：向既有节点追加 source_refs，返回其 recorded_at。 */
async function mergeSourceRefs(
  connection: MemoryConnection,
  id: string,
  sourceRefs: readonly string[],
): Promise<string> {
  const rows = await queryRows(connection, MERGE_SOURCE_REFS_STATEMENT, {
    id,
    source_refs: [...sourceRefs],
  })
  const row = rows[0]
  if (row === undefined) {
    throw new MemoryDbError('db_open_failed', `语义合并未命中目标节点（id=${id}）`)
  }
  return String(row.recorded_at)
}

/** 路径③：旧版本置 invalid_at（只置 invalid_at，不置 expired_at）。 */
async function invalidateMemoryNode(
  connection: MemoryConnection,
  id: string,
  invalidAt: string,
): Promise<void> {
  const rows = await queryRows(connection, INVALIDATE_NODE_STATEMENT, { id, invalid_at: invalidAt })
  if (rows.length === 0) {
    throw new MemoryDbError('db_open_failed', `版本作废未命中旧节点（id=${id}）`)
  }
}

/**
 * 写入一条记忆并按去重双路径归并（Story 2.4）。
 *
 * **必须由调用方开启事务**（与 writeMemoryVersion 同一契约）——三条路径都可能同时写
 * generation_log 与节点/指针，必须原子。
 */
export async function writeDeduplicatedMemory(
  connection: MemoryConnection,
  input: UpsertMemoryInput,
  options?: DedupOptions,
): Promise<DedupWriteResult> {
  const now = (options?.now ?? (() => new Date())).call(undefined)
  const nowIso = now.toISOString()
  const newValidAt = input.validAt ?? nowIso
  const sourceRefs = (input.sourceRefs ?? []).map(String)
  const id = memoryNodeId(input.layer, input.text)

  // ---- 路径①：指纹幂等（FR-15 路径①）----
  const existing = await getMemoryById(connection, id)
  if (existing !== null) {
    const written = await writeMemoryVersion(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'fingerprint-merge' }
  }

  // ---- 路径②③前置：无向量整段跳过（U8：不查库、不发网络）----
  const vector = input.embedding == null ? null : Array.from(input.embedding, (value) => Number(value))
  if (vector === null || vector.length === 0) {
    const written = await writeMemoryVersion(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
  }
  const dim = await readPinnedEmbeddingDim(connection)
  if (dim === null || dim !== vector.length) {
    const written = await writeMemoryVersion(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
  }

  // ---- ANN 粗筛 + 精确复核 ----
  let candidates: DedupCandidate[] = []
  try {
    candidates = await findSemanticCandidates(connection, {
      layer: input.layer.trim(),
      vector,
      dim,
      selfId: id,
      nowIso,
    })
  } catch (error) {
    // 去重是守门而非致命：向量索引缺失/扩展未装载等失败按「无候选」处理，绝不阻塞写入
    // （宁可留下重复节点，也不能丢数据）。
    options?.logger?.warn(`语义去重扫描失败，按无候选写入：${(error as Error).message}`)
    candidates = []
  }

  // ---- 路径②：语义重复（cosine ≥ 0.97）----
  const duplicate = candidates.find((candidate) => candidate.similarity >= SEMANTIC_DUP_THRESHOLD)
  if (duplicate !== undefined) {
    await insertGenerationLog(connection, {
      recordedAt: nowIso,
      actor: input.actor ?? 'system',
      kind: CAPTURE_KIND,
      action: MERGE_SEMANTIC_ACTION,
      policy: DEFAULT_CAPTURE_POLICY,
      l0Refs: sourceRefs,
      outcome: 'success',
      reason: `semantic-merge similarity=${duplicate.similarity.toFixed(4)} threshold=${SEMANTIC_DUP_THRESHOLD}`,
    })
    const recordedAt = await mergeSourceRefs(connection, duplicate.id, sourceRefs)
    return { id: duplicate.id, recordedAt, outcome: 'semantic-merge' }
  }

  // ---- 路径③：版本作废（[0.90, 0.97) + 亲缘 + 唯一命中）----
  const versionHits = candidates.filter(
    (candidate) =>
      candidate.similarity >= VERSION_AFFINITY_MIN_SIMILARITY &&
      candidate.similarity < SEMANTIC_DUP_THRESHOLD &&
      hasSourceRefOverlap(candidate.sourceRefs, sourceRefs),
  )
  if (versionHits.length > 1) {
    // 命中多条：无从判断谁是旧版本 ⇒ 一律不作废（安全缺省），记 uncertain 供 7.2 过滤。
    await insertGenerationLog(connection, {
      recordedAt: nowIso,
      actor: input.actor ?? 'system',
      kind: CAPTURE_KIND,
      action: INVALIDATE_VERSION_ACTION,
      policy: DEFAULT_CAPTURE_POLICY,
      l0Refs: sourceRefs,
      outcome: 'uncertain',
      reason: 'ambiguous-version-candidates',
    })
    const written = await writeMemoryVersion(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
  }
  const oldVersion = versionHits[0]
  if (oldVersion !== undefined) {
    const invalidAt = computeInvalidationAt(oldVersion.invalidAt, oldVersion.expiredAt, newValidAt, nowIso)
    // AD-10 置序：先写 log，再动作废指针与新建节点。
    await insertGenerationLog(connection, {
      recordedAt: nowIso,
      actor: input.actor ?? 'system',
      kind: CAPTURE_KIND,
      action: INVALIDATE_VERSION_ACTION,
      policy: DEFAULT_CAPTURE_POLICY,
      l0Refs: sourceRefs,
      outcome: 'success',
      reason:
        `version-presentation similarity=${oldVersion.similarity.toFixed(4)} ` +
        `window=[${VERSION_AFFINITY_MIN_SIMILARITY},${SEMANTIC_DUP_THRESHOLD}) invalid_at=${invalidAt}`,
    })
    await invalidateMemoryNode(connection, oldVersion.id, invalidAt)
    const written = await writeMemoryVersion(connection, { ...input, parentId: oldVersion.id }, options)
    return {
      id: written.id,
      recordedAt: written.recordedAt,
      outcome: 'version-invalidated',
      parentId: oldVersion.id,
    }
  }

  // ---- 无命中：写新节点 ----
  const written = await writeMemoryVersion(connection, input, options)
  return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
}

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
 * 同样跳过 ANN，并且**剥离向量再写**（评审 P5）：绝不把未校验长度的向量绑进 FLOAT[dim]，
 * 那是必抛错、并把调用方整个事务（一条精炼的全部事实）一起回滚的写法。
 *
 * 路径①的墓碑语义（评审 P1，EC-1）：指纹命中一个**已被路径③作废**的节点时必须**复活**它
 * （清 invalid_at、valid_at 提到本次事实的时间，其余按既有 MERGE 语义合并）——id 由
 * uuid5(layer:归一化文本) 决定，同文本无法生成第二个 id，不复活等于把重申的事实永久丢出 recall。
 * 命中一个 **expired_at 置位**的节点（用户显式 forget，prd.md:293）则**不复活**：用户删除优先，
 * 只记一条 uncertain 审计供 7.2 过滤。
 *
 * 审计（U10，沿用写路径既有先例）：路径①复活写 `resurrect_memory`、路径②写 `merge_semantic`、
 * 路径③写 `invalidate_version`，均 kind='capture'、policy=DEFAULT_CAPTURE_POLICY，reason 写明
 * 相似度/阈值与前值。
 * AD-10 置序：**同一事务内先写 log、后写节点/指针**（本原语不自开事务——必须由调用方开，
 * 与 writeMemoryVersion 同一契约；直接调 upsertMemory 会在事务内重入）。
 *
 * 路径③还必须落一条 **keyed_decision**（评审 P4，Lead 改裁）：原裁决以为 2.4 不做裁决，但漏看
 * 了用户可见后果——audit_gap 的判据是「已失效且无 `old_id = m.id` 的裁决行」，只写
 * generation_log 会让**每一次正常版本替换都永久计入 audit_gap**（/memory status 单调上涨的假警报）。
 * 故此处显式给出 action='supersede' + resolutionSource='auto' + policy=DEFAULT_CAPTURE_POLICY；
 * audit.ts 早已预定义这三档，并注明「真出现版本写入时由裁决方显式给出 policy」。
 * AD-18 的**读侧**裁决仍属 Story 2.6，本原语只负责把这次替代写成可重建的证据。
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
  RESURRECT_MEMORY_ACTION,
  buildJudgeKey,
  insertGenerationLog,
  insertKeyedDecision,
  type GenerationLogOutcome,
} from './audit.js'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import {
  DEFAULT_MEMORY_KIND,
  DEFAULT_MEMORY_PRIORITY,
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
  /**
   * ANN 扫描失败时的处置（Story 2.6 评审补钉 P20）：
   * - `'degrade'`（缺省，2.4 语义）：吞错、按「无候选」继续写、只告警；
   * - `'throw'`：抛 {@link SemanticScanError} 让调用方事务干净回滚。
   *
   * 为什么需要后者：LadybugDB 0.22.3 里**事务内任一语句报错即中止整个事务**（后续语句被
   * 静默丢弃，COMMIT 抛 'No active transaction for COMMIT.'）。因此在别人的事务里吞掉扫描
   * 错误再继续写是**假降级**——写入全部丢失。需要降级语义的宿主应先以 'throw' 试一次，
   * 捕获后带 {@link DedupOptions.skipSemanticScan} 重试。
   */
  scanFailure?: 'degrade' | 'throw'
  /**
   * 整段跳过 ANN（只走指纹路径①）。给「上一轮扫描把事务搞中止」的调用方重试用：
   * 与 `embedding: null` 不同，向量仍按原样写入（失效索引要靠这次成功提交自愈）。
   */
  skipSemanticScan?: boolean
}

/**
 * ANN 粗筛/复核失败（仅 `scanFailure: 'throw'` 时抛）。调用方应把它当作**可重试的降级信号**，
 * 而不是条目失败：同一个事务带 `skipSemanticScan: true` 重跑一次即可正常写入。
 */
export class SemanticScanError extends Error {
  readonly reason = 'semantic-scan-failed'

  constructor(cause: unknown) {
    super('语义去重扫描失败（ANN）: ' + (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'SemanticScanError'
  }
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
  'RETURN node.id AS id, node.source_refs AS source_refs, node.valid_at AS valid_at',
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

/**
 * 路径①的复活（评审 P1）：清 invalid_at、把 valid_at 提到本次事实的时间；其余按既有 MERGE
 * 语义——合并 source_refs、kind/priority 取最新、recorded_at 仍取最早。
 */
const RESURRECT_NODE_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.id = $id',
  'SET m.invalid_at = null, m.valid_at = $valid_at,',
  '  m.source_refs = list_distinct(list_concat(m.source_refs, $source_refs)),',
  '  m.kind = $kind, m.priority = $priority,',
  '  m.recorded_at = CASE WHEN $recorded_at < m.recorded_at THEN $recorded_at ELSE m.recorded_at END',
  'RETURN m.id AS id, m.recorded_at AS recorded_at',
].join('\n')

interface DedupCandidate {
  id: string
  sourceRefs: string[]
  /** 旧节点自身的 valid_at（评审 P3）：作废上界必须不早于它，否则造出倒置区间。 */
  validAt: string | null
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

/**
 * 库内 pin 的 embedding 维度；缺失或非正整数一律 null（不信任库外输入）。
 * 导出给回填复用（评审 P9④：回填每轮也要按库内 pin 的维度校验向量长度，不复制这份判据）。
 */
export async function readPinnedEmbeddingDim(connection: MemoryConnection): Promise<number | null> {
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

/**
 * 精确余弦复核（U4）的语句：`array_cosine_similarity` + CAST 到库内 pin 的 dim，不用 float32 近似值。
 * 语句只随 dim 变，故在候选循环外 **prepare 一次、循环内复用**（评审 P7：原先每条候选各 prepare
 * 一次，k=20 时单事务最坏 ~170 次往返，而且全程持写锁）。
 */
function preciseSimilarityStatement(dim: number): string {
  return (
    `MATCH (m:${MEMORY_TABLE}) WHERE m.id = $id ` +
    `RETURN array_cosine_similarity(m.embedding, CAST($q AS FLOAT[${dim}])) AS sim`
  )
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
  const precise = await connection.prepare(preciseSimilarityStatement(input.dim))
  const candidates: DedupCandidate[] = []
  for (const row of rows) {
    const id = String(row.id)
    const simRows = await collectRows(await connection.execute(precise, { id, q: [...input.vector] }))
    const sim = simRows[0]?.sim
    candidates.push({
      id,
      sourceRefs: toStringArray(row.source_refs),
      validAt: nullishString(row.valid_at),
      similarity: typeof sim === 'number' ? sim : Number(sim ?? 0),
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

/*
 * X4 收窄（评审 P3）：候选谓词已经排除 invalid_at / expired_at 非空的节点，所以旧版本此刻
 * **必无上界区间**——原实现里「不重叠 ⇒ 用 now」的分支不可达（也没有任何测试能钉住），已删除。
 * 保留的实质要求是「invalid_at 对齐触发事实的 valid_at，且绝不早于旧节点自身 valid_at」，
 * 见路径③的 `invalidAt = newValidAt > oldValidAt ? newValidAt : oldValidAt`。
 */

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
 * 无向量写入（评审 P5）：三条「跳过 ANN」的分支共用同一实现，**绝不**把未校验长度的向量
 * 交给 writeMemoryVersion（那会绑进 FLOAT[dim] 并抛错回滚调用方整个事务）。
 */
async function writeNoVector(
  connection: MemoryConnection,
  input: UpsertMemoryInput,
  options?: DedupOptions,
): Promise<{ id: string; recordedAt: string }> {
  const written = await writeMemoryVersion(
    connection,
    { ...input, embedding: null, embeddingModelId: null },
    options,
  )
  return { id: written.id, recordedAt: written.recordedAt }
}

/** 路径①的复活：清 invalid_at + 提 valid_at，返回节点最终 recorded_at（保留最早）。 */
async function resurrectMemoryNode(
  connection: MemoryConnection,
  input: {
    id: string
    validAt: string
    sourceRefs: readonly string[]
    kind?: string | null
    priority?: number | null
    recordedAt: string
  },
): Promise<string> {
  const rows = await queryRows(connection, RESURRECT_NODE_STATEMENT, {
    id: input.id,
    valid_at: input.validAt,
    source_refs: [...input.sourceRefs],
    kind: input.kind ?? DEFAULT_MEMORY_KIND,
    priority: Math.trunc(input.priority ?? DEFAULT_MEMORY_PRIORITY),
    recorded_at: input.recordedAt,
  })
  const row = rows[0]
  if (row === undefined) {
    throw new MemoryDbError('db_open_failed', `复活未命中节点（id=${input.id}）`)
  }
  return String(row.recorded_at)
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
  // 评审 P8：入口一次性归一化 layer，id 与 ANN 谓词共用同一个值。原先 id 用未 trim 的
  // input.layer、ANN 谓词用 trim 后的值，writeMemoryVersion 的属性也用 trim 后的值 ⇒
  // 含空白的 layer 会出现「id 归属 A 层、属性与 ANN 在 B 层」的分叉。
  const layer = input.layer.trim()
  const id = memoryNodeId(layer, input.text)

  // ---- 向量可用性（评审 P5 / EC-5）：绑进 FLOAT[dim] 之前先把长度校验掉 ----
  // 原先「维度失配」分支只跳过 ANN、仍把原 input 交给 writeMemoryVersion ⇒ 未校验长度的向量被绑进
  // FLOAT[dim]，必然抛错并回滚调用方整个事务（一条精炼的全部事实一起丢）。校验提到三条路径之前后，
  // **本函数内任何写入都只绑已验证长度的向量**（指纹命中路径同样受保护）。
  const vector = input.embedding == null ? null : Array.from(input.embedding, (value) => Number(value))
  const dim = vector === null || vector.length === 0 ? null : await readPinnedEmbeddingDim(connection)
  if (vector !== null && vector.length > 0 && (dim === null || dim !== vector.length)) {
    options?.logger?.warn(
      dim === null
        ? `语义去重跳过：库内未 pin embedding 维度，本次向量长度=${vector.length}`
        : `语义去重跳过：库内 pin 的 dim=${dim}，本次向量长度=${vector.length}`,
    )
  }
  // embedding 为 null 时原样传（写入语句本就不绑三列）；空数组或维度不可用时剥离，绝不带未校验向量。
  const writeInput: UpsertMemoryInput =
    input.embedding == null || (vector !== null && vector.length > 0 && dim === vector.length)
      ? input
      : { ...input, embedding: null, embeddingModelId: null }

  // 五条路径的审计行共用同一组记账字段（U10）：只有 action / outcome / reason 不同。
  // 与 processor.ts 同一契约——不自开事务，事务边界由调用方决定（本原语整体在同一事务内）。
  const audit = (action: string, outcome: GenerationLogOutcome, reason: string): Promise<string> =>
    insertGenerationLog(connection, {
      recordedAt: nowIso,
      actor: input.actor ?? 'system',
      kind: CAPTURE_KIND,
      action,
      policy: DEFAULT_CAPTURE_POLICY,
      l0Refs: sourceRefs,
      outcome,
      reason,
    })

  // ---- 路径①：指纹幂等（FR-15 路径①）+ 墓碑语义（评审 P1）----
  const existing = await getMemoryById(connection, id)
  if (existing !== null) {
    if (existing.expiredAt !== null) {
      // 用户显式 forget（prd.md:293）优先于自动复活：保留失效态，只记一条 uncertain 供 7.2 过滤。
      // 评审 P19a（T23）：**仍要合并 source_refs**。processor 会为本次观测量出
      // l0_raw→该节点 的 EVIDENCE 边（事实层面为真：这次观测确实产出过这条记忆），
      // 而 EFFECTIVE_MEMORY_REFS / computeEvidenceDrift 都过滤 expired_at IS NULL ⇒
      // 不合并的话边与 source_refs 两个载体永久不一致且不可见。
      // 不动 expired_at / invalid_at（不复活），outcome 仍为 fingerprint-merge。
      await mergeSourceRefs(connection, existing.id, sourceRefs)
      await audit(RESURRECT_MEMORY_ACTION, 'uncertain', `skip-resurrect expired_at=${existing.expiredAt}`)
      return { id: existing.id, recordedAt: existing.recordedAt, outcome: 'fingerprint-merge' }
    }
    if (existing.invalidAt !== null) {
      // 被路径③作废的旧版本被重申：**复活**。同文本生成不出第二个 id，不复活就等于把这条
      // 事实永久留在 recall 之外（评审 P1 / EC-1）。
      await audit(RESURRECT_MEMORY_ACTION, 'success', `revive previous_invalid_at=${existing.invalidAt}`)
      const recordedAt = await resurrectMemoryNode(connection, {
        id,
        validAt: newValidAt,
        sourceRefs,
        kind: input.kind,
        priority: input.priority,
        recordedAt: input.recordedAt ?? nowIso,
      })
      return { id, recordedAt, outcome: 'fingerprint-merge' }
    }
    const written = await writeMemoryVersion(connection, writeInput, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'fingerprint-merge' }
  }

  // ---- 路径②③前置：无向量 / 维度不可用 ⇒ 整段跳过（U8：不查库、不发网络）----
  if (vector === null || vector.length === 0 || dim === null || dim !== vector.length) {
    const written = await writeNoVector(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
  }

  // ---- ANN 粗筛 + 精确复核 ----
  let candidates: DedupCandidate[] = []
  if (options?.skipSemanticScan === true) {
    // 调用方上一轮已被扫描失败中止过事务（见 DedupOptions.scanFailure）：本轮整段跳过。
    // 向量照常往下传——索引要靠这次成功提交自愈。
    options.logger?.warn('语义去重扫描本轮跳过（扫描失败后的降级重试）')
  } else {
    try {
      candidates = await findSemanticCandidates(connection, {
        layer,
        vector,
        dim,
        selfId: id,
        nowIso,
      })
    } catch (error) {
      // 去重是守门而非致命：向量索引缺失/扩展未装载等失败按「无候选」处理，绝不阻塞写入
      // （宁可留下重复节点，也不能丢数据）。**但**事务内失败会中止整个事务，那种情况下继续
      // 写等于往一个已死的事务里写——所以把选择权交给调用方（scanFailure）。
      if (options?.scanFailure === 'throw') throw new SemanticScanError(error)
      options?.logger?.warn(`语义去重扫描失败，按无候选写入：${(error as Error).message}`)
      candidates = []
    }
  }

  // ---- 路径②：语义重复（cosine ≥ 0.97）----
  // 评审 P6：ANN 只给 ORDER BY distance 的粗排，精确复核后次序可能变——按**精确** similarity
  // 取最大，不能依赖候选数组的顺序。
  const duplicates = candidates.filter((candidate) => candidate.similarity >= SEMANTIC_DUP_THRESHOLD)
  const duplicate =
    duplicates.length === 0
      ? undefined
      : duplicates.reduce((best, candidate) => (candidate.similarity > best.similarity ? candidate : best))
  if (duplicate !== undefined) {
    await audit(
      MERGE_SEMANTIC_ACTION,
      'success',
      `semantic-merge similarity=${duplicate.similarity.toFixed(4)} threshold=${SEMANTIC_DUP_THRESHOLD}`,
    )
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
    await audit(INVALIDATE_VERSION_ACTION, 'uncertain', 'ambiguous-version-candidates')
    const written = await writeMemoryVersion(connection, input, options)
    return { id: written.id, recordedAt: written.recordedAt, outcome: 'created' }
  }
  const oldVersion = versionHits[0]
  if (oldVersion !== undefined) {
    // X4（评审 P3）：候选谓词已排除 invalid_at / expired_at 非空的节点，旧版本此刻必无上界区间，
    // 所以 invalid_at 对齐**触发事实的 valid_at**；同时绝不早于旧节点自身 valid_at（EC-2 的
    // 倒置区间：2.5 复用本原语时可能传入更早的 validAt）。
    const oldValidAt = oldVersion.validAt ?? newValidAt
    const invalidAt = newValidAt > oldValidAt ? newValidAt : oldValidAt
    // AD-10 置序：先写 log，再写键式裁决，再动作废指针，最后写新节点。
    await audit(
      INVALIDATE_VERSION_ACTION,
      'success',
      `version-presentation similarity=${oldVersion.similarity.toFixed(4)} ` +
        `window=[${VERSION_AFFINITY_MIN_SIMILARITY},${SEMANTIC_DUP_THRESHOLD}) invalid_at=${invalidAt}`,
    )
    // 评审 P4：这次版本替换必须留下**可重建的键式裁决**，否则 AUDIT_GAP_STATEMENT
    //（已失效且无 k.old_id = m.id 的裁决行）会把每一次正常替换都永久计成缺口。
    await insertKeyedDecision(connection, {
      judgeKey: buildJudgeKey(DEFAULT_CAPTURE_POLICY, oldVersion.id, id),
      newId: id,
      oldId: oldVersion.id,
      action: 'supersede',
      policy: DEFAULT_CAPTURE_POLICY,
      l0Refs: sourceRefs,
      resolutionSource: 'auto',
      ts: nowIso,
    })
    await invalidateMemoryNode(connection, oldVersion.id, invalidAt)
    // 评审 P2：把本次算定的 validAt 显式传给写入（否则 writeMemoryVersion 会再读一次时钟 T2，
    // 新节点 valid_at = T2 ≥ T1 = invalid_at，X4 的对齐就只落到毫秒级巧合上）。
    const written = await writeMemoryVersion(
      connection,
      { ...input, validAt: newValidAt, parentId: oldVersion.id },
      options,
    )
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

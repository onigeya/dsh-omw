/**
 * 类型化边的写入与读取原语（Story 2.6 / AD-4、AD-19、AD-21）。
 *
 * 本模块是 EVIDENCE / RELATED 边**唯一**的读写实现处（DDL 建表见 ensureEdgeTables）。
 *
 * - 写入一律 **MERGE**：AD-10 的崩溃重放与 X1 回填都依赖「重复写不产重边」
 *   （brief-2-6-readiness.md §2.2 ⑨ 实测重放两次边数恒为 1）。
 * - 端点标签**必须显式**（(a:l0_raw …) / (b:memory …)）：0.22.3 对无标签端点的
 *   CREATE 直接 Binder 报错（§2.3 N10）。
 * - 写前做应用层不变量校验（U5）：自环拒绝；EVIDENCE 两端 layer 必须**不同且低→高**
 *   （不要求相邻；**同层禁止 EVIDENCE**，同层关系走 RELATED）。校验失败只**跳过该边**
 *   并回报原因，绝不抛错、不阻塞记忆主路径（epics.md:706-708 的失败即跳过精神）。
 * - 原语**不自开事务**（与 writeMemoryVersion 同一契约）：调用方决定事务边界，
 *   这样 EVIDENCE 能与节点写入同事务（AD-10 置序）。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from './backend.js'
import { collectRows } from './rows.js'
import { createEvidenceTableStatement, createRelatedTableStatement, L0_RAW_TABLE, MEMORY_TABLE } from './schema.js'
import { runInTransaction } from './transaction.js'

/** EVIDENCE / RELATED 的常量名（DDL 在 schema.ts）。 */
export const EVIDENCE = 'EVIDENCE'
export const RELATED = 'RELATED'

/** 层序秩：EVIDENCE 必须「低 → 高」（U5）。L3 已退役（AD-17），不在秩内。 */
export const LAYER_RANK: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2 }

/** l0_raw 节点在层序里的逻辑层值（该表没有 layer 列，无隐式 NULL 语义可依赖）。 */
export const L0_LAYER = 'L0'

/** 层的秩；未知层返回 null（不猜）。 */
export function layerRank(layer: string): number | null {
  const rank = LAYER_RANK[layer.trim().toUpperCase()]
  return rank === undefined ? null : rank
}

/** EVIDENCE 端点顺序判据（U5）：两端 layer 不同且低→高。 */
export function isEvidenceLayerOrder(fromLayer: string, toLayer: string): boolean {
  const from = layerRank(fromLayer)
  const to = layerRank(toLayer)
  return from !== null && to !== null && from !== to && from < to
}

/** 一条待写入的 EVIDENCE 边（from = 被引用者/低层，to = 引用者/高层）。 */
export interface EvidenceEdgeInput {
  readonly fromId: string
  readonly fromLayer: string
  readonly toId: string
  readonly toLayer: string
  readonly reason?: string | null
}

/** 一条被跳过的边及其原因（应用层不变量未通过时，不写库也不抛错）。 */
export interface SkippedEdge {
  readonly reason: string
  readonly fromId: string
  readonly toId: string
}

export interface EdgeWriteResult {
  /** 真正落库（或已存在）的边数——MATCH 未命中端点时不计。 */
  readonly written: number
  readonly skipped: readonly SkippedEdge[]
}

const MERGE_EVIDENCE_FROM_L0 = [
  'MATCH (a:' + L0_RAW_TABLE + ' {id: $from_id})',
  'MATCH (b:' + MEMORY_TABLE + ' {id: $to_id})',
  'MERGE (a)-[r:' + EVIDENCE + ']->(b)',
  'ON CREATE SET r.reason = $reason',
  'RETURN b.id AS to_id',
].join('\n')

const MERGE_EVIDENCE_FROM_MEMORY = [
  'MATCH (a:' + MEMORY_TABLE + ' {id: $from_id})',
  'MATCH (b:' + MEMORY_TABLE + ' {id: $to_id})',
  'MERGE (a)-[r:' + EVIDENCE + ']->(b)',
  'ON CREATE SET r.reason = $reason',
  'RETURN b.id AS to_id',
].join('\n')

const MERGE_RELATED = [
  'MATCH (a:' + MEMORY_TABLE + ' {id: $from_id})',
  'MATCH (b:' + MEMORY_TABLE + ' {id: $to_id})',
  'MERGE (a)-[r:' + RELATED + ']->(b)',
  'ON CREATE SET r.reason = $reason',
  'RETURN b.id AS to_id',
].join('\n')

const DIRECT_IN_EDGE_IDS = [
  'MATCH (x)-[e:' + EVIDENCE + ']->(m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN x.id AS from_id',
].join('\n')

/** 建两张边表。只应在建库/打开库的唯一迁移点调用一次；DDL 在事务内执行（all-or-nothing）。
 *  必须在 memory / l0_raw 节点表之后调用——0.22.3 对不存在端点的 GROUP DDL 直接 Binder 报错
 *  （brief §2.3 N14）。只读实例走 initializeReadOnlyDatabase，不经本函数（AD-12）。 */
export async function ensureEdgeTables(connection: lbug.Connection): Promise<void> {
  await runInTransaction(connection, async () => {
    // 结果必须释放，否则 pin 满 buffer pool（见 backend.ts closeQueryResult）。
    await runStatement(connection, createEvidenceTableStatement())
    await runStatement(connection, createRelatedTableStatement())
  })
}

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue> = {},
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/**
 * 批量写 EVIDENCE 边（AD-10 置序：由调用方开事务、与节点写入同事务）。
 *
 * 逐条 MERGE；不合法（自环 / 层序）的边只跳过并回报，不影响其余边与记忆主路径。
 */
export async function writeEvidenceEdges(
  connection: lbug.Connection,
  entries: readonly EvidenceEdgeInput[],
): Promise<EdgeWriteResult> {
  const skipped: SkippedEdge[] = []
  let written = 0
  if (entries.length === 0) return { written, skipped }
  const fromL0 = await connection.prepare(MERGE_EVIDENCE_FROM_L0)
  const fromMemory = await connection.prepare(MERGE_EVIDENCE_FROM_MEMORY)
  for (const entry of entries) {
    if (entry.fromId === entry.toId) {
      skipped.push({ reason: 'self-loop', fromId: entry.fromId, toId: entry.toId })
      continue
    }
    if (!isEvidenceLayerOrder(entry.fromLayer, entry.toLayer)) {
      skipped.push({ reason: 'layer-order', fromId: entry.fromId, toId: entry.toId })
      continue
    }
    const statement = entry.fromLayer.trim().toUpperCase() === L0_LAYER ? fromL0 : fromMemory
    const rows = await collectRows(await connection.execute(statement, {
      from_id: entry.fromId,
      to_id: entry.toId,
      reason: entry.reason ?? null,
    }))
    if (rows.length > 0) {
      written += 1
    } else {
      // 评审 P6（T6）：MATCH 未命中端点时返回 0 行——既没写边也不是「已存在」，
      // 必须显式计入 skipped，否则调用方无法把「端点缺失」与「成功」区分开。
      skipped.push({ reason: 'endpoint-missing', fromId: entry.fromId, toId: entry.toId })
    }
  }
  return { written, skipped }
}

/** 批量写 RELATED 边（同层语义关联；层序由调用方按 U5 过滤，MERGE 幂等）。 */
export interface RelatedEdgeInput {
  readonly fromId: string
  readonly toId: string
  readonly reason?: string | null
}

export async function writeRelatedEdges(
  connection: lbug.Connection,
  entries: readonly RelatedEdgeInput[],
): Promise<number> {
  if (entries.length === 0) return 0
  const statement = await connection.prepare(MERGE_RELATED)
  let written = 0
  for (const entry of entries) {
    if (entry.fromId === entry.toId) continue
    const rows = await collectRows(await connection.execute(statement, {
      from_id: entry.fromId,
      to_id: entry.toId,
      reason: entry.reason ?? null,
    }))
    if (rows.length > 0) written += 1
  }
  return written
}

/** 某节点的 EVIDENCE **直接入边**低端 id 集（audit_gap 漂移基准的 B 侧）。 */
export async function readEvidenceInEdgeIds(connection: lbug.Connection, id: string): Promise<string[]> {
  const rows = await queryRows(connection, DIRECT_IN_EDGE_IDS, { id })
  return rows.map((row) => String(row.from_id))
}

// ---------------------------------------------------------------------------
// 图遍历原语（Story 3.2 / FR-12 / AC:872-889）
//
// 形态由 2026-11-14 探针钉死（probe-3-2b.md）：
// - `type()` / `last()` / `head()` 在 0.22.3 **不存在**（Catalog exception），故 edge_type
//   只能由**语句常量**给出 ⇒ EVIDENCE、RELATED 各一条无向变长语句（spec D1 方案）。
// - `relationships(p)` 可作 RETURN 值且按路径方向序列化（含 `reason`）⇒ 末元素即「最后一跳」
//   的关系，用它取 `reason`（AC:880 的可选字段）；GROUP 边上同样可用（探针 G1）。
// - 端点显式 `(n:memory)`：无向 EVIDENCE 会走到 l0_raw（探针 2b 实测），不约束会污染结果面。
// - **路径不带有效性过滤**：`all(x IN nodes(p) WHERE …)` 作 RETURN 布尔（探针 P4b/P4d：
//   作 WHERE 会整条剔掉含失效中间节点的路径，且内部参数表达式触发 0.22.3 断言）。
// ---------------------------------------------------------------------------

/** 遍历深度缺省值（AC:875）。 */
export const RELATED_DEFAULT_DEPTH = 2
/** 遍历深度上限（AC:875）。 */
export const RELATED_MAX_DEPTH = 3
/** 结果条数上限（AC:880）。 */
export const RELATED_MAX_RESULTS = 20

/** 遍历超时（AC:891-893 的降级由调用方做；本原语只负责把「超预算」变成可捕获的错误）。 */
export class RelatedTraversalTimeoutError extends Error {
  readonly reason = 'related-traversal-timeout'

  constructor(timeoutMs: number) {
    super(`记忆关联遍历超过 ${timeoutMs}ms 预算（LadybugDB 0.22.3 无查询取消 API，底层查询可能仍在跑）`)
    this.name = 'RelatedTraversalTimeoutError'
  }
}

/** `traverseRelated` 输入。`now` 不参与判据：AC:886 只按 `invalid_at` / `expired_at` 判失效。 */
export interface TraverseRelatedInput {
  readonly id: string
  /** 跳数 1..3；缺省 {@link RELATED_DEFAULT_DEPTH}，越界夹紧。 */
  readonly depth?: number
  /** 单次遍历预算（ms）；超时抛 {@link RelatedTraversalTimeoutError}。 */
  readonly timeoutMs?: number
}

/** 一个遍历命中的邻居（已按 id 归并、取最小 hops 的一条路径）。 */
export interface RelatedTraversalItem {
  readonly id: string
  readonly layer: string
  readonly text: string
  readonly hops: number
  readonly edgeType: typeof EVIDENCE | typeof RELATED
  /** 末跳关系的 reason；无则 null（AC:880 标可选）。 */
  readonly reason: string | null
  /** 节点自身失效（`invalid_at` 或 `expired_at` 非空，AC:886-888）。 */
  readonly invalid: boolean
  readonly invalidAt: string | null
  readonly expiredAt: string | null
  /**
   * 该邻居存在至少一条「路径上所有节点均未失效」的路径（spec D4 的判定原语）。
   * 只作 RETURN 布尔取回，**绝不**用于过滤（D3）；失效邻居恒为 false（自身即失效）。
   */
  readonly pathValid: boolean
}

/** 起点自身的有效性（spec D5 ②：起点失效不拦截遍历，但工具层要能提示「起点已失效」）。 */
export interface RelatedTraversalStart {
  readonly invalid: boolean
  readonly invalidAt: string | null
  readonly expiredAt: string | null
}

export interface RelatedTraversalResult {
  readonly id: string
  readonly depth: number
  /** 起点是否在库内（AC:882-884：不存在 → 空结果 + hint，由调用方渲染）。 */
  readonly startFound: boolean
  /** 起点自身有效性；`startFound:false` 时为零值。 */
  readonly start: RelatedTraversalStart
  /** 去重归并后、20 条截断**前**的邻居总数（spec D6 的 total 口径）。 */
  readonly total: number
  /** 已排序：按跳数升序；同跳有效优先于失效（AC:880/888）。 */
  readonly results: readonly RelatedTraversalItem[]
}

/** 深度夹紧的唯一实现（缺省 2、[1,3]；非有限回落缺省）。 */
export function clampRelatedDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) return RELATED_DEFAULT_DEPTH
  return Math.min(RELATED_MAX_DEPTH, Math.max(1, Math.trunc(depth)))
}

/**
 * 一条边型的无向变长路径语句。`depth` 必须内联（探针 P5：`*1..$depth` 是 Parser exception），
 * 故只接受 {@link clampRelatedDepth} 之后的 1..3 整数。
 */
function relatedTraversalStatement(edgeType: typeof EVIDENCE | typeof RELATED, depth: number): string {
  return [
    `MATCH p = (m:${MEMORY_TABLE} {id: $id})-[:${edgeType}*1..${depth}]-(n:${MEMORY_TABLE})`,
    'WHERE n.id <> $id',
    'RETURN n.id AS id, n.layer AS layer, n.text AS text,',
    '  n.invalid_at AS invalid_at, n.expired_at AS expired_at,',
    '  length(p) AS hops,',
    '  all(x IN nodes(p) WHERE x.invalid_at IS NULL AND x.expired_at IS NULL) AS path_valid,',
    '  relationships(p) AS rels',
    'ORDER BY hops ASC, id ASC',
  ].join('\n')
}

const START_NODE_STATEMENT = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN m.invalid_at AS invalid_at, m.expired_at AS expired_at',
].join('\n')

/** 起点不存在时的零值（工具层据此跳过「起点已失效」提示）。 */
const START_NOT_FOUND: RelatedTraversalStart = { invalid: false, invalidAt: null, expiredAt: null }

/**
 * 带预算的查询：`Promise.race` 只是**调用方**预算（0.22.3 无查询取消 API），超时后底层查询
 * 仍会跑完——超时方吞掉它后续的 rejection，避免未处理拒绝把宿主/进程搞崩。
 */
async function queryRowsWithinBudget(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
  timeoutMs: number | undefined,
): Promise<Record<string, unknown>[]> {
  const query = (async () => {
    const prepared = await connection.prepare(statement)
    return collectRows(await connection.execute(prepared, params))
  })()
  if (timeoutMs === undefined) return await query

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    return await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new RelatedTraversalTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) query.catch(() => {})
  }
}

function nullishString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** 从 `relationships(p)` 的末元素取 reason（形状见文件头：`{ reason, _label, … }`）。 */
function lastHopReason(rels: unknown): string | null {
  if (!Array.isArray(rels) || rels.length === 0) return null
  const last = rels[rels.length - 1] as { readonly reason?: unknown } | null
  const reason = last?.reason
  return typeof reason === 'string' && reason.length > 0 ? reason : null
}

/** 归并时的确定性取舍（spec D7）：min hops → path_valid 优先 → EVIDENCE 优先 → id 升序。 */
function isBetterTraversal(next: RelatedTraversalItem, current: RelatedTraversalItem): boolean {
  if (next.hops !== current.hops) return next.hops < current.hops
  if (next.pathValid !== current.pathValid) return next.pathValid
  if (next.edgeType !== current.edgeType) return next.edgeType === EVIDENCE
  return next.id < current.id
}

/** 把一条边型的行并入按 id 归并的表（同 id 多路径取最优一条，探针 P1/P4g 实测会重行）。 */
function mergeTraversalRows(
  merged: Map<string, RelatedTraversalItem>,
  rows: readonly Record<string, unknown>[],
  edgeType: typeof EVIDENCE | typeof RELATED,
): void {
  for (const row of rows) {
    const id = String(row.id)
    const invalidAt = nullishString(row.invalid_at)
    const expiredAt = nullishString(row.expired_at)
    const item: RelatedTraversalItem = {
      id,
      layer: String(row.layer ?? ''),
      text: String(row.text ?? ''),
      hops: Number(row.hops ?? Number.POSITIVE_INFINITY),
      edgeType,
      reason: lastHopReason(row.rels),
      invalid: invalidAt !== null || expiredAt !== null,
      invalidAt,
      expiredAt,
      pathValid: row.path_valid === true,
    }
    const current = merged.get(id)
    if (current === undefined || isBetterTraversal(item, current)) merged.set(id, item)
  }
}

/** 最终排序（AC:880「按跳数升序」为主键；同跳内有效先于失效，再按 id 升序保证确定性）。 */
function compareTraversal(a: RelatedTraversalItem, b: RelatedTraversalItem): number {
  if (a.hops !== b.hops) return a.hops - b.hops
  // AC:888 的「补入」语义：同一跳数下有效邻居排在失效邻居之前。
  if (a.invalid !== b.invalid) return a.invalid ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * 沿 EVIDENCE / RELATED 边做无向 BFS（AC:872-889 / FR-12）。
 *
 * 两条语句（两型分查）并行发出，JS 侧按 id 归并取最小 hops，然后**有效邻居优先**填满
 * {@link RELATED_MAX_RESULTS}，不足时用失效邻居补位（AC:888）。起点不存在时返回空结果 +
 * `startFound:false`（不抛错，AC:882-884）；起点自身失效不拦截（spec D5：它是锚点不是候选）。
 *
 * 只读：不写库、不开事务。
 */
export async function traverseRelated(
  connection: lbug.Connection,
  input: TraverseRelatedInput,
): Promise<RelatedTraversalResult> {
  const id = input.id
  const depth = clampRelatedDepth(input.depth)
  const [evidenceRows, relatedRows, startRows] = await Promise.all([
    queryRowsWithinBudget(connection, relatedTraversalStatement(EVIDENCE, depth), { id }, input.timeoutMs),
    queryRowsWithinBudget(connection, relatedTraversalStatement(RELATED, depth), { id }, input.timeoutMs),
    // 起点存在性/有效性：无论有无邻居都读一次（区分「起点不存在」与「起点无邻居」，
    // AC:882-884 / spec D5）；与两条遍历语句并行，不额外增加调用方等待。
    queryRowsWithinBudget(connection, START_NODE_STATEMENT, { id }, input.timeoutMs),
  ])
  const merged = new Map<string, RelatedTraversalItem>()
  mergeTraversalRows(merged, evidenceRows, EVIDENCE)
  mergeTraversalRows(merged, relatedRows, RELATED)

  const all = [...merged.values()]
  const valid = all.filter((item) => !item.invalid).sort(compareTraversal)
  const invalid = all.filter((item) => item.invalid).sort(compareTraversal)
  const validCount = Math.min(valid.length, RELATED_MAX_RESULTS)
  // AC:888 的分组只决定 **20 条入选**（有效优先、不足补失效）；展示顺序仍按 AC:880
  // 「跳数升序」——把失效组直接追加在末尾会让 2 跳的有效邻居排到 1 跳的失效邻居前面，
  // 违反 AC:880。故入选后统一按 compareTraversal 重排（同跳有效在前、再 id 升序）。
  const results = [
    ...valid.slice(0, RELATED_MAX_RESULTS),
    ...invalid.slice(0, RELATED_MAX_RESULTS - validCount),
  ].sort(compareTraversal)

  // 起点行（与遍历并行取回）：不存在 ⇒ startFound:false + 零值 start。
  const startRow = startRows[0]
  const startFound = startRow !== undefined
  const startInvalidAt = nullishString(startRow?.invalid_at)
  const startExpiredAt = nullishString(startRow?.expired_at)
  const start: RelatedTraversalStart = startFound
    ? {
      invalid: startInvalidAt !== null || startExpiredAt !== null,
      invalidAt: startInvalidAt,
      expiredAt: startExpiredAt,
    }
    : START_NOT_FOUND

  return { id, depth, startFound, start, total: all.length, results }
}

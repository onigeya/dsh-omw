/**
 * EII 可达性校验与边↔source_refs 漂移检测（Story 2.6 / AD-19、AD-21）。
 *
 * 两块内容：
 * - 只读可达性原语（写死给 Story 2.5 的判据②/判据①）：`checkReachableToL0`、
 *   `checkRefReachableToL0`。不写库、不开事务，可在 2.5 的同事务内调用（未提交的边可见）。
 * - audit_gap 的边侧两集：`computeEiiViolations`（EII 违例）、`computeEvidenceDrift`（漂移）。
 *
 * 查询口径（brief §2.4 推荐形态 + 裁决 U2）：
 * - 一律**正集 + 应用层差集**，绝不用相关 EXISTS/NOT EXISTS 表达谓词版
 *   （brief §2.3 N2 实测：内层谓词不生效，8 个节点全判违例）。
 * - 路径谓词**按标签显式写**：`label(x)='l0_raw'` 支判 `raw_text IS NOT NULL`；
 *   `label(x)='memory'` 支判 AD-19:175 三条件。不用隐式 NULL 语义——l0_raw 没有
 *   invalid_at/expired_at 列，`x.invalid_at IS NULL` 对缺失属性恒真（U2）。
 * - 有效性谓词（SQL 侧）走 `src/db/snapshot.ts` 的共享四条件（Story 3.1 收敛；
 *   原先按裁决 U7 不含 recorded_at，已在 ledger 记 U7 反转）；JS 侧 `isEffective`
 *   保留 AD-19 三条件不动——它只服务 checkReachableToL0 的早退判定，不拼 SQL。
 * - depth 固定 4 字面量（AD-19），不随 FR-12 的 depth 参数漂移。
 *
 * ⚠️ 升版必回归：`all(x IN nodes(p) ...)` 的动态属性语义与 `label(x)` 在 0.22.3 上实测可用
 * 但未被官方文档承诺；LadybugDB 升级（AD-3 四条件）时必须回归本模块的三条路径查询。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from './errors.js'
import { collectRows } from './rows.js'
import { currentSnapshotPredicate } from './snapshot.js'
import { EVIDENCE_CLOSURE_DEPTH, EVIDENCE_TABLE, L0_RAW_TABLE, MEMORY_TABLE } from './schema.js'

/** 只读可达性原语的封闭失败枚举（2.5 据此路由到「回滚 INBOX 重试」或「判不合格」）。 */
export type ReachabilityFailure =
  | 'not-found'
  | 'not-effective'
  | 'no-evidence-edge'
  | 'no-valid-path-to-l0'
  | 'l0-tombstone'

export interface ReachabilityResult {
  readonly id: string
  readonly pass: boolean
  /** pass === true 时为空数组；否则至少一项（顺序即判据优先级）。 */
  readonly failingReasons: readonly ReachabilityFailure[]
}

const READ_MEMORY_STATEMENT = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN m.valid_at AS valid_at, m.invalid_at AS invalid_at, m.expired_at AS expired_at',
].join('\n')

const DIRECT_IN_EDGE_COUNT = [
  'MATCH (x)-[:' + EVIDENCE_TABLE + ']->(m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN count(*) AS c',
].join('\n')

const READ_L0_STATEMENT = [
  'MATCH (l:' + L0_RAW_TABLE + ' {id: $id})',
  'RETURN l.raw_text AS raw_text',
].join('\n')

const EFFECTIVE_MEMORY_IDS = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  'WHERE ' + currentSnapshotPredicate('m'),
  'RETURN m.id AS id',
].join('\n')

const EFFECTIVE_MEMORY_REFS = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  'WHERE ' + currentSnapshotPredicate('m'),
  'RETURN m.id AS id, m.source_refs AS source_refs',
].join('\n')

const ALL_DIRECT_IN_EDGES = [
  'MATCH (x)-[:' + EVIDENCE_TABLE + ']->(m:' + MEMORY_TABLE + ')',
  'RETURN m.id AS to_id, x.id AS from_id',
].join('\n')

const EDGE_TABLE_PROBE = "CALL table_info('" + EVIDENCE_TABLE + "') RETURN name"

/**
 * UTC ISO-8601 时刻（与库内时间列同形）。闭包谓词里的时刻必须**内联成字面量**：
 * 0.22.3 的解析器在 `all(x IN nodes(p) WHERE …)` 里遇到参数表达式会直接
 * 触发内部断言（`parsed_parameter_expression.h: UNREACHABLE_CODE`）——实测踩到过。
 * 故这里先严格校验形状再内联，绝不把未校验的外部字符串拼进 SQL。
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function sqlInstant(now: string): string {
  if (!ISO_INSTANT_PATTERN.test(now)) {
    throw new MemoryDbError('invalid_instant', '时间参数不是合法 UTC ISO-8601 时刻：' + now)
  }
  return "'" + now + "'"
}

/**
 * 路径谓词（显式按标签，见文件头）：l0_raw 判非墓碑；memory 判 `src/db/snapshot.ts`
 * 的共享四条件谓词（Story 3.1 收敛——原先按裁决 U7 只判三条件不含 recorded_at，
 * 现升级为四条件：对真实数据零行为变化，`as-of` 读（U7）在 `valid_at <= now` 之外
 * 还受 `recorded_at <= now` 约束，已在 ledger 记 U7 反转）。
 */
function pathPredicate(nowLiteral: string): string {
  return [
    '  (label(x) = ' + "'" + L0_RAW_TABLE + "'" + ' AND x.raw_text IS NOT NULL)',
    '  OR (label(x) = ' + "'" + MEMORY_TABLE + "'" + ' AND ' + currentSnapshotPredicate('x', nowLiteral) + ')',
  ].join('\n')
}

/** 单候选：至少一条有效且可达的向下路径直到 L0（2.5 判据②）。 */
function reachableToIdStatement(nowLiteral: string): string {
  return [
    'MATCH p = (l0:' + L0_RAW_TABLE + ')-[:' + EVIDENCE_TABLE + '*1..' + EVIDENCE_CLOSURE_DEPTH + ']->(m:' + MEMORY_TABLE + ' {id: $id})',
    'WHERE all(x IN nodes(p) WHERE',
    pathPredicate(nowLiteral) + ')',
    'RETURN count(p) AS c',
  ].join('\n')
}

/** 全库正集：能从非墓碑 L0 走到、且链上节点有效的记忆 id 集。 */
function reachableIdsStatement(nowLiteral: string): string {
  return [
    'MATCH p = (l0:' + L0_RAW_TABLE + ')-[:' + EVIDENCE_TABLE + '*1..' + EVIDENCE_CLOSURE_DEPTH + ']->(m:' + MEMORY_TABLE + ')',
    'WHERE all(x IN nodes(p) WHERE',
    pathPredicate(nowLiteral) + ')',
    'RETURN DISTINCT m.id AS id',
  ].join('\n')
}

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue> = {},
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

function nullishString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

/** AD-19:175 的有效性三条件（不含 recorded_at，裁决 U7）。 */
function isEffective(validAt: string | null, invalidAt: string | null, expiredAt: string | null, now: string): boolean {
  return validAt !== null && validAt <= now && invalidAt === null && expiredAt === null
}

/**
 * 单候选可达性（2.5 判据②）。**DB 异常一律冒泡**：绝不吞成 pass=false——
 * 一次 DB 抖动把候选静默记成不合格，正是 brief §5.2 点名的禁用行为；
 * 2.5 应当把「调用失败」与「判定不合格」分开处理（失败即回滚 INBOX 重试）。
 */
export async function checkReachableToL0(
  connection: lbug.Connection,
  id: string,
  now: string,
): Promise<ReachabilityResult> {
  const rows = await queryRows(connection, READ_MEMORY_STATEMENT, { id })
  const row = rows[0]
  if (row === undefined) return { id, pass: false, failingReasons: ['not-found'] }
  if (!isEffective(nullishString(row.valid_at), nullishString(row.invalid_at), nullishString(row.expired_at), now)) {
    return { id, pass: false, failingReasons: ['not-effective'] }
  }
  const edgeRows = await queryRows(connection, DIRECT_IN_EDGE_COUNT, { id })
  const inEdges = Number(edgeRows[0]?.c ?? 0)
  if (!(inEdges > 0)) return { id, pass: false, failingReasons: ['no-evidence-edge'] }
  const pathRows = await queryRows(connection, reachableToIdStatement(sqlInstant(now)), { id })
  const paths = Number(pathRows[0]?.c ?? 0)
  if (!(paths > 0)) return { id, pass: false, failingReasons: ['no-valid-path-to-l0'] }
  return { id, pass: true, failingReasons: [] }
}

/**
 * 单引用可达性（2.5 判据①，裁决 U1 的口径）：
 * - ref 命中 l0_raw → **直查**该行；`raw_text IS NULL` 即 redact 墓碑 ⇒ 'l0-tombstone'；
 * - ref 命中 memory → 委托 {@link checkReachableToL0}（沿反向证据闭包验证可达 L0）；
 * - 都不命中 ⇒ 'not-found'。
 * 只读、异常冒泡（同上）。
 */
export async function checkRefReachableToL0(
  connection: lbug.Connection,
  refId: string,
  now: string,
): Promise<ReachabilityResult> {
  const l0Rows = await queryRows(connection, READ_L0_STATEMENT, { id: refId })
  if (l0Rows.length > 0) {
    const raw = l0Rows[0]?.raw_text
    return raw === null || raw === undefined
      ? { id: refId, pass: false, failingReasons: ['l0-tombstone'] }
      : { id: refId, pass: true, failingReasons: [] }
  }
  return checkReachableToL0(connection, refId, now)
}

/**
 * EII 违例集 = 有效记忆全集 − 谓词可达正集（brief §2.4(2) 的两段式）。
 * 只读；返回 id 列表（调用方决定计数或展开）。
 */
export async function computeEiiViolations(connection: lbug.Connection, now: string): Promise<string[]> {
  const effective = await queryRows(connection, EFFECTIVE_MEMORY_IDS, { now })
  const reachable = await queryRows(connection, reachableIdsStatement(sqlInstant(now)))
  const reach = new Set(reachable.map((row) => String(row.id)))
  return effective.map((row) => String(row.id)).filter((id) => !reach.has(id))
}

export interface EvidenceDriftEntry {
  readonly id: string
  readonly ref: string
}

export interface EvidenceDrift {
  /** 漂移 A：索引列说了谎——source_refs 里有，但没有对应的 EVIDENCE **直接入边**。 */
  readonly refsWithoutEdges: readonly EvidenceDriftEntry[]
  /** 漂移 B：边有、索引无——直接入边低端 id 不在 source_refs 里。 */
  readonly edgesWithoutRefs: readonly EvidenceDriftEntry[]
}

/**
 * 边 ↔ source_refs[] 的双向漂移（裁决 U1：基准是**直接入边**，不是 L0 闭包）。
 * 两条全表查询 + JS 求差集（避免逐节点 N+1）；只读；谓词不含 recorded_at。
 */
export async function computeEvidenceDrift(connection: lbug.Connection, now: string): Promise<EvidenceDrift> {
  const nodes = await queryRows(connection, EFFECTIVE_MEMORY_REFS, { now })
  const edges = await queryRows(connection, ALL_DIRECT_IN_EDGES)
  const inEdges = new Map<string, Set<string>>()
  for (const edge of edges) {
    const to = String(edge.to_id)
    const set = inEdges.get(to) ?? new Set<string>()
    set.add(String(edge.from_id))
    inEdges.set(to, set)
  }
  const refsWithoutEdges: EvidenceDriftEntry[] = []
  const edgesWithoutRefs: EvidenceDriftEntry[] = []
  for (const node of nodes) {
    const id = String(node.id)
    const refs = toStringArray(node.source_refs)
    const refSet = new Set(refs)
    const edgeSet = inEdges.get(id) ?? new Set<string>()
    // 评审 P18b（T20）：遍历**去重后的 refSet**——库内 source_refs 允许含重复 id
    //（list_concat 追加），用原数组会把同一条漂移放大成多条。
    for (const ref of refSet) if (!edgeSet.has(ref)) refsWithoutEdges.push({ id, ref })
    for (const from of edgeSet) if (!refSet.has(from)) edgesWithoutRefs.push({ id, ref: from })
  }
  return { refsWithoutEdges, edgesWithoutRefs }
}

/** 边表是否已建（只读探针）：表缺失时 `/memory status` 必须显示「未知」而不是 0。 */
export async function hasEdgeTables(connection: lbug.Connection): Promise<boolean> {
  try {
    await queryRows(connection, EDGE_TABLE_PROBE)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/does not exist/i.test(message)) return false
    throw error
  }
}

export interface EvidenceGapSummary {
  /** EII 违例条数（有效但无有效可达路径到 L0）。 */
  readonly eiiViolations: number
  /** 边 ↔ source_refs 漂移条数（双向合计）。 */
  readonly drift: number
  readonly total: number
}

/**
 * audit_gap 的边侧合计（EII 违例 + 漂移）。边表缺失返回 null = 「算不出来」，
 * 由 status 渲染成未知，**绝不静默报 0**（与 computeAuditGap 同一约定）。
 */
export async function computeEvidenceGap(
  connection: lbug.Connection,
  now: string,
): Promise<EvidenceGapSummary | null> {
  if (!(await hasEdgeTables(connection))) return null
  const eii = await computeEiiViolations(connection, now)
  const drift = await computeEvidenceDrift(connection, now)
  const driftCount = drift.refsWithoutEdges.length + drift.edgesWithoutRefs.length
  return { eiiViolations: eii.length, drift: driftCount, total: eii.length + driftCount }
}

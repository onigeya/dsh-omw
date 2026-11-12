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
    await connection.query(createEvidenceTableStatement())
    await connection.query(createRelatedTableStatement())
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

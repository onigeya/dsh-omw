/**
 * L0 墓碑与证据降级（Story 4.2 / FR-14、AD-4、AD-19、NFR9）。
 *
 * 四件事，全部「由调用方开事务」（本文件不调 `runInTransaction`，同 `audit.ts` 的写入原语）：
 * - {@link collectL0ClosureIds}：记忆证据链上的 L0 端点（`EVIDENCE*1..4`，与 EII 同一闭包机制）；
 * - {@link applyL0Tombstones}：把行内 L0 原文替换成墓碑，保留 id/recorded_at/actor（AD-4 唯一
 *   append-only 例外）；
 * - {@link markEvidenceDegraded}：把证据链经过这些 L0 的有效记忆标 `evidence_degraded`；
 * - {@link countEvidenceDegraded}：`/memory/status` 的降级计数（列缺失返回 null = 未知）。
 *
 * 三条从代码看不出来的约束：
 * - 墓碑只写一次：`WHERE l.redacted_at IS NULL` 守卫（0.22.3 实测），第二次是 no-op，
 *   首次时间与文本逐字保留（矩阵行 8）。
 * - 指针行（`raw_text IS NULL`，Story 10.1 的形态）不是墓碑对象：加 `raw_text IS NOT NULL`
 *   把它排除，绝不把 `[REDACTED …]` 写进指针行。
 * - `evidence_degraded` 是 BOOL：0.22.3 上 `= 1` 直接抛类型错，一律用 `true`/`false`
 *   （2026-11-15 探针，见 spec Implementation Notes 第 2 条）。
 *
 * 凭据纪律（NFR9）：墓碑文本只含 L0 id 与时刻；`redacted_by` 只放 actor 枚举。
 */
import type * as lbug from '@ladybugdb/core'
import { isMissingTableError } from './errors.js'
import { queryRows } from './rows.js'
import {
  EVIDENCE_CLOSURE_DEPTH,
  EVIDENCE_DEGRADED_COLUMN,
  EVIDENCE_TABLE,
  L0_RAW_TABLE,
  MEMORY_TABLE,
  l0TombstoneText,
  notEvidenceDegradedPredicate,
} from './schema.js'
import { currentSnapshotPredicate } from './snapshot.js'

/** 闭包查询的 L0 端点。`$id` 是记忆 id（不必是有效节点：redact 要在墓碑语义上闭包）。 */
function closureStatement(onlyNotRedacted: boolean): string {
  return [
    'MATCH p=(l:' + L0_RAW_TABLE + ')-[:' + EVIDENCE_TABLE + '*1..' + EVIDENCE_CLOSURE_DEPTH + ']->(m:' + MEMORY_TABLE + ' {id: $id})',
    'WHERE l.raw_text IS NOT NULL' + (onlyNotRedacted ? ' AND l.redacted_at IS NULL' : ''),
    'RETURN DISTINCT l.id AS id',
  ].join('\n')
}

/**
 * 记忆证据链上的全部行内 L0 id（去重、按 id 升序保证确定性）。
 *
 * `onlyNotRedacted`：只取还没被墓碑化的行——这是「本次要改写/记账」的集合；
 * 不传则是「本次降级判定的 L0 集合」（已墓碑的 L0 同样是该记忆证据链的一部分）。
 */
export async function collectL0ClosureIds(
  connection: lbug.Connection,
  id: string,
  options: { readonly onlyNotRedacted?: boolean } = {},
): Promise<string[]> {
  const rows = await queryRows(connection, closureStatement(options.onlyNotRedacted === true), { id })
  return rows.map((row) => String(row.id)).sort()
}

export interface ApplyL0TombstonesOptions {
  /** 要墓碑化的 L0 id（通常是 collectL0ClosureIds(onlyNotRedacted) 的结果）。 */
  readonly l0Ids: readonly string[]
  /** 本次改写时刻（UTC ISO-8601，与库内时间列同形）。 */
  readonly ts: string
  /** 改写主体（AC:1050 只允许 user）。 */
  readonly actor: 'user'
}

const SET_TOMBSTONE = [
  'MATCH (l:' + L0_RAW_TABLE + ' {id: $id})',
  'WHERE l.redacted_at IS NULL AND l.raw_text IS NOT NULL',
  'SET l.raw_text = $tombstone, l.redacted_by = $actor, l.redacted_at = $ts',
  'RETURN l.id AS id',
].join('\n')

/**
 * 逐行写墓碑（`raw_text = [REDACTED <id> @<ts>]`）。
 *
 * 逐行而不是批量：墓碑文本含行 id，同一 `$tombstone` 无法给多行用；本期闭包规模是
 * 一条记忆的证据链（个位数~几十），逐行 prepare+execute 足够。
 *
 * 返回**真的被改写**的 id 列表：已被 redact 过 / 指针行返回 0 行，不计入（矩阵行 8）。
 */
export async function applyL0Tombstones(
  connection: lbug.Connection,
  options: ApplyL0TombstonesOptions,
): Promise<string[]> {
  const rewritten: string[] = []
  for (const id of options.l0Ids) {
    const rows = await queryRows(connection, SET_TOMBSTONE, {
      id,
      tombstone: l0TombstoneText(id, options.ts),
      actor: options.actor,
      ts: options.ts,
    })
    if (rows.length > 0) rewritten.push(String(rows[0]!.id))
  }
  return rewritten
}

export interface MarkEvidenceDegradedOptions {
  /** 证据链经过的 L0 集合（含已墓碑的：它们的记忆同样算降级）。 */
  readonly l0Ids: readonly string[]
  /** 目标自身永远算降级（它可能刚被本事务写 expired_at，不在有效集里）。 */
  readonly targetId: string
  /** 当前时刻（UTC ISO-8601），用于有效集谓词。 */
  readonly now: string
}

const DEGRADED_CANDIDATES = [
  'MATCH p=(l:' + L0_RAW_TABLE + ')-[:' + EVIDENCE_TABLE + '*1..' + EVIDENCE_CLOSURE_DEPTH + ']->(m:' + MEMORY_TABLE + ')',
  'WHERE l.id IN $ids AND ' + currentSnapshotPredicate('m') + ' AND ' + notEvidenceDegradedPredicate('m'),
  'RETURN DISTINCT m.id AS id',
].join('\n')

const READ_DEGRADED_FLAG = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN m.' + EVIDENCE_DEGRADED_COLUMN + ' AS flag',
].join('\n')

const SET_DEGRADED = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  'WHERE m.id IN $ids',
  'SET m.' + EVIDENCE_DEGRADED_COLUMN + ' = true',
  'RETURN m.id AS id',
].join('\n')

const READ_EFFECTIVE_DEGRADED = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  'WHERE ' + currentSnapshotPredicate('m') + ' AND m.' + EVIDENCE_DEGRADED_COLUMN + ' = true',
  'RETURN count(m) AS c',
].join('\n')

const MEMORY_COLUMNS_PROBE = `CALL table_info('${MEMORY_TABLE}') RETURN name`

/**
 * 标记证据降级，返回**本次新标**的条数（重放时 0，不虚报）。
 *
 * 对象集合（spec Always）：证据链经过 `l0Ids` 的有效记忆（当前快照四条件）＋ 目标自身；
 * 已失效/已过期节点不标。目标单独判定是因为它可能刚在本事务里被写 `expired_at`。
 */
export async function markEvidenceDegraded(
  connection: lbug.Connection,
  options: MarkEvidenceDegradedOptions,
): Promise<number> {
  const ids = new Set<string>()
  if (options.l0Ids.length > 0) {
    const rows = await queryRows(connection, DEGRADED_CANDIDATES, {
      ids: [...options.l0Ids],
      now: options.now,
    })
    for (const row of rows) ids.add(String(row.id))
  }

  const flagRows = await queryRows(connection, READ_DEGRADED_FLAG, { id: options.targetId })
  if (flagRows[0]?.flag !== true) ids.add(options.targetId)
  if (ids.size === 0) return 0

  const written = await queryRows(connection, SET_DEGRADED, { ids: [...ids].sort() })
  return written.length
}

/**
 * 有效且 `evidence_degraded = true` 的节点数（D-5 的 status 行）。
 *
 * 返回 null = 列不存在（旧库未迁移且只读）：调用方渲染「未知（库缺少该列）」，
 * 不静默报 0（与 auditGap / evidenceGap 同一约定）。
 */
export async function countEvidenceDegraded(
  connection: lbug.Connection,
  now: string,
): Promise<number | null> {
  try {
    const columns = await queryRows(connection, MEMORY_COLUMNS_PROBE)
    if (!columns.some((row) => String(row.name) === EVIDENCE_DEGRADED_COLUMN)) return null
  } catch (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
  const rows = await queryRows(connection, READ_EFFECTIVE_DEGRADED, { now })
  return Number(rows[0]?.c ?? 0)
}

/**
 * 迁移 0003：`judge_key` 加入 `action` 维度（Story 5.4 / AC:1299-1301 / AD-18）。
 *
 * 为什么需要数据改写：AD-18 的键式从 `judge:<policy>:<old:new>` 改为
 * `judge:<policy>:<action>:<old:new>`。同一节点对的 `merge` 与 `supersede` 原来是**同一个键**，
 * 后到的裁决 MERGE 命中已有行 ⇒ 字段保持首次写入值，第二条裁决静默丢失（AD-33 的已知偏差）。
 *
 * 本迁移把既有行就地重算键：
 * - 读全部 `keyed_decision` 行（v1 规模下全扫可接受）；
 * - 用新键式的 `uuid5` 算出目标键；与旧键相同即跳过（纯 DDL 幂等）；
 * - 目标键已存在（两条旧裁决并到同一新键）时**合并 `invalidated_by`**（取并集），再删旧行；
 * - 删除用 `DELETE k`（节点删除，无入边：`invalidated_by` 是列不是边）。
 *
 * 旧键只读兼容由 `audit.ts` 的 `buildLegacyJudgeKey` 承担：本迁移只保证「迁移后不再有旧键行」，
 * 读侧仍容忍旧键（迁移失败被回滚 / 手工恢复备份后旧库还能读）。
 *
 * 幂等：重复执行时第一轮已把旧键改完，第二轮算出的新键 === 现有键 ⇒ 全部跳过。
 */
import type * as lbug from '@ladybugdb/core'
import { uuid5 } from '../id.js'
import { collectRows, queryRows } from '../rows.js'
import { runPrepared } from '../backend.js'
import { KEYED_DECISION_TABLE } from '../schema.js'

/** 与 `db/audit.ts` 的 `buildJudgeKey` 保持一致（迁移不得 import audit：那会构成 check:deps 的环）。 */
function newJudgeKey(policy: string, action: string, oldId: string, newId: string): string {
  return uuid5('judge:' + policy + ':' + action + ':' + [oldId, newId].sort().join(':'))
}

const READ_ALL = [
  'MATCH (k:' + KEYED_DECISION_TABLE + ')',
  'RETURN k.judge_key AS judge_key, k.new_id AS new_id, k.old_id AS old_id, k.action AS action,',
  '  k.policy AS policy, k.l0_refs AS l0_refs, k.resolution_source AS resolution_source,',
  '  k.write_pending AS write_pending, k.invalidated_by AS invalidated_by, k.ts AS ts',
].join('\n')

const MERGE_ROW = [
  'MERGE (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key})',
  '  ON CREATE SET k.new_id = $new_id, k.old_id = $old_id, k.action = $action,',
  '    k.policy = $policy, k.l0_refs = $l0_refs, k.resolution_source = $resolution_source,',
  '    k.write_pending = $write_pending, k.invalidated_by = $invalidated_by, k.ts = $ts',
].join('\n')

const DELETE_ROW = 'MATCH (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key}) DELETE k'

/** 读回的 `invalidated_by` 是普通对象（也兼容 Map），统一成 Map（写参数必须是 JS Map）。 */
function toMap(value: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (value === null || value === undefined) return out
  const entries: Iterable<[unknown, unknown]> =
    value instanceof Map ? value.entries() : Object.entries(value as Record<string, unknown>)
  for (const [key, list] of entries) out.set(String(key), Array.isArray(list) ? list.map(String) : [])
  return out
}

/** 合并两份失效因果：同键取并集（迁移把两条旧裁决并到同一新键时用）。 */
function mergeMaps(
  left: Map<string, string[]>,
  right: Map<string, string[]>,
): Map<string, string[]> {
  const out = new Map(left)
  for (const [key, list] of right) {
    const existing = out.get(key) ?? []
    out.set(key, [...new Set([...existing, ...list])])
  }
  return out
}

async function rewriteJudgeKeys(connection: lbug.Connection): Promise<void> {
  const rows = await queryRows(connection, READ_ALL)
  for (const row of rows) {
    const oldKey = String(row.judge_key)
    const policy = String(row.policy ?? '')
    const action = String(row.action ?? '')
    const oldId = String(row.old_id ?? '')
    const newId = String(row.new_id ?? '')
    const nextKey = newJudgeKey(policy, action, oldId, newId)
    if (nextKey === oldKey) continue

    const invalidatedBy = toMap(row.invalidated_by)
    // 目标键已有一行（另一条旧裁决也映射到这里）⇒ 先把它读出来合并，避免 MERGE 的 ON CREATE 丢因果。
    const existingRows = await queryRows(
      connection,
      'MATCH (k:' + KEYED_DECISION_TABLE + ' {judge_key: $key}) RETURN k.invalidated_by AS invalidated_by',
      { key: nextKey },
    )
    const merged = mergeMaps(toMap(existingRows[0]?.invalidated_by), invalidatedBy)

    const statement = await connection.prepare(MERGE_ROW)
    await collectRows(await connection.execute(statement, {
      judge_key: nextKey,
      new_id: newId,
      old_id: oldId,
      action,
      policy,
      l0_refs: Array.isArray(row.l0_refs) ? row.l0_refs.map(String) : [],
      resolution_source: String(row.resolution_source ?? 'auto'),
      write_pending: row.write_pending === true,
      invalidated_by: merged,
      ts: String(row.ts ?? ''),
    }))
    const deleteStatement = await connection.prepare(DELETE_ROW)
    await runPrepared(connection, deleteStatement, { judge_key: oldKey })
  }
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）；
// 结构一致性由 `migrations.ts` 的 `readonly Migration[]` 赋值处检查。
export const MIGRATION_0003 = {
  version: 3,
  name: 'judge-key-action',
  statements: [],
  run: rewriteJudgeKeys,
}

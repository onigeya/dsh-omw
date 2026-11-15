/**
 * `omw_meta` 键值表的唯一读写实现（Story 5.4 / AC:1307-1309 的收敛）。
 *
 * 收敛前全仓有三套同形实现：
 * - `db/database.ts` 的 `readMetaMap` / `mergeMetaValue`（库级元数据）；
 * - `db/memory.ts` 的 `READ_META_STATEMENT` / `MERGE_META_STATEMENT`（L2 提升游标）；
 * - `wiki/evidence-backfill.ts` 的 `READ_META` / `MERGE_META`（证据回填游标）。
 * 三者语义差别只在「缺键时返回什么」：地图返回空 Map、元数据返回 `undefined`、游标返回 `null` 或 `''`。
 * 本模块把「值」与「游标」两种读法都收在一处，调用方保留自己的缺省转换，不再各自拼语句。
 *
 * 事务契约与其它写入原语一致：**不自开事务**，调用方决定边界（`runInTransaction` 不可重入）。
 * 时间/凭据纪律：本表只存标识、版本号与游标水位，绝不存正文或凭据（NFR9）。
 */
import type * as lbug from '@ladybugdb/core'
import { runPrepared } from './backend.js'
import { isMissingTableError } from './errors.js'
import { collectRows, queryRows } from './rows.js'
import { META_TABLE } from './schema.js'

const READ_META_VALUE = 'MATCH (m:' + META_TABLE + ' {key: $key}) RETURN m.value AS value'
const READ_META_ALL = 'MATCH (m:' + META_TABLE + ') RETURN m.key AS key, m.value AS value'
const MERGE_META_VALUE =
  'MERGE (m:' + META_TABLE + ' {key: $key}) ON CREATE SET m.value = $value ON MATCH SET m.value = $value'

/** 读一个键；缺键返回 `null`（区别于「键存在但值为空串」）。表缺失同样返回 `null`。 */
export async function readMetaValue(connection: lbug.Connection, key: string): Promise<string | null> {
  try {
    const rows = await queryRows(connection, READ_META_VALUE, { key })
    const value = rows[0]?.value
    return value === undefined || value === null ? null : String(value)
  } catch (error) {
    // 只有「表不存在」按缺键处理（与 database.ts 的既有语义一致）；其余错误冒泡。
    if (isMissingTableError(error)) return null
    throw error
  }
}

/** 读整张表；表缺失返回空 Map（调用方据此判断「全新库」）。 */
export async function readMetaMap(connection: lbug.Connection): Promise<Map<string, string>> {
  try {
    const rows = await queryRows(connection, READ_META_ALL)
    return new Map(rows.map((row) => [String(row.key), String(row.value)]))
  } catch (error) {
    if (isMissingTableError(error)) return new Map()
    throw error
  }
}

/** 写一个键（MERGE：缺则建、有则覆盖）。 */
export async function writeMetaValue(connection: lbug.Connection, key: string, value: string): Promise<void> {
  const statement = await connection.prepare(MERGE_META_VALUE)
  // 结果必须释放，否则 pin 满 buffer pool（见 backend.ts closeQueryResult）。
  await collectRows(await connection.execute(statement, { key, value }))
}

/**
 * 读游标水位：缺键返回 `''`（= 从起点开始）。
 *
 * 两个游标（`evidence_backfill_cursor`、`l2_promotion_cursor`）形态相同，此前各有一份实现；
 * 现在都走这里，缺省转换（`''`）只此一处。
 */
export async function readCursor(connection: lbug.Connection, key: string): Promise<string> {
  return (await readMetaValue(connection, key)) ?? ''
}

/** 写游标水位（与 `readCursor` 成对；不自开事务）。 */
export async function writeCursor(connection: lbug.Connection, key: string, value: string): Promise<void> {
  await writeMetaValue(connection, key, value)
}

/** 保留给 `runPrepared` 的导入面（本模块只用它做平铺写入；导出以免 tree-shake 误删依赖）。 */
export { runPrepared }

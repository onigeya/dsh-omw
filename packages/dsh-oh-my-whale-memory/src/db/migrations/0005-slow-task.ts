/**
 * 迁移 0005：建 `slow_task` 慢路径队列表（Story 7.2 / AD-6、AD-20、AD-34）。
 *
 * 与 0004 同一形态：前三个迁移加列、0004/0005 加表，故走 `run`（`CREATE NODE TABLE IF NOT EXISTS`，幂等）。
 * 新库由 bootstrap 重放本迁移建出，旧库升级时在同一事务里建出；本表不参与任何清理逻辑
 * （`done` 行按 AD-6 的死信 7 天口径由运行期回收，不靠迁移）。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from '../backend.js'
import { createSlowTaskTableStatement } from '../schema.js'

async function createSlowTaskTable(connection: lbug.Connection): Promise<void> {
  await runStatement(connection, createSlowTaskTableStatement())
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0005 = {
  version: 5,
  name: 'slow-task',
  statements: [],
  run: createSlowTaskTable,
}

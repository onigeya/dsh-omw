/**
 * 迁移 0004：建 `pending_decision` 待裁决表（Story 7.1 / FR-20、AD-18、AD-34）。
 *
 * 前三个迁移都是「加列」，本迁移第一次**加表**——`Migration.statements` 只表达「给某表加某列」，
 * 建表用 `run` 数据步（`CREATE NODE TABLE IF NOT EXISTS` 自带幂等）。新库由建库 DDL 直接建出，
 * 因此本迁移只服务旧库；`run` 在新库 bootstrap 时同样会执行（幂等，无害）。
 *
 * 删掉这张表就等于丢掉「用户还没裁决的冲突」（不可恢复），故本表不参与任何清理逻辑。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from '../backend.js'
import { createPendingDecisionTableStatement } from '../schema.js'

async function createPendingDecisionTable(connection: lbug.Connection): Promise<void> {
  await runStatement(connection, createPendingDecisionTableStatement())
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）；
// 结构一致性由 `migrations.ts` 的 `readonly Migration[]` 赋值处检查。
export const MIGRATION_0004 = {
  version: 4,
  name: 'pending-decision',
  statements: [],
  run: createPendingDecisionTable,
}

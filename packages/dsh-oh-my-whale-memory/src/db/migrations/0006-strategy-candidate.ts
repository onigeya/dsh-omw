/**
 * 迁移 0006：建 `strategy_candidate` 候选区表（Story 7.3 / AD-20、AD-34）。
 *
 * 与 0004/0005 同形态：加表走 `run`（`CREATE NODE TABLE IF NOT EXISTS`，幂等），新库靠 bootstrap 重放建出。
 * 本表**不参与清理**：`adopted`/`rejected` 是策略层的决策证据；`expired` 由运行期按 `expiryDays` 标记，不删除。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from '../backend.js'
import { createStrategyCandidateTableStatement } from '../schema.js'

async function createStrategyCandidateTable(connection: lbug.Connection): Promise<void> {
  await runStatement(connection, createStrategyCandidateTableStatement())
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0006 = {
  version: 6,
  name: 'strategy-candidate',
  statements: [],
  run: createStrategyCandidateTable,
}

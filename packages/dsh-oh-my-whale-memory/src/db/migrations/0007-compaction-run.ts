/**
 * 迁移 0007：建 `compaction_run`（Story 8.1 / AD-26、AD-34）。
 *
 * 取号说明：gate doc 里写的「Epic 8.1 迁移号 0003」已过期——0003 被 judge_key 迁移占用，
 * 本迁移按实际最大号 +1 取 **0007**（已回填到 `spike-gates-2026-11-14.md` 的 G5）。
 *
 * 与 0004–0006 同形态：加表走 `run`（幂等），新库靠 bootstrap 重放建出。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from '../backend.js'
import { createCompactionRunTableStatement } from '../schema.js'

async function createCompactionRunTable(connection: lbug.Connection): Promise<void> {
  await runStatement(connection, createCompactionRunTableStatement())
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0007 = {
  version: 7,
  name: 'compaction-run',
  statements: [],
  run: createCompactionRunTable,
}

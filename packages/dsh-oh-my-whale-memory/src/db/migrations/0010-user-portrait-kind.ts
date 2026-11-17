/**
 * 迁移 0010：User Portrait 分类值 `persona` → `user_portrait`（Story 11.4 / AD-38、AD-34）。
 *
 * 只改**承载记忆分类**的四列（AC:2383 逐字）：
 * - `memory.kind`（L1/L2 节点分类）；
 * - `l1_inbox.kind` / `l2_inbox.kind`（队列条目沿用的分类标签）；
 * - `pending_decision.kind`（待裁决冲突的候选分类）。
 *
 * **不碰**语义不同的 kind 列（AC:2386 逐字）：
 * - `generation_log.kind` 是审计动作语汇（capture|refine|verify|cascade|redact）；
 * - `slow_task.kind` 是任务类型（reflection 等）。
 *
 * 执行语义全部由 `db/migrate.ts` 承担：迁移前备份、单事务、失败整体回滚并拒绝启动。
 * **表存在性必须在事务外探测**：事务内对缺失表执行 `CALL table_info` 会让底层事务进入
 * 不可用状态，后续 `recordMigration` 会报 `Table schema_migration does not exist`。
 * 故本迁移用 `prepare`（事务前）算出存在表集合，`run` 只处理存在的表。
 *
 * 幂等：改写后不再存在 `kind = 'persona'` 的行，重放是 no-op。
 * 表名与列名只取 `schema.ts` 的常量；`persona` 只作为**绑定参数**，不写进 SQL 文本。
 */
import type * as lbug from '@ladybugdb/core'
import { runPrepared } from '../backend.js'
import { isMissingTableError } from '../errors.js'
import { queryRows } from '../rows.js'
import { L1_INBOX_TABLE, L2_INBOX_TABLE, MEMORY_TABLE, PENDING_DECISION_TABLE } from '../schema.js'
import { LEGACY_USER_PORTRAIT_KIND, USER_PORTRAIT_KIND } from '../../shared/memory-vocab.js'

/** 需要改写的四列所属的表（顺序固定：节点表 → 两路队列 → 待裁决）。 */
const PORTRAIT_KIND_TABLES = [MEMORY_TABLE, L1_INBOX_TABLE, L2_INBOX_TABLE, PENDING_DECISION_TABLE] as const

/** 事务前探测：哪些目标表存在（缺失表在旧 fixture / 极旧库里合法）。 */
export async function prepareUserPortraitKind(connection: lbug.Connection): Promise<ReadonlySet<string>> {
  const present = new Set<string>()
  for (const table of PORTRAIT_KIND_TABLES) {
    try {
      await queryRows(connection, `CALL table_info('${table}') RETURN name`)
      present.add(table)
    } catch (error) {
      if (!isMissingTableError(error)) throw error
    }
  }
  return present
}

async function migrateUserPortraitKind(connection: lbug.Connection, prepared?: unknown): Promise<void> {
  // 直接调用（单测）时没有 prepare 结果：在事务外探测（本函数由测试直接调用，无外层事务）。
  const tables = prepared instanceof Set
    ? (prepared as ReadonlySet<string>)
    : await prepareUserPortraitKind(connection)
  for (const table of PORTRAIT_KIND_TABLES) {
    if (!tables.has(table)) continue
    const statement = await connection.prepare(
      `MATCH (n:${table}) WHERE n.kind = $legacy SET n.kind = $canonical`,
    )
    await runPrepared(connection, statement, {
      legacy: LEGACY_USER_PORTRAIT_KIND,
      canonical: USER_PORTRAIT_KIND,
    })
  }
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）；
// 结构一致性由 `migrations.ts` 的 `readonly Migration[]` 赋值处检查。
export const MIGRATION_0010 = {
  version: 10,
  name: 'user-portrait-kind',
  statements: [],
  prepare: prepareUserPortraitKind,
  run: migrateUserPortraitKind,
}

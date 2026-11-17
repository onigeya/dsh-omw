/**
 * 迁移类型与清单（Story 4.2 / AD-34）。
 *
 * 放在 `db/` 而不是 `db/migrations/`：`scripts/check-migrations.mjs` 要求 migrations 目录里
 * **每个** `.ts|.js|sql` 文件都叫 `NNNN-*.ts`（改名/写错号的迁移会被判 FAIL，不会静默忽略）。
 * 清单与类型是支撑模块，不是迁移，因此留在外面；放进去只能靠放宽门禁解决，那是弱化。
 *
 * 一个迁移只声明「要加哪些列」，执行语义（版本比较、备份、单事务、失败回滚）全在
 * `db/migrate.ts`。每条语句都带 `table`/`column` 守卫：运行器先用 `table_info` 判列，
 * 已存在即跳过——0.22.3 重复 `ALTER ... ADD` 会抛
 * "Runtime exception: <table> table already has property <column>"（2026-11-15 实测），
 * 所以幂等只能靠列存在性检查，不能靠 `IF NOT EXISTS`（0.22.3 的 ADD 不支持它）。
 *
 * `MIGRATIONS` 必须按 version 升序；`TARGET_SCHEMA_VERSION` 直接取 `schema.ts` 的
 * `SCHEMA_VERSION`，不在这里另写一份数字（门禁另外强制「SCHEMA_VERSION = 最大迁移号」，
 * 两处任一对不上都会在 `pnpm verify` 变红）。
 */
import { SCHEMA_VERSION } from './schema.js'
import { MIGRATION_0002 } from './migrations/0002-evidence-degraded-and-redact.js'
import { MIGRATION_0003 } from './migrations/0003-judge-key-action.js'
import { MIGRATION_0004 } from './migrations/0004-pending-decision.js'
import { MIGRATION_0005 } from './migrations/0005-slow-task.js'
import { MIGRATION_0006 } from './migrations/0006-strategy-candidate.js'
import { MIGRATION_0007 } from './migrations/0007-compaction-run.js'
import { MIGRATION_0008 } from './migrations/0008-tier-threshold.js'
import { MIGRATION_0009 } from './migrations/0009-l0-pointer.js'

export interface MigrationStatement {
  /** 目标节点表名（只能是本仓导出的常量，绝不接受外部输入）。 */
  readonly table: string
  /** 该语句新增的列名（列已存在 ⇒ 跳过这条语句）。 */
  readonly column: string
  readonly ddl: string
}

/**
 * 一条迁移里的**数据改写**步骤（Story 5.4 新增）。
 *
 * 之前的迁移只加列，所以清单里只有 `statements`。`judge_key` 含 `action` 之后既有行必须重算键——
 * 那是数据变换，SQL 表达不了（键是 `uuid5`）。`run` 在同一事务内、所有 `statements` 之后执行，
 * 必须自己保证幂等（重放的第二次要 no-op）。
 */
export type MigrationDataStep = (connection: import('@ladybugdb/core').Connection) => Promise<void>

export interface Migration {
  /** 单调递增的十进制迁移号，与文件名前缀一致（0002 → 2）。 */
  readonly version: number
  readonly name: string
  readonly statements: readonly MigrationStatement[]
  /** 可选的数据改写步骤；缺省 = 纯 DDL 迁移。 */
  readonly run?: MigrationDataStep
}

/** 全部迁移，按 version 升序（运行器按此顺序逐条应用）。 */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_0002, MIGRATION_0003, MIGRATION_0004, MIGRATION_0005, MIGRATION_0006, MIGRATION_0007, MIGRATION_0008, MIGRATION_0009]

/** 目标版本（number 形态，便于与迁移号比较）。 */
export const TARGET_SCHEMA_VERSION = Number(SCHEMA_VERSION)

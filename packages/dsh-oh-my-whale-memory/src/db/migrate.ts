/**
 * schema 迁移运行器（Story 4.2 / AD-34 的最小闭环）。
 *
 * 语义（全部由本文件唯一实现）：
 * - 读 `omw_meta.schema_version`；`version > TARGET` ⇒ fail-loud `schema_mismatch`
 *   （旧插件不得写新库，拒绝启动且不改库）；
 * - `version < TARGET` ⇒ 先备份库文件，再在**一个**事务里逐条执行未应用的迁移
 *   （含 `schema_migration` 账本行与版本号），任一语句失败整条回滚并抛错；
 * - `version === null` 且**本次打开前**没有 `memory` 表（bootstrap）⇒ 不备份、不执行 ALTER，
 *   只建 `schema_migration` 并把全部迁移记为已应用（新库的列由 `schema.ts` 的建表 DDL 直接带出）；
 * - `version === null` 但表已存在（旧库的极端形态）⇒ **不是 bootstrap**：按 0 号版本走正常
 *   迁移路径（先备份）；版本记录存在但 `memory` 表缺失 ⇒ `schema_mismatch`（库损坏，不隐式重建）。
 *
 * 备份：`<dbPath>.bak-<fromVersion>-<pid>-<monotonicNs>`，用 `fs.open(path,'wx')`
 * （`O_EXCL`）创建——已存在即失败、拒绝迁移（备份是唯一回滚点，绝不覆盖上一份）。
 * 库旁若有 WAL 文件一并复制（`<db>.wal` / `<db>-wal` 两种命名都认，LadybugDB 无 checkpoint API）。
 *
 * 事务纪律：本函数自己开事务，不得在既有事务内调用（`runInTransaction` 不可重入）。
 * 只在写者路径（`initializeDatabase`）调用；只读实例绝不触发迁移（AD-12 / AC2）。
 */
import { createHash } from 'node:crypto'
import { copyFile, open, stat } from 'node:fs/promises'
import type * as lbug from '@ladybugdb/core'
import { runPrepared, runStatement } from './backend.js'
import { MemoryDbError, isMissingTableError } from './errors.js'
import { MIGRATIONS, TARGET_SCHEMA_VERSION, type Migration } from './migrations.js'
import { queryRows } from './rows.js'
import { META_KEYS, MEMORY_TABLE, SCHEMA_MIGRATION_TABLE, createSchemaMigrationTableStatement } from './schema.js'
import { runInTransaction } from './transaction.js'

/** 迁移失败时的人话前缀（命令面/日志直接可读，不含凭据也不含正文）。 */
const MIGRATION_FAILURE = '记忆库 schema 迁移失败'

export interface MigrateOptions {
  /** 库文件绝对路径（备份落在同目录）。 */
  readonly dbPath: string
  /**
   * 本次打开前 `memory` 表尚不存在（bootstrap 判据的一半）。
   * 由 `initializeDatabase` 在 DDL 之前读到的事实传入——本函数执行时表已被建出来。
   * 不传时按「此刻 memory 表是否存在」推断（矩阵行 5/6 的裸调用）。
   */
  readonly freshDatabase?: boolean
  /** 注入时钟（`schema_migration.applied_at`）；缺省系统时间。 */
  readonly now?: () => Date
  /**
   * @internal 仅供测试注入迁移清单（矩阵行 5：注入一条必定失败的迁移）。
   * 生产调用不传，缺省为 `MIGRATIONS`。
   */
  readonly migrations?: readonly Migration[]
  /**
   * @internal 仅供测试覆写备份路径（矩阵行 6：预置同名文件制造 O_EXCL 失败）。
   * 生产调用不传，缺省按 `<db>.bak-<from>-<pid>-<monotonicNs>` 生成。
   */
  readonly backupPath?: (dbPath: string, fromVersion: number) => string
}

export interface MigrateResult {
  /** 迁移前读到的版本；null = 没有版本记录（bootstrap 或 v1 早期库）。 */
  readonly fromVersion: number | null
  readonly toVersion: number
  /** 本次写入 `schema_migration` 的迁移号（bootstrap 也记全部：语句因列已存在而全部跳过）。 */
  readonly applied: readonly number[]
  /** 本次备份文件路径；bootstrap / 无需迁移时为 null。 */
  readonly backupPath: string | null
}

/** 版本值解析：非法（空串 / 非十进制整数）一律 fail-loud，不猜。 */
export function parseSchemaVersion(raw: string, dbPath: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库元数据 omw_meta.${META_KEYS.schemaVersion} 非法（实际 ${JSON.stringify(raw)}，${dbPath}）`,
    )
  }
  return Number(raw)
}

/**
 * 版本高于本插件时的 fail-loud 守卫（矩阵行 4）。
 *
 * 抽成导出是因为 `database.ts` 要在**建表 DDL 之前**调用它：先建表再拒绝会让
 * 「库不被改写」这条不可观测（v3 库可能缺本插件要建的表）。错误码沿用 `schema_mismatch`
 * 词表（`db_read_failed` 那类返回值码不进这条路径）。
 */
export function assertSchemaVersionSupported(
  declared: number | null,
  dbPath: string,
  target: number = TARGET_SCHEMA_VERSION,
): void {
  if (declared === null) return
  if (declared > target) {
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库 schema 版本 ${declared} 高于本插件支持的 ${target}（${dbPath}）：` +
      '旧插件不得写新库（AD-34），请升级插件后再打开；本次不做任何迁移与写入。',
    )
  }
}

/**
 * 读已声明的版本；null = 没有版本记录（`omw_meta` 表缺失或该 key 缺失）。
 * 版本值本身非法时抛 `schema_mismatch`（不把坏值当 0 继续迁移）。
 */
export async function readDeclaredSchemaVersion(
  connection: lbug.Connection,
  dbPath: string,
  meta?: ReadonlyMap<string, string>,
): Promise<number | null> {
  let raw: string | undefined
  if (meta !== undefined) {
    raw = meta.get(META_KEYS.schemaVersion)
  } else {
    try {
      const rows = await queryRows(
        connection,
        `MATCH (m:omw_meta {key: $key}) RETURN m.value AS value`,
        { key: META_KEYS.schemaVersion },
      )
      raw = rows[0]?.value === undefined || rows[0]?.value === null ? undefined : String(rows[0]!.value)
    } catch (error) {
      if (!isMissingTableError(error)) throw error
      return null
    }
  }
  return raw === undefined ? null : parseSchemaVersion(raw, dbPath)
}

/** 一条迁移的确定性校验和（语句文本的 sha256，hex）。 */
function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(migration.statements.map((statement) => statement.ddl).join('\n'))
    .digest('hex')
}

async function columnExists(
  connection: lbug.Connection,
  table: string,
  column: string,
): Promise<boolean> {
  try {
    const rows = await queryRows(connection, `CALL table_info('${table}') RETURN name`)
    return rows.some((row) => String(row.name) === column)
  } catch (error) {
    if (isMissingTableError(error)) return false
    throw error
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 表是否存在（`table_info` 探针；缺失表在 0.22.3 报 "does not exist in catalog"）。 */
async function tableExists(connection: lbug.Connection, table: string): Promise<boolean> {
  try {
    await queryRows(connection, `CALL table_info('${table}') RETURN name`)
    return true
  } catch (error) {
    if (isMissingTableError(error)) return false
    throw error
  }
}

/** 备份路径：`<db>.bak-<from>-<pid>-<monotonicNs>`（同目录；单调纳秒避免同进程同版本重名）。 */
function defaultBackupPath(dbPath: string, fromVersion: number): string {
  return `${dbPath}.bak-${fromVersion}-${process.pid}-${process.hrtime.bigint()}`
}

/**
 * 备份库文件（矩阵行 2/6）：`O_EXCL` 创建，已存在即失败；WAL 一并复制（尽力，复制失败同样拒绝迁移）。
 *
 * 先 `open('wx')` 占位再 `copyFile`：`copyFile` 本身会覆盖目标，只有 `O_EXCL` 这一步
 * 才能真正证明「备份是新建的」。占位句柄必须关掉，否则 Windows 上 copyFile 打不开目标。
 */
export async function backupLibraryFile(dbPath: string, targetPath: string): Promise<void> {
  const placeholder = await open(targetPath, 'wx')
  await placeholder.close()
  await copyFile(dbPath, targetPath)
  for (const suffix of ['.wal', '-wal']) {
    if (await fileExists(dbPath + suffix)) await copyFile(dbPath + suffix, targetPath + suffix)
  }
}

/**
 * 执行迁移（写者路径唯一入口）。
 *
 * @param connection 库连接（本函数自开事务）
 */
export async function migrateDatabase(
  connection: lbug.Connection,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const dbPath = options.dbPath
  const now = options.now ?? (() => new Date())
  const target = TARGET_SCHEMA_VERSION
  const migrations = options.migrations ?? MIGRATIONS

  const fromVersion = await readDeclaredSchemaVersion(connection, dbPath)
  assertSchemaVersionSupported(fromVersion, dbPath, target)

  const memoryExists = await tableExists(connection, MEMORY_TABLE)
  if (fromVersion !== null && !memoryExists) {
    // AD-34 的 fail-loud：版本记录在、表却没了 = 库损坏，绝不靠 CREATE IF NOT EXISTS 静默重建。
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库声明 schema 版本 ${fromVersion}，但 ${MEMORY_TABLE} 表不存在（${dbPath}）：` +
      '库文件可能损坏或被截断。拒绝启动，不做隐式重建（AD-34）。',
    )
  }

  // bootstrap = 「没有版本记录」且「本次打开前也没有表」。新建库的列由建表 DDL 直接带出，
  // 因此不备份、不执行 ALTER。版本键缺失但表已存在（旧库的极端形态）**不是** bootstrap：
  // 走正常迁移路径（先备份），否则会跳过备份这个唯一回滚点。
  const bootstrap = fromVersion === null && (options.freshDatabase ?? !memoryExists)
  const baseVersion = fromVersion ?? 0
  const pending = bootstrap ? [] : migrations.filter((migration) => migration.version > baseVersion)
  if (!bootstrap && pending.length === 0) {
    // 已是最新（矩阵行 3）：不建表、不备份、不写任何行。
    return { fromVersion, toVersion: target, applied: [], backupPath: null }
  }

  // 备份先于任何 DDL / 事务：失败即拒绝迁移（矩阵行 6），此时库内一字未改。
  let backupPath: string | null = null
  if (!bootstrap) {
    backupPath = (options.backupPath ?? defaultBackupPath)(dbPath, baseVersion)
    try {
      await backupLibraryFile(dbPath, backupPath)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new MemoryDbError(
        'schema_migration_failed',
        `${MIGRATION_FAILURE}：无法创建备份 ${backupPath}（${reason}）——拒绝迁移，库内未做任何改动。`,
      )
    }
  }

  // Story 11.4：需要「按表存在性分流」的迁移必须在事务外探测（事务内 binder error 会污染事务）。
  const preparedByVersion = new Map<number, unknown>()
  for (const migration of migrations) {
    const runIt = bootstrap || migration.version > baseVersion
    if (runIt && migration.prepare !== undefined) {
      preparedByVersion.set(migration.version, await migration.prepare(connection))
    }
  }

  const applied: number[] = []
  try {
    await runInTransaction(connection, async () => {
      await runStatement(connection, createSchemaMigrationTableStatement())
      for (const migration of migrations) {
        const runIt = bootstrap || migration.version > baseVersion
        if (runIt) {
          for (const statement of migration.statements) {
            // 0.22.3 的 ADD 不支持 IF NOT EXISTS，重复执行会抛 "already has property"
            // （实测），所以幂等只能靠列存在性检查（同 parent_id 模式）。
            if (await columnExists(connection, statement.table, statement.column)) continue
            await runStatement(connection, statement.ddl)
          }
          // 数据改写（Story 5.4）：同一事务、statements 之后；幂等由迁移自己保证。
          if (migration.run !== undefined) await migration.run(connection, preparedByVersion.get(migration.version))
          await recordMigration(connection, migration, now().toISOString())
          applied.push(migration.version)
        }
      }
      // bootstrap 也走这一支：把版本写成目标值（新库列已由建表 DDL 带出）。
      await mergeMeta(connection, META_KEYS.schemaVersion, String(target))
    })
  } catch (error) {
    if (error instanceof MemoryDbError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new MemoryDbError(
      'schema_migration_failed',
      `${MIGRATION_FAILURE}：从版本 ${fromVersion} 迁到 ${target} 时出错并整体回滚（${reason}）；` +
      `备份保留在 ${backupPath ?? '(bootstrap 不备份)'}。`,
    )
  }

  return { fromVersion, toVersion: target, applied, backupPath }
}

/** 记一条 `schema_migration`（MERGE：同版本重放不重复插、保留首次时间，实测 0.22.3 可用）。 */
async function recordMigration(
  connection: lbug.Connection,
  migration: Migration,
  appliedAt: string,
): Promise<void> {
  const statement = await connection.prepare(
    `MERGE (s:${SCHEMA_MIGRATION_TABLE} {version: $version}) ` +
    'ON CREATE SET s.applied_at = $applied_at, s.checksum = $checksum',
  )
  await runPrepared(connection, statement, {
    version: migration.version,
    applied_at: appliedAt,
    checksum: migrationChecksum(migration),
  })
}

/** 写 `omw_meta.schema_version`（与 database.ts 同一 MERGE 形态）。 */
async function mergeMeta(connection: lbug.Connection, key: string, value: string): Promise<void> {
  const statement = await connection.prepare(
    `MERGE (m:omw_meta {key: $key}) ON CREATE SET m.value = $value ON MATCH SET m.value = $value`,
  )
  await runPrepared(connection, statement, { key, value })
}



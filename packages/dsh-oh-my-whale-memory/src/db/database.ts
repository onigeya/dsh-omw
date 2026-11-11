/**
 * 记忆库打开/建库（Story 1.4 / AC1、AC2、AC4、AC5 / AD-3、AD-4、AD-13、AD-14；
 * Story 1.5 增加只读降级打开 / AC1、AC2、AC4 / AD-12）。
 *
 * 启动顺序（幂等）：
 * 1. 解析绝对路径并创建 `<profile>/memory/`；
 * 2. 打开 Database + Connection，`INSTALL/LOAD` vector 与 fts（扩展是每进程装载，
 *    索引本身持久化在库内）；
 * 3. 若 `memory` 表已存在，从 `table_info` 读实际 `FLOAT[n]` 维度并与配置比对——
 *    不符即抛 `embedding_dim_mismatch`（fail-loud，不静默降级、不重建库，AD-14）；
 * 4. 缺表则建表（`IF NOT EXISTS`），首建时把 dim/model/schema_version/created_at 写入
 *    `omw_meta`（库级元数据，AC2）；
 * 5. 用 `show_indexes()` 判断索引是否存在，缺哪个建哪个——0.22.3 上重复调用
 *    `CREATE_VECTOR_INDEX`/`CREATE_FTS_INDEX` 会抛 Binder exception。
 *
 * Windows 约束（2026-11-09 实测，@ladybugdb/core 0.22.3）：
 * `close()`/`closeSync()` 之后**同进程**再打开同一库文件必失败——
 * `IO exception: Could not set lock on file ... (Error: 33)`，且不会自行恢复（GC 也救不回，
 * 文件锁在进程级）。跨进程则正常（子进程退出后父进程可打开）。`open` 后在测试文件里
 * 追加第二条断言即可复现。
 *
 * 因此本模块的句柄生命周期是**进程级**：同一绝对路径只在第一次 open 时真正建连，
 * 之后永远复用；`close()` 只回收 facade 供宿主 dispose 语义使用，不断开连接。
 * 这也让"维度不符被拒后再次尝试"能稳定复现 `embedding_dim_mismatch`，而不是被
 * 底层锁错误掩盖。Story 1.5 的写者锁需在此基础上设计（跨进程锁才是真正的第二实例判据）。
 *
 * 只读降级（Story 1.5 / AD-12）：第二实例拿不到写者锁时由调用方传 `readOnly: true`
 * 打开同一个库。只读路径**不建库文件、不建表、不写元数据、不 `INSTALL/LOAD` 扩展**；
 * 库不存在直接 `db_open_failed`（不创建空库），写入口 `upsertMemory` 抛
 * `readonly_mode`（AC4）。（`apply` 会先为写者锁文件创建 `<profile>/memory/` 目录并在
 * 其中写 `<dbPath>.lock`——那是进程级锁的载体，不属于库写入。）LadybugDB 的顺序约束
 * （实测）：只要有只读句柄存在，之后同文件的读写打开必失败 `Error: 33`，所以
 * **必须先定角色（先拿锁）再打开库**——该顺序由 index.ts 的 apply 保证。
 */
import { stat } from 'node:fs/promises'
import * as lbug from '@ladybugdb/core'
import { ensureAuditTables } from './audit.js'
import { MemoryDbError } from './errors.js'
import {
  META_KEYS,
  MEMORY_TABLE,
  META_TABLE,
  SCHEMA_VERSION,
  FTS_INDEX_NAME,
  VECTOR_INDEX_NAME,
  assertEmbeddingDim,
  createFtsIndexStatement,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
  createVectorIndexStatement,
} from './schema.js'
import { ensureMemoryDbDirectory } from './paths.js'
import { READONLY_REASON } from './writer-lock.js'
import {
  queryAll,
  upsertMemory,
  type MemoryConnection,
  type UpsertMemoryInput,
  type UpsertMemoryResult,
} from './memory.js'

export interface OpenMemoryDatabaseOptions {
  /** 库文件绝对路径（`<profile>/memory/lbug.db`）。 */
  dbPath: string
  /** 建库 pin 的向量维度。 */
  dim: number
  /** 库级元数据记录的 embedding 模型 id。 */
  modelId: string
  /** 现在时刻（测试注入）。 */
  now?: () => Date
  /**
   * 只读降级打开（Story 1.5 / AC1 / AD-12）：第二实例没有写者锁时为 true。
   * 只读实例不建目录/建表/写元数据/装扩展，也不执行任何写语句。
   */
  readOnly?: boolean
}

export interface MemoryDatabase {
  readonly dbPath: string
  readonly dim: number
  /** 当前配置的 embedding 模型 id（baseline 打开时可被新配置更新）。 */
  modelId: string
  /** 是否为只读降级实例（Story 1.5 / AC2：后续 story 的工具与命令据此禁用写入）。 */
  readonly readonly: boolean
  readonly connection: MemoryConnection
  /**
   * 写入/合并一条记忆。只读实例一律抛 `readonly_mode`（Story 1.5 / AC2）。
   * 带 `embedding` 时长度必须等于 pin 的 dim；省略或传 `null` 表示本次无向量
   * （Story 1.6 工具直写 / Story 1.7 手动写入），三列 embedding/embedding_model_id/
   * embedding_dim 保持 NULL，不写零向量。有向量且未显式给 embeddingModelId 时补库配置的 modelId。
   */
  upsertMemory(input: Omit<UpsertMemoryInput, 'embeddingModelId'> & { embeddingModelId?: string | null }): Promise<UpsertMemoryResult>
  close(): Promise<void>
}
/** 已打开的原始句柄（进程内按绝对路径唯一；Windows 上 close 后同进程无法重开，故永不 close）。 */
interface RawHandle {
  database: lbug.Database
  connection: MemoryConnection
  readonly: boolean
}

const handles = new Map<string, RawHandle>()
const facades = new Map<string, MemoryDatabase>()
/**
 * 同路径正在打开中的 facade：并发 open 共用同一次完整初始化。
 *
 * 只去重底层句柄是不够的——建表之后的 ensureIndexes 不幂等，
 * CREATE_VECTOR_INDEX / CREATE_FTS_INDEX 重复执行会抛
 * "Binder exception: Index memory_embedding_hnsw already exists in table memory."，
 * 所以去重必须覆盖建表 + 元数据 + 建索引全过程。
 */
const openings = new Map<string, Promise<MemoryDatabase>>()
/**
 * 打开失败墓碑（绝对路径 → 原始 error）。
 *
 * 为什么需要：首次 INSTALL/LOAD 失败时 closeSync 并不真正释放库文件锁，
 * 同进程再 new 一次 Database 只会得到 "IO exception: Could not set lock on file ... (Error: 33)"，
 * 把真实原因（例如 Windows 缺 OpenSSL 3 导致扩展加载失败）掩盖掉。墓碑让重试直接抛原始错误。
 */
const openFailures = new Map<string, unknown>()

async function acquireHandle(dbPath: string, readOnly: boolean): Promise<RawHandle> {
  const existing = handles.get(dbPath)
  if (existing) {
    if (existing.readonly !== readOnly) throw createModeMismatchError(dbPath, readOnly, existing.readonly)
    return existing
  }

  const failure = openFailures.get(dbPath)
  if (failure !== undefined) throw failure

  return readOnly ? createReadOnlyHandle(dbPath) : createHandle(dbPath)
}

async function createHandle(dbPath: string): Promise<RawHandle> {
  await ensureMemoryDbDirectory(dbPath)
  const database = new lbug.Database(dbPath)
  const connection = new lbug.Connection(database)
  try {
    // 扩展装载失败（含 Windows OpenSSL 3 缺失）必须冒泡，不做降级。
    await connection.query('INSTALL vector; LOAD vector;')
    await connection.query('INSTALL fts; LOAD fts;')
  } catch (error) {
    // 首次装载就失败：句柄无用，尽力关闭；锁可能仍被占，故记墓碑让重试抛原始错误。
    openFailures.set(dbPath, error)
    closeHandle({ database, connection, readonly: false })
    throw error
  }
  const handle: RawHandle = { database, connection, readonly: false }
  handles.set(dbPath, handle)
  return handle
}

/**
 * 只读实例等待写者把库文件建出来的上限（Story 1.5 / AC1）。
 *
 * 只读模式蕴含"另一个存活实例持有写者锁"，而 `new lbug.Database()` 是惰性打开：
 * 写者拿到锁之后、首次查询（`INSTALL/LOAD` 扩展）之前，库文件还没落盘。两个窗口
 * 几乎同时启动时，第二实例正好落在这个窗口里——此时立刻抛 `db_open_failed` 会让它
 * 连降级只读的机会都没有。等待是有界的、安全的：只有"别人持锁"才会走到这里。
 */
const READONLY_DB_WAIT_MS = 2_000
const READONLY_DB_POLL_MS = 50

/**
 * 只读实例等待写者建完 schema 的上限（Story 1.5 / AC1）。
 *
 * 库文件落盘 ≠ schema 就绪：写者建出库文件之后还要建表、写元数据。两个实例几乎同时
 * 启动时，只读方可能正好读到"库文件已存在、表还没建"的中间态。该等，不该报错。
 */
const READONLY_SCHEMA_WAIT_MS = 2_000
const READONLY_SCHEMA_POLL_MS = 50

/** 有界等待库文件出现；超时返回 false（由调用方决定 fail-loud 文案）。 */
async function waitForLibraryFile(dbPath: string): Promise<boolean> {
  const deadline = Date.now() + READONLY_DB_WAIT_MS
  for (;;) {
    if (await pathExists(dbPath)) return true
    if (Date.now() >= deadline) return false
    await new Promise((wake) => setTimeout(wake, READONLY_DB_POLL_MS))
  }
}

/**
 * 只读句柄（Story 1.5 / AC1）：`readOnly` 是 `Database` 构造函数的第 4 个位置参数。
 * 不建目录、不建库——库文件（有界等待后仍）不存在即 fail-loud，只读实例绝不创建空库；
 * 也不 `INSTALL/LOAD` 扩展（只读打开不做任何写动作）。
 */
async function createReadOnlyHandle(dbPath: string): Promise<RawHandle> {
  if (!(await waitForLibraryFile(dbPath))) {
    throw new MemoryDbError(
      'db_open_failed',
      `只读模式打开失败：等待 ${READONLY_DB_WAIT_MS}ms 后记忆库仍不存在（${dbPath}）。只读实例不创建空库——请先在有写者锁的实例里完成建库。`,
    )
  }
  const database = new lbug.Database(dbPath, undefined, undefined, true)
  const connection = new lbug.Connection(database)
  const handle: RawHandle = { database, connection, readonly: true }
  handles.set(dbPath, handle)
  return handle
}

export async function openMemoryDatabase(options: OpenMemoryDatabaseOptions): Promise<MemoryDatabase> {
  const dim = assertEmbeddingDim(options.dim)
  const dbPath = options.dbPath
  const readOnly = options.readOnly === true

  const existingFacade = facades.get(dbPath)
  if (existingFacade) return applyFacadeOptions(existingFacade, dim, options.modelId, dbPath, readOnly)

  const inFlight = openings.get(dbPath)
  if (inFlight) {
    try {
      const store = await inFlight
      return await applyFacadeOptions(store, dim, options.modelId, dbPath, readOnly)
    } catch {
      // 并发方可能因自身配置失败（例如它的维度不符）：按本次 options 重来一次，
      // 让每个调用方拿到属于自己的错误，而不是互相污染。
    }
  }

  const pending = readOnly
    ? initializeReadOnlyDatabase(dbPath, dim, options)
    : initializeDatabase(dbPath, dim, options)
  openings.set(dbPath, pending)
  try {
    return await pending
  } finally {
    openings.delete(dbPath)
  }
}

async function applyFacadeOptions(
  store: MemoryDatabase,
  dim: number,
  modelId: string,
  dbPath: string,
  readOnly: boolean,
): Promise<MemoryDatabase> {
  if (store.readonly !== readOnly) throw createModeMismatchError(dbPath, readOnly, store.readonly)
  if (store.dim !== dim) throw createDimMismatchError(store.dim, dim, dbPath)
  // 只读实例不写库级元数据——AC2 要求它不执行任何写语句。
  if (readOnly) return store
  if (store.modelId !== modelId) {
    await mergeMetaValue(store.connection, META_KEYS.embeddingModelId, modelId)
    store.modelId = modelId
  }
  return store
}

async function initializeDatabase(
  dbPath: string,
  dim: number,
  options: OpenMemoryDatabaseOptions,
): Promise<MemoryDatabase> {
  const { connection } = await acquireHandle(dbPath, false)
  const now = options.now ?? (() => new Date())

  const meta = await readMetaMap(connection)
  const columns = await readTableColumns(connection, MEMORY_TABLE)
  const { metaDim, actualDim } = verifyExistingSchema(meta, columns, dim, dbPath)

  await connection.query(createMetaTableStatement())
  await connection.query(createMemoryTableStatement(dim))
  await connection.query(createL0RawTableStatement())
  await ensureAuditTables(connection)

  if (actualDim === null) {
    await mergeMetaValue(connection, META_KEYS.schemaVersion, SCHEMA_VERSION)
    await mergeMetaValue(connection, META_KEYS.embeddingDim, String(dim))
    await mergeMetaValue(connection, META_KEYS.embeddingModelId, options.modelId)
    await mergeMetaValue(connection, META_KEYS.createdAt, now().toISOString())
  } else {
    if (metaDim === undefined) await mergeMetaValue(connection, META_KEYS.embeddingDim, String(dim))
    if (!meta.has(META_KEYS.schemaVersion)) await mergeMetaValue(connection, META_KEYS.schemaVersion, SCHEMA_VERSION)
    if (!meta.has(META_KEYS.createdAt)) await mergeMetaValue(connection, META_KEYS.createdAt, now().toISOString())
    if (meta.get(META_KEYS.embeddingModelId) !== options.modelId) {
      await mergeMetaValue(connection, META_KEYS.embeddingModelId, options.modelId)
    }
  }

  await ensureIndexes(connection)

  const store: MemoryDatabase = {
    dbPath,
    dim,
    modelId: options.modelId,
    readonly: false,
    connection,
    async upsertMemory(input) {
      // 省略 / null = 本次无向量（Story 1.6 工具直写、Story 1.7 手动写入）：跳过维度校验
      // 与模型 id 补全，三列（embedding / embedding_model_id / embedding_dim）保持 NULL。
      if (input.embedding == null) {
        return upsertMemory(connection, input, { now })
      }
      const embedding = Array.from(input.embedding)
      if (embedding.length !== dim) {
        throw new MemoryDbError(
          'embedding_dim_mismatch',
          `embedding 向量长度与库 pin 的维度不符：期望 ${dim}，实际 ${embedding.length}（${dbPath}）`,
        )
      }
      return upsertMemory(connection, {
        ...input,
        embedding,
        // 有向量时才补默认模型 id；无向量在上面早退，不得残留模型 ID（三列必须同为 NULL）。
        embeddingModelId: input.embeddingModelId ?? options.modelId,
      }, { now })
    },
    async close() {
      // dispose 只回收 facade；底层句柄保留在进程内以便宿主 dispose→apply 抖动时复用。
      facades.delete(dbPath)
    },
  }
  facades.set(dbPath, store)
  return store
}

/**
 * 只读 facade（Story 1.5 / AC1、AC2、AC4）：复用与写者路径完全相同的库结构校验
 * （同一维度/元数据优先级），但**不建表、不写元数据、不建索引**，写入口一律抛
 * `readonly_mode`。校验失败时回收句柄，不留下半可用的 facade。
 */
async function initializeReadOnlyDatabase(
  dbPath: string,
  dim: number,
  options: OpenMemoryDatabaseOptions,
): Promise<MemoryDatabase> {
  const handle = await acquireHandle(dbPath, true)
  const { connection } = handle
  try {
    const { meta, actualDim } = await readExistingSchema(connection, dim, dbPath)
    if (actualDim === null) {
      throw new MemoryDbError(
        'schema_mismatch',
        `只读模式打开失败：等待 ${READONLY_SCHEMA_WAIT_MS}ms 后库内仍没有 ${MEMORY_TABLE} 表（${dbPath}）——可能来自未完成初始化的实例，或写者实例尚未建库。`,
      )
    }

    const store: MemoryDatabase = {
      dbPath,
      dim: actualDim,
      modelId: meta.get(META_KEYS.embeddingModelId) ?? options.modelId,
      readonly: true,
      connection,
      async upsertMemory() {
        throw createReadonlyModeError(dbPath)
      },
      async close() {
        facades.delete(dbPath)
      },
    }
    facades.set(dbPath, store)
    return store
  } catch (error) {
    handles.delete(dbPath)
    closeHandle(handle)
    throw error
  }
}

/**
 * 只读实例读取已有库的结构（Story 1.5 / AC1）：库文件落盘 ≠ schema 就绪——写者建完库
 * 文件之后还要建表、写元数据，两个实例几乎同时启动时只读方会读到"表还没建"的中间态，
 * 此时该等而不是报错。只在"memory 表尚不存在"这一种中间态上有界重试，其余不一致
 * （维度不符、元数据矛盾）立刻 fail-loud。
 */
async function readExistingSchema(
  connection: MemoryConnection,
  dim: number,
  dbPath: string,
): Promise<{ meta: Map<string, string>; actualDim: number | null }> {
  const deadline = Date.now() + READONLY_SCHEMA_WAIT_MS
  for (;;) {
    const meta = await readMetaMap(connection)
    const columns = await readTableColumns(connection, MEMORY_TABLE)
    const { actualDim } = verifyExistingSchema(meta, columns, dim, dbPath)
    if (actualDim !== null || Date.now() >= deadline) return { meta, actualDim }
    await new Promise((wake) => setTimeout(wake, READONLY_SCHEMA_POLL_MS))
  }
}

/**
 * 已有库的结构校验（写者与只读路径共用，保证同一个库在两条路径上得到同样的结论）：
 * 先按配置维度比对表的实际 `FLOAT[n]`，再比对 `omw_meta.embedding_dim` 与表结构；
 * 缺表时若元数据已声明维度则视为损坏。返回元数据维度与实际维度，缺表时 actualDim 为 null。
 */
function verifyExistingSchema(
  meta: Map<string, string>,
  columns: Map<string, string> | null,
  dim: number,
  dbPath: string,
): { metaDim: number | undefined; actualDim: number | null } {
  const metaDim = readMetaDim(meta, dbPath)
  if (columns === null) {
    if (metaDim !== undefined) {
      throw new MemoryDbError(
        'schema_mismatch',
        `记忆库元数据声明 embedding_dim=${metaDim}，但 memory 节点表不存在（${dbPath}）：库文件可能损坏或来自其他版本`,
      )
    }
    return { metaDim, actualDim: null }
  }

  const actualDim = readEmbeddingColumnDim(columns, dbPath)
  if (actualDim !== dim) throw createDimMismatchError(actualDim, dim, dbPath)
  if (metaDim !== undefined && metaDim !== actualDim) {
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库元数据与表结构不一致：omw_meta.embedding_dim=${metaDim}，而 memory.embedding 实际为 FLOAT[${actualDim}]（${dbPath}）`,
    )
  }
  return { metaDim, actualDim }
}

function createDimMismatchError(storedDim: number, configuredDim: number, dbPath: string): MemoryDbError {
  return new MemoryDbError(
    'embedding_dim_mismatch',
    `记忆库 embedding 维度不符：库内已 pin 为 ${storedDim}，当前配置为 ${configuredDim}（${dbPath}）。` +
    'AD-14 要求 fail-loud 拒绝启动：请恢复原 embedding 模型，或对该库做全量重嵌入 / 迁移到新库；不会静默降级或自动重建。',
  )
}

function createModeMismatchError(dbPath: string, wanted: boolean, actual: boolean): MemoryDbError {
  return new MemoryDbError(
    'db_open_failed',
    `记忆库已在本进程以${actual ? '只读' : '读写'}模式打开，不能再以${wanted ? '只读' : '读写'}模式打开同一路径（${dbPath}）：` +
    'LadybugDB 的库文件句柄在进程内不可重入，关闭句柄也不释放文件锁——请重启本窗口后再试。',
  )
}

function createReadonlyModeError(dbPath: string): MemoryDbError {
  return new MemoryDbError(
    'readonly_mode',
    `记忆库处于只读模式（${READONLY_REASON}），拒绝写入（${dbPath}）：本窗口不是写者实例。` +
    '请关闭持有写者锁的窗口后重启本窗口，或在写者窗口中执行写入。',
  )
}

function closeHandle(handle: RawHandle): void {
  try {
    handle.connection.closeSync()
  } catch {
    /* ignore */
  }
  try {
    handle.database.closeSync()
  } catch {
    /* ignore */
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

async function readTableColumns(connection: MemoryConnection, table: string): Promise<Map<string, string> | null> {
  try {
    const rows = await queryAll(connection, `CALL table_info('${escapeSqlString(table)}') RETURN name, type`)
    return new Map(rows.map((row) => [String(row.name), String(row.type)]))
  } catch (error) {
    if (isMissingCatalogEntry(error)) return null
    throw error
  }
}

async function readMetaMap(connection: MemoryConnection): Promise<Map<string, string>> {
  try {
    const rows = await queryAll(connection, `MATCH (m:${META_TABLE}) RETURN m.key AS key, m.value AS value`)
    return new Map(rows.map((row) => [String(row.key), String(row.value)]))
  } catch (error) {
    if (isMissingCatalogEntry(error)) return new Map()
    throw error
  }
}

function readMetaDim(meta: Map<string, string>, dbPath: string): number | undefined {
  const raw = meta.get(META_KEYS.embeddingDim)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库元数据 omw_meta.embedding_dim 非法（实际 ${JSON.stringify(raw)}，${dbPath}）`,
    )
  }
  return parsed
}

function readEmbeddingColumnDim(columns: Map<string, string>, dbPath: string): number {
  const type = columns.get('embedding')
  const match = type === undefined ? null : /^FLOAT\[(\d+)\]$/i.exec(type)
  if (match === null) {
    throw new MemoryDbError(
      'schema_mismatch',
      `memory 表 embedding 列缺失或类型不是 FLOAT[DIM]（实际 ${type ?? '无该列'}，${dbPath}）`,
    )
  }
  return Number(match[1])
}

/**
 * 0.22.3 上"表不存在"有两种措辞，都要认：
 * - `CALL table_info('x')` → "Catalog exception: x does not exist in catalog."
 * - `MATCH (m:x)` → "Binder exception: Table x does not exist."
 * 其余错误继续冒泡。
 */
function isMissingCatalogEntry(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /does not exist/i.test(message)
}

async function ensureIndexes(connection: MemoryConnection): Promise<void> {
  const rows = await queryAll(connection, 'CALL show_indexes() RETURN table_name AS table_name, index_name AS index_name, index_type AS index_type')
  const names = new Set(rows.map((row) => String(row.index_name)))
  if (!names.has(VECTOR_INDEX_NAME)) await connection.query(createVectorIndexStatement())
  if (!names.has(FTS_INDEX_NAME)) await connection.query(createFtsIndexStatement())
}

async function mergeMetaValue(connection: MemoryConnection, key: string, value: string): Promise<void> {
  const statement = await connection.prepare(
    `MERGE (m:${META_TABLE} {key: $key}) ON CREATE SET m.value = $value ON MATCH SET m.value = $value`,
  )
  await connection.execute(statement, { key, value })
}

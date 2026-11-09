/**
 * 记忆库打开/建库（Story 1.4 / AC1、AC2、AC4、AC5 / AD-3、AD-4、AD-13、AD-14）。
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
 */
import * as lbug from '@ladybugdb/core'
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
}

export interface MemoryDatabase {
  readonly dbPath: string
  readonly dim: number
  /** 当前配置的 embedding 模型 id（baseline 打开时可被新配置更新）。 */
  modelId: string
  readonly connection: MemoryConnection
  /** 写入/合并一条记忆；embedding 长度必须等于 pin 的 dim。 */
  upsertMemory(input: Omit<UpsertMemoryInput, 'embeddingModelId'> & { embeddingModelId?: string }): Promise<UpsertMemoryResult>
  close(): Promise<void>
}
/** 已打开的原始句柄（进程内按绝对路径唯一；Windows 上 close 后同进程无法重开，故永不 close）。 */
interface RawHandle {
  database: lbug.Database
  connection: MemoryConnection
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

async function acquireHandle(dbPath: string): Promise<RawHandle> {
  const existing = handles.get(dbPath)
  if (existing) return existing

  const failure = openFailures.get(dbPath)
  if (failure !== undefined) throw failure

  return createHandle(dbPath)
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
    try {
      connection.closeSync()
    } catch {
      /* ignore */
    }
    try {
      database.closeSync()
    } catch {
      /* ignore */
    }
    throw error
  }
  const handle: RawHandle = { database, connection }
  handles.set(dbPath, handle)
  return handle
}

export async function openMemoryDatabase(options: OpenMemoryDatabaseOptions): Promise<MemoryDatabase> {
  const dim = assertEmbeddingDim(options.dim)
  const dbPath = options.dbPath

  const existingFacade = facades.get(dbPath)
  if (existingFacade) return applyFacadeOptions(existingFacade, dim, options.modelId, dbPath)

  const inFlight = openings.get(dbPath)
  if (inFlight) {
    try {
      const store = await inFlight
      return await applyFacadeOptions(store, dim, options.modelId, dbPath)
    } catch {
      // 并发方可能因自身配置失败（例如它的维度不符）：按本次 options 重来一次，
      // 让每个调用方拿到属于自己的错误，而不是互相污染。
    }
  }

  const pending = initializeDatabase(dbPath, dim, options)
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
): Promise<MemoryDatabase> {
  if (store.dim !== dim) throw createDimMismatchError(store.dim, dim, dbPath)
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
  const { connection } = await acquireHandle(dbPath)
  const now = options.now ?? (() => new Date())

  const meta = await readMetaMap(connection)
  const columns = await readTableColumns(connection, MEMORY_TABLE)
  const metaDim = readMetaDim(meta, dbPath)

  if (columns) {
    const actualDim = readEmbeddingColumnDim(columns, dbPath)
    if (actualDim !== dim) throw createDimMismatchError(actualDim, dim, dbPath)
    if (metaDim !== undefined && metaDim !== actualDim) {
      throw new MemoryDbError(
        'schema_mismatch',
        `记忆库元数据与表结构不一致：omw_meta.embedding_dim=${metaDim}，而 memory.embedding 实际为 FLOAT[${actualDim}]（${dbPath}）`,
      )
    }
  } else if (metaDim !== undefined) {
    throw new MemoryDbError(
      'schema_mismatch',
      `记忆库元数据声明 embedding_dim=${metaDim}，但 memory 节点表不存在（${dbPath}）：库文件可能损坏或来自其他版本`,
    )
  }

  await connection.query(createMetaTableStatement())
  await connection.query(createMemoryTableStatement(dim))
  await connection.query(createL0RawTableStatement())

  if (columns === null) {
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
    connection,
    async upsertMemory(input) {
      const embedding = Array.from(input.embedding)
      if (embedding.length !== dim) {
        throw new MemoryDbError(
          'embedding_dim_mismatch',
          `embedding 向量长度与库 pin 的维度不符：期望 ${dim}，实际 ${embedding.length}（${dbPath}）`,
        )
      }
      return upsertMemory(connection, { ...input, embedding, embeddingModelId: input.embeddingModelId ?? options.modelId }, { now })
    },
    async close() {
      // dispose 只回收 facade；底层句柄保留在进程内以便宿主 dispose→apply 抖动时复用。
      facades.delete(dbPath)
    },
  }
  facades.set(dbPath, store)
  return store
}

function createDimMismatchError(storedDim: number, configuredDim: number, dbPath: string): MemoryDbError {
  return new MemoryDbError(
    'embedding_dim_mismatch',
    `记忆库 embedding 维度不符：库内已 pin 为 ${storedDim}，当前配置为 ${configuredDim}（${dbPath}）。` +
    'AD-14 要求 fail-loud 拒绝启动：请恢复原 embedding 模型，或对该库做全量重嵌入 / 迁移到新库；不会静默降级或自动重建。',
  )
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
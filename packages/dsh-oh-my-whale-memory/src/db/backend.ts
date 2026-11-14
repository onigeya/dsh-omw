/**
 * 存储后端适配层（Node ↔ Electron 兼容，AD-32）。
 *
 * 宿主有两套运行时，对应两种 lbug 装载方式（2026-11-13 实测）：
 * - 纯 Node（`process.versions.electron === undefined`，NODE_MODULE_VERSION 137）：
 *   `@ladybugdb/core` 原生 addon 正常加载。
 * - Electron（桌面版 `dsh.cmd` 以 `ELECTRON_RUN_AS_NODE=1` 启动，NODE_MODULE_VERSION 149）：
 *   原生 addon 在 dlopen 阶段失败（`A dynamic link library (DLL) initialization routine
 *   failed.`），必须改用 `@ladybugdb/wasm-core/nodejs`（NODEFS 真文件系统 + worker_threads）。
 *
 * 两端同为 0.22.3、storage version 同为 49 —— 同一个 `lbug.db` 可被任一后端打开，
 * 切换运行时不需要迁移库文件。
 *
 * 运行时判据用 `process.versions.electron`（宿主自己在 util/ripgrep 用的同款判据）。
 * **不要用 `process.type`**：`ELECTRON_RUN_AS_NODE` 模式下它恒为 `undefined`，
 * 两种运行时无法区分（2026-11-13 实测）。
 *
 * 本文件是**唯一**知道后端差异的地方，差异共 5 处：
 * 1. 模块装载：wasm 的 `./nodejs` 子路径只提供 CJS 的 `require` 条件（无 `import` 条件），
 *    所以用 `createRequire` 而不是 `import()`；
 * 2. `Database` 构造：native 的 `readOnly` 在第 4 个位置参数，wasm 在第 5 个
 *    （wasm 第 3 位是 `maxNumThreads`）；
 * 3. 扩展装载：native 每进程 `INSTALL/LOAD vector|fts`；wasm 扩展已静态编译，
 *    `INSTALL` 会抛 `Binder exception: Extensions are not available in the WASM
 *    environment` → no-op；
 * 4. 取行：native `getAll()`，wasm 只有 `getAllObjects()`；
 * 5. 关闭：native `closeSync()`，wasm 只有 async `close()`。
 */
import { createRequire } from 'node:module'
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from './errors.js'

export type StorageBackendKind = 'native' | 'wasm'

const NATIVE_SPECIFIER = '@ladybugdb/core'
const WASM_SPECIFIER = '@ladybugdb/wasm-core/nodejs'

/**
 * 运行时是否 Electron（含 `ELECTRON_RUN_AS_NODE` 模式）。
 * 判据是 `process.versions.electron`：纯 Node 下不存在该字段。
 */
export function isElectronRuntime(): boolean {
  return (process.versions as Record<string, string | undefined>).electron !== undefined
}

/** 后端差异的收敛面：db/ 其余代码只依赖这几个操作。 */
export interface StorageBackend {
  readonly kind: StorageBackendKind
  /** 构造 `Database`；`readOnly` 由本层映射到各后端正确的位置参数。 */
  createDatabase(dbPath: string, readOnly: boolean): lbug.Database
  /**
   * 构造 `Connection`。wasm 的 worker 需要显式 `init()`（native 保持原本的惰性行为，
   * 不额外调用 init——库文件落盘时机是只读竞态等待逻辑的前提）。
   */
  createConnection(database: lbug.Database): Promise<lbug.Connection>
  /**
   * 每进程装载扩展；wasm 为 no-op（扩展已静态编译）。失败必须冒泡，不做降级。
   *
   * `install: false`（Story 3.1 / P4 探针）：native 只读连接不 `INSTALL` 只 `LOAD`——
   * 扩展已被某个写者实例安装在本机用户目录，只读实例无需下载即可装载。装载失败
   * 照常冒泡，由调用方决定是否吞掉（database.ts 的只读开库吞掉，recall 查询期
   * 以失败信封暴露）。
   */
  loadExtensions(connection: lbug.Connection, options?: { install?: boolean }): Promise<void>
  /** 关闭句柄；两后端的部分失败都吞掉（调用方只做尽力回收）。 */
  close(database: lbug.Database, connection: lbug.Connection): Promise<void>
  /** 引擎 storage version（两后端必须一致，否则库文件不可互换）。 */
  storageVersion(): Promise<number>
}

/** 只取两后端共有的构造面。 */
interface LoadedModule {
  Database: new (...args: unknown[]) => lbug.Database
  Connection: new (...args: unknown[]) => lbug.Connection
  getStorageVersion?: () => Promise<bigint> | bigint
}

const requireFromHere = createRequire(import.meta.url)

function loadModule(kind: StorageBackendKind): LoadedModule {
  const specifier = kind === 'wasm' ? WASM_SPECIFIER : NATIVE_SPECIFIER
  try {
    return requireFromHere(specifier) as LoadedModule
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new MemoryDbError(
      'db_backend_unavailable',
      `记忆库后端 ${specifier} 加载失败（${kind} 后端）：${reason}`,
    )
  }
}

function nativeBackend(module: LoadedModule): StorageBackend {
  return {
    kind: 'native',
    createDatabase(dbPath, readOnly) {
      // native 签名：(databasePath, bufferManagerSize?, enableCompression?, readOnly?)
      return new module.Database(dbPath, undefined, undefined, readOnly)
    },
    async createConnection(database) {
      return new module.Connection(database)
    },
    async loadExtensions(connection, options) {
      // 扩展是每进程装载（失败含 Windows 缺 OpenSSL 3），必须冒泡。
      // 只读实例（install: false）只 LOAD 不 INSTALL：扩展已由写者实例安装，无需联网下载。
      if (options?.install === false) {
        // 两条各自 try/catch：vector 失败不得挡住 fts（否则只读实例连关键词单路也丢）；
        // 失败仍要冒泡（调用方决定吞不吞），但必须**逐项**带上原因——只抛「最后一个失败」
        // 会让「fts 可用而 vector 不可用」这种部分成功状态不可辨（Story 3.1 / F-06）。
        const failures: string[] = []
        for (const extension of ['vector', 'fts'] as const) {
          try {
            await connection.query(`LOAD ${extension};`)
          } catch (error) {
            failures.push(`${extension}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (failures.length > 0) throw new Error(`扩展 LOAD 失败（${failures.join('；')}）`)
        return
      }
      await connection.query('INSTALL vector; LOAD vector;')
      await connection.query('INSTALL fts; LOAD fts;')
    },
    async close(database, connection) {
      try {
        (connection as unknown as { closeSync?: () => void }).closeSync?.()
      } catch {
        /* 尽力回收 */
      }
      try {
        (database as unknown as { closeSync?: () => void }).closeSync?.()
      } catch {
        /* 尽力回收 */
      }
    },
    async storageVersion() {
      const ctor = module.Database as unknown as { getStorageVersion(): number }
      return Number(ctor.getStorageVersion())
    },
  }
}

function wasmBackend(module: LoadedModule): StorageBackend {
  return {
    kind: 'wasm',
    createDatabase(dbPath, readOnly) {
      // wasm 签名：(databasePath, bufferPoolSize?, maxNumThreads?, enableCompression?, readOnly?)
      return new module.Database(dbPath, 0, 0, true, readOnly)
    },
    async createConnection(database) {
      // wasm 把调用派发给 worker 线程，显式 init 保证 worker 就绪后再跑 DDL。
      await (database as unknown as { init(): Promise<void> }).init()
      const connection = new module.Connection(database)
      await (connection as unknown as { init(): Promise<void> }).init()
      return connection
    },
    async loadExtensions() {
      // wasm 扩展静态编译进 wasm 模块：INSTALL/LOAD 会抛
      // "Binder exception: Extensions are not available in the WASM environment"。
    },
    async close(database, connection) {
      try {
        await (connection as unknown as { close(): Promise<void> }).close()
      } catch {
        /* 尽力回收 */
      }
      try {
        await (database as unknown as { close(): Promise<void> }).close()
      } catch {
        /* 尽力回收 */
      }
    },
    async storageVersion() {
      const mod = module as unknown as { getStorageVersion(): Promise<bigint> | bigint }
      return Number(await mod.getStorageVersion())
    },
  }
}

/**
 * 取第一条结果集的全部行。
 *
 * **按结果对象自身的方法分派**，不查"当前是哪个后端"——native 有 `getAll()`，wasm 只有
 * `getAllObjects()`。同进程里出现另一个后端的对象（测试/诊断）也不会串味，这是
 * 后端选择与结果读取解耦的关键。
 */
export async function collectResultRows(
  result: lbug.QueryResult | lbug.QueryResult[],
): Promise<Record<string, unknown>[]> {
  const first = Array.isArray(result) ? result[0]! : result
  const carrier = first as unknown as {
    getAll?: () => Promise<Record<string, unknown>[]>
    getAllObjects?: () => Promise<Record<string, unknown>[]>
  }
  if (typeof carrier.getAll === 'function') return await carrier.getAll()
  if (typeof carrier.getAllObjects === 'function') return await carrier.getAllObjects()
  throw new MemoryDbError(
    'db_backend_unavailable',
    '查询结果对象既没有 getAll() 也没有 getAllObjects()：不认识的 lbug 结果形态',
  )
}

const backends = new Map<StorageBackendKind, StorageBackend>()

/**
 * 取当前运行时对应的后端；`forcedKind` 只供测试强制指定（生产调用不传）。
 */
export function loadStorageBackend(forcedKind?: StorageBackendKind): StorageBackend {
  const kind = forcedKind ?? (isElectronRuntime() ? 'wasm' : 'native')
  const cached = backends.get(kind)
  if (cached !== undefined) return cached
  const module = loadModule(kind)
  const backend = kind === 'wasm' ? wasmBackend(module) : nativeBackend(module)
  backends.set(kind, backend)
  return backend
}

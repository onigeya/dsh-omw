/**
 * 存储后端适配层（AD-32）：Node 用 `@ladybugdb/core` 原生 addon，Electron 用
 * `@ladybugdb/wasm-core/nodejs`（桌面版宿主以 ELECTRON_RUN_AS_NODE 启动，NODE_MODULE_VERSION
 * 149 下原生 addon 必然 dlopen 失败）。
 *
 * 该文件守住三件事：
 * 1. 纯 Node 运行时默认选 native 后端（判据是 process.versions.electron，不是 process.type）；
 * 2. 两后端 storage version 一致 —— 同一个 lbug.db 可互换打开，切运行时不需要迁移；
 * 3. wasm 后端在纯 Node 下也能跑完「建表 + 向量/FTS 索引 + 写入 + 读回 + 重开」，
 *    这样 Electron 专属路径不需要 Electron 就能被 CI 守护。
 */
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isElectronRuntime, loadStorageBackend } from '../src/db/backend'
import { collectRows } from '../src/db/rows'
import {
  createFtsIndexStatement,
  createMemoryTableStatement,
  createVectorIndexStatement,
} from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)

const DIM = 4

describe('存储后端（Node ↔ Electron）', () => {
  it('纯 Node 运行时选择 native 后端', () => {
    // process.type 在 ELECTRON_RUN_AS_NODE 下也是 undefined，所以判据必须是 versions.electron。
    expect(isElectronRuntime()).toBe(false)
    expect(loadStorageBackend().kind).toBe('native')
  })

  it('native 与 wasm 的 storage version 一致（同一 lbug.db 可互换）', async () => {
    const native = await loadStorageBackend('native').storageVersion()
    const wasm = await loadStorageBackend('wasm').storageVersion()
    expect(wasm).toBe(native)
    expect(native).toBeGreaterThan(0)
  })

  it('wasm 后端可建表建索引写下读回，且重开后可读（Electron 走这条路径）', async () => {
    const backend = loadStorageBackend('wasm')
    expect(backend.kind).toBe('wasm')
    const dbPath = join(await makeTempDir('omw-backend-wasm-'), 'lbug.db')

    const database = backend.createDatabase(dbPath, false)
    const connection = await backend.createConnection(database)
    // wasm 扩展静态编译：loadExtensions 必须是 no-op（INSTALL 会抛 Binder exception）。
    await expect(backend.loadExtensions(connection)).resolves.toBeUndefined()

    for (const statement of [
      createMemoryTableStatement(DIM),
      createVectorIndexStatement(),
      createFtsIndexStatement(),
    ]) {
      const result = await connection.query(statement)
      expect(result.isSuccess()).toBe(true)
    }

    const insert = await connection.query(
      `CREATE (:memory {id: 'wasm-1', layer: 'L1', text: 'hello whale', embedding: [1.0, 0.0, 0.0, 0.0]})`,
    )
    expect(insert.isSuccess()).toBe(true)

    const counted = await collectRows(await connection.query('MATCH (m:memory) RETURN count(m) AS n'))
    expect(Number(counted[0]!.n)).toBe(1)

    // 向量与 FTS 查询都必须可用（与生产中创建索引的参数保持一致）。
    const vector = await connection.query(
      `CALL QUERY_VECTOR_INDEX('memory', 'memory_embedding_hnsw', [1.0, 0.0, 0.0, 0.0], 1) RETURN *`,
    )
    expect(vector.isSuccess()).toBe(true)
    const fts = await connection.query(
      `CALL QUERY_FTS_INDEX('memory', 'memory_text_fts', 'whale') RETURN *`,
    )
    expect(fts.isSuccess()).toBe(true)

    await backend.close(database, connection)

    // 重开同一文件：wasm 后端（NODEFS）持久化必须生效。
    const reopened = backend.createDatabase(dbPath, false)
    const reopenedConnection = await backend.createConnection(reopened)
    const again = await collectRows(await reopenedConnection.query('MATCH (m:memory) RETURN count(m) AS n'))
    expect(Number(again[0]!.n)).toBe(1)
    await backend.close(reopened, reopenedConnection)
  })
})

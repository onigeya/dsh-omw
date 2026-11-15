/**
 * Story 5.4 / AC:1315-1317：显式 `bufferManagerSize` 后，单进程能开 16 个库实例。
 *
 * 背景：LadybugDB 默认 `bufferManagerSize` 为每个 `Database` 预留 8 TiB 虚拟地址（`2^43`），
 * Windows 单进程虚拟地址空间有限，实测第 16 个实例开库时抛
 * `VirtualAlloc ... 8796093022208 failed`。`backend.ts` 现在显式传 256 MiB
 * （`NATIVE_BUFFER_POOL_SIZE`）。
 *
 * 开库预算：本文件 **16 个实例 = 16 次开库**，每个用独立临时文件、只建 raw `Database`
 * 不建 schema（比 `openMemoryDatabase` 快一个量级），结束逐个 `closeSync`。
 */
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NATIVE_MAX_DB_SIZE, loadStorageBackend, runStatement } from '../src/db/backend'
import { cleanupTempDirs, makeTempDir } from './tmp'

const INSTANCE_COUNT = 16

describe('单进程多实例上限（AC:1315-1317）', () => {
  it('显式 buffer pool 后 16 个实例可同时打开', async () => {
    const backend = loadStorageBackend()
    // 本用例只对 native 后端有意义：wasm 的 bufferPoolSize 走 worker，不受这条限制。
    expect(backend.kind).toBe('native')
    // 8 TiB 的 VirtualAlloc 来自 maxDBSize 的默认值，必须显式给（见 backend.ts 注释）；
    // bufferManagerSize 保持默认（实测 256 MiB 会让重活测试报 "buffer pool is full"）。
    expect(NATIVE_MAX_DB_SIZE).toBe(4 * 1024 * 1024 * 1024)

    const dir = await makeTempDir('omw-instances-')
    const databases: unknown[] = []
    try {
      for (let i = 0; i < INSTANCE_COUNT; i += 1) {
        const database = backend.createDatabase(join(dir, `db-${String(i)}.lbug`), false)
        // 只构造不查询是懒打开的：必须真建连接并跑一条语句，缓冲池才会实际占用地址空间。
        const connection = await backend.createConnection(database)
        await runStatement(connection, 'RETURN 1 AS ok')
        databases.push(database)
      }
      expect(databases).toHaveLength(INSTANCE_COUNT)
    } finally {
      for (const database of databases) {
        // 只尽力关闭：进程退出也会释放；这里避免把 16 个句柄留到 afterAll。
        ;(database as { closeSync?: () => void }).closeSync?.()
      }
    }
  }, 120_000)
})

afterAll(() => cleanupTempDirs())

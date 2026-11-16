/**
 * Story 5.4 / AC:1315-1317：显式 `maxDBSize` 后，单进程能开 16 个库实例。
 *
 * 背景：LadybugDB 默认 `maxDBSize` 为每个 `Database` 预留 8 TiB 虚拟地址（`2^43`），
 * Windows 单进程地址空间有限，实测第 16 个实例开库时抛
 * `VirtualAlloc ... 8796093022208 failed`。`backend.ts` 现在显式传
 * `NATIVE_MAX_DB_SIZE = 4 GiB`（第 5 位构造参数）。
 *
 * 为什么在**子进程**里跑（2026-11-16 调整）：16 个实例 × 默认 buffer manager 会与本测试
 * 进程里其它重活用例抢内存（实测整轮 `pnpm verify` 出现 `JavaScript heap out of memory`）。
 * 放进独立子进程既不改变被测事实（16 个实例、同一对构造参数），又让主测试进程的内存曲线
 * 与之前一致。子进程直接用 `@ladybugdb/core` 构造，参数逐字来自本文件从 `backend.ts` 读出的常量。
 *
 * 开库预算：本文件 1 次开库计数（子进程内的 16 个实例；主进程不建库）。
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NATIVE_MAX_DB_SIZE, loadStorageBackend } from '../src/db/backend'
import { cleanupTempDirs, makeTempDir } from './tmp'

const INSTANCE_COUNT = 16

describe('单进程多实例上限（AC:1315-1317）', () => {
  it('16 个实例在子进程里同时打开（显式 maxDBSize，默认值会申请 8 TiB 失败）', async () => {
    const backend = loadStorageBackend()
    // 本用例只对 native 后端有意义：wasm 的 bufferPoolSize 走 worker，不受这条限制。
    expect(backend.kind).toBe('native')
    expect(NATIVE_MAX_DB_SIZE).toBe(4 * 1024 * 1024 * 1024)

    const dir = await makeTempDir('omw-instances-')
    const script = [
      "import { Database, Connection } from '@ladybugdb/core'",
      "const fs = await import('node:fs')",
      'const [dir, count, maxDbSize] = JSON.parse(process.env.OMW_INSTANCE_JOB)',
      'fs.mkdirSync(dir, { recursive: true })',
      'const opened = []',
      'for (let i = 0; i < Number(count); i += 1) {',
      '  const db = new Database(`${dir}/db-${i}.lbug`, undefined, undefined, false, Number(maxDbSize))',
      "  const conn = new Connection(db)",
      "  await conn.query('RETURN 1 AS ok')",
      '  opened.push(db)',
      '}',
      'process.stdout.write(String(opened.length))',
      'for (const db of opened) db.closeSync?.()',
    ].join('\n')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        OMW_INSTANCE_JOB: JSON.stringify([join(dir, 'instances'), INSTANCE_COUNT, NATIVE_MAX_DB_SIZE]),
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(child.status, `子进程失败：${child.stderr || child.stdout}`).toBe(0)
    expect(child.stdout.trim()).toBe(String(INSTANCE_COUNT))
  }, 180_000)
})

afterAll(() => cleanupTempDirs())

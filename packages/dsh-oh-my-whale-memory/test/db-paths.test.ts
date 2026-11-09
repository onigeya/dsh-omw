/**
 * 库路径守卫与目录创建（AC1）。
 *
 * resolveMemoryDbPath 是唯一路径来源（不自行拼 DSH_HOME）；空 profile 目录必须
 * fail-loud 抛 MemoryDbError('db_open_failed')，否则会静默把库写到 cwd 下。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import {
  MEMORY_DB_DIR,
  MEMORY_DB_FILENAME,
  ensureMemoryDbDirectory,
  resolveMemoryDbPath,
} from '../src/db/paths'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('resolveMemoryDbPath 守卫', () => {
  it('空 / 空白 profile 目录抛 MemoryDbError(code=db_open_failed)', () => {
    for (const bad of ['', '   ']) {
      try {
        resolveMemoryDbPath(bad)
        throw new Error('应当抛错，实际未抛')
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryDbError)
        expect((error as MemoryDbError).code).toBe('db_open_failed')
      }
    }
  })

  it('解析为 <profile>/memory/lbug.db', () => {
    const profileDir = join(tmpdir(), 'omw-path-check')
    expect(resolveMemoryDbPath(profileDir)).toBe(join(profileDir, MEMORY_DB_DIR, MEMORY_DB_FILENAME))
  })
})

describe('ensureMemoryDbDirectory', () => {
  it('建出嵌套的 <dir>/memory 目录（幂等）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omw-paths-'))
    dirs.push(root)
    const dbPath = resolveMemoryDbPath(join(root, 'nested', 'profile'))
    await ensureMemoryDbDirectory(dbPath)
    const info = await stat(join(root, 'nested', 'profile', MEMORY_DB_DIR))
    expect(info.isDirectory()).toBe(true)
    // 幂等：再次调用不抛（mkdir recursive）
    await expect(ensureMemoryDbDirectory(dbPath)).resolves.toBeUndefined()
  })
})

/**
 * 并发打开同一库的回归测试（Story 1.4 / AC1、AC2）。
 *
 * 契约：同一路径的并发 openMemoryDatabase 共用一次完整初始化——底层句柄只能拿一次文件锁，
 * 且建索引不幂等（重复 CREATE_VECTOR_INDEX 抛 "Binder exception: Index ... already exists"），
 * 因此去重必须覆盖建表 + 元数据 + 建索引全过程，两个调用方拿到同一个 facade。
 * 并发但配置维度不同时，后到者拿到属于自己的 embedding_dim_mismatch，而不是被对方的错误污染。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 abi-smoke.test.ts。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { MemoryDbError } from '../src/db/errors'
import { cleanupTempDirs, makeTempDir } from './tmp'

const stores: MemoryDatabase[] = []

async function tempDbPath(label: string): Promise<string> {
  return resolveMemoryDbPath(await makeTempDir(`omw-conc-${label}-`))
}

afterAll(async () => {
  for (const store of stores) {
    try {
      await store.close()
    } catch {
      /* ignore */
    }
  }
  await cleanupTempDirs()
})

describe('并发打开同一库', () => {
  it('并发 open 同路径返回同一 facade，且不抛索引已存在', async () => {
    const dbPath = await tempDbPath('same')
    const [first, second] = await Promise.all([
      openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model' }),
      openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model' }),
    ])
    stores.push(first, second)
    expect(second).toBe(first)
    expect(second.connection).toBe(first.connection)
  })

  it('并发 open 维度不同时，后到者得到 embedding_dim_mismatch', async () => {
    const dbPath = await tempDbPath('dim')
    const first = openMemoryDatabase({ dbPath, dim: 8, modelId: 'test-embed-model' })
    const second = openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model' })
    const resolved = await first
    stores.push(resolved)
    expect(resolved.dim).toBe(8)
    await expect(second).rejects.toMatchObject({ code: 'embedding_dim_mismatch' })
    await expect(second).rejects.toBeInstanceOf(MemoryDbError)
  })
})

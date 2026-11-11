/**
 * runInTransaction 重入守卫测试（Story 2.2 / AC8；Epic 1 复盘遗留项 A-2）。
 *
 * 契约：同一 async 链内嵌套调用**立即抛普通 Error**（不再静默挂起）；并发（非嵌套）调用
 * 仍按调用顺序排队。还包含「抛错后外层回滚、连接与写链都还能继续用」。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-upsert.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll, upsertMemory } from '../src/db/memory'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let store: MemoryDatabase
let seq = 0

const nextId = (tag: string): string => `reentry-${tag}-${process.pid}-${seq++}`

beforeAll(async () => {
  dir = await makeTempDir('omw-tx-reentry-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function createRow(id: string): Promise<void> {
  await queryAll(store.connection, `CREATE (q:l1_inbox {id: '${id}', status: 'pending'})`)
}

async function rowIds(id: string): Promise<string[]> {
  const rows = await queryAll(store.connection, `MATCH (q:l1_inbox) WHERE q.id = '${id}' RETURN q.id AS id`)
  return rows.map((row) => String(row.id))
}

describe('AC8：同一 async 链内不得重入', () => {
  it('单层嵌套 → 立即抛错（不再静默挂起）', async () => {
    await expect(
      runInTransaction(store.connection, async () => runInTransaction(store.connection, async () => 'inner')),
    ).rejects.toThrow(/不得重入/)
  })

  it('两层嵌套也在最内层被拦住', async () => {
    await expect(
      runInTransaction(store.connection, async () =>
        runInTransaction(store.connection, async () =>
          runInTransaction(store.connection, async () => 'deep'))),
    ).rejects.toThrow(/不得重入/)
  })

  it('嵌套「自开事务的原语」（upsertMemory）同样被拦住', async () => {
    await expect(
      runInTransaction(store.connection, async () =>
        upsertMemory(store.connection, { layer: 'L1', text: '重入守卫夹具' })),
    ).rejects.toThrow(/不得重入/)
  })

  it('抛错后外层回滚（半写不落库）、连接与写链仍可用', async () => {
    const id = nextId('rollback')
    await expect(
      runInTransaction(store.connection, async () => {
        await createRow(id)
        await runInTransaction(store.connection, async () => 'inner')
      }),
    ).rejects.toThrow(/不得重入/)

    expect(await rowIds(id)).toHaveLength(0)
    expect(await runInTransaction(store.connection, async () => 'ok')).toBe('ok')
  })
})

describe('并发非嵌套：仍按调用顺序串行执行（守卫不误杀）', () => {
  it('Promise.all 里的两次写都成功且都落库', async () => {
    const a = nextId('concurrent-a')
    const b = nextId('concurrent-b')
    const results = await Promise.all([
      runInTransaction(store.connection, async () => {
        await createRow(a)
        return 'a'
      }),
      runInTransaction(store.connection, async () => {
        await createRow(b)
        return 'b'
      }),
    ])
    expect(results).toEqual(['a', 'b'])
    expect(await rowIds(a)).toEqual([a])
    expect(await rowIds(b)).toEqual([b])
  })

  it('上一事务失败不卡死后续事务（写链只留已结算 promise）', async () => {
    await expect(runInTransaction(store.connection, async () => {
      throw new Error('夹具故意失败')
    })).rejects.toThrow('夹具故意失败')
    expect(await runInTransaction(store.connection, async () => 'next')).toBe('next')
  })
})

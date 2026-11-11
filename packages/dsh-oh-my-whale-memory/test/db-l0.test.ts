/**
 * L0 原始流水原语真库测试（Story 2.1 / AC①④、AD-4、NFR10）。
 *
 * 覆盖 spec 的 I/O Matrix 中「step 阈值达成」落库形态所需的两条地基：写一行（时间列 UTC
 * ISO-8601、actor = 会话 id）与同 id 重放不覆盖（append-only）。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-inbox-queue.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { captureStableKey, l0InboxId, l0RawId, writeL0Raw } from '../src/db/l0'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase

beforeAll(async () => {
  const dir = await makeTempDir('omw-l0-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function readL0(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await queryAll(
    store.connection,
    "MATCH (l:l0_raw) WHERE l.id = '" + id + "' " +
    'RETURN l.id AS id, l.raw_text AS raw_text, l.recorded_at AS recorded_at, l.actor AS actor',
  )
  return rows[0]
}

describe('AC①④：L0 append-only 写入', () => {
  it('在调用方事务内写一行：recorded_at 为 UTC ISO-8601，actor 为会话 id', async () => {
    const id = l0RawId(captureStableKey('turn', 's1', '1'))
    await runInTransaction(store.connection, () =>
      writeL0Raw(store.connection, {
        id,
        text: 'user: 你好',
        recordedAt: new Date(Date.UTC(2026, 10, 11, 1, 2, 3)),
        actor: 's1',
      }),
    )
    const row = await readL0(id)
    expect(row?.raw_text).toBe('user: 你好')
    expect(row?.recorded_at).toBe('2026-11-11T01:02:03.000Z')
    expect(row?.actor).toBe('s1')
  })

  it('同 id 重放不覆盖既有行、不新增第二行（append-only）', async () => {
    const id = l0RawId(captureStableKey('compaction', 's2', 'abc'))
    await runInTransaction(store.connection, () =>
      writeL0Raw(store.connection, { id, text: '第一版', actor: 's2' }),
    )
    await runInTransaction(store.connection, () =>
      writeL0Raw(store.connection, { id, text: '第二版（不得覆盖）', actor: 's2' }),
    )
    expect((await readL0(id))?.raw_text).toBe('第一版')
    const all = await queryAll(store.connection, 'MATCH (l:l0_raw) RETURN l.id AS id')
    expect(all.filter((row) => row.id === id)).toHaveLength(1)
  })
})

describe('采集 id 确定性（崩溃重放不重复的根据）', () => {
  it('同一稳定身份算出同一对 id；不同身份不撞；L0 与 INBOX 前缀不同', () => {
    const a = captureStableKey('turn', 's1', 3)
    const b = captureStableKey('turn', 's1', 3)
    const c = captureStableKey('turn', 's1', 4)
    expect(l0RawId(a)).toBe(l0RawId(b))
    expect(l0InboxId(a)).toBe(l0InboxId(b))
    expect(l0RawId(a)).not.toBe(l0RawId(c))
    expect(l0RawId(a)).not.toBe(l0InboxId(a))
    expect(l0RawId(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

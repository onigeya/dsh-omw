/**
 * 迁移 0010：User Portrait 分类值 `persona` → `user_portrait`（Story 11.4 / 矩阵行 1、6）。
 *
 * 直接调用迁移的 `run`（执行器的事务/备份语义由 db-migration.test.ts 的通用矩阵覆盖），
 * 验证四列改写、字段保真、审计/任务 kind 不被改写、重放幂等。1 次开库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { MIGRATION_0010 } from '../src/db/migrations/0010-user-portrait-kind'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase

beforeAll(async () => {
  const dir = await makeTempDir('omw-migr-0010-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
  const c = store.connection
  await c.query("CREATE (:memory {id: 'm-persona', layer: 'L1', kind: 'persona', priority: -1, text: '旧画像正文', source_refs: []})")
  await c.query("CREATE (:memory {id: 'm-work', layer: 'L1', kind: 'work_fact', priority: 0, text: '普通事实', source_refs: []})")
  await c.query("CREATE (:l1_inbox {id: 'i-persona', kind: 'persona'})")
  await c.query("CREATE (:l2_inbox {id: 'l2-persona', kind: 'persona'})")
  await c.query("CREATE (:pending_decision {id: 'p-persona', kind: 'persona'})")
  // 不得改写的两列：generation_log.kind / slow_task.kind。
  await c.query("CREATE (:generation_log {id: 'g-persona', kind: 'persona'})")
  await c.query("CREATE (:slow_task {id: 's-persona', kind: 'persona'})")
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function kindOf(table: string, id: string): Promise<unknown> {
  const rows = await queryAll(store.connection, `MATCH (n:${table} {id: '${id}'}) RETURN n.kind AS kind`)
  return rows[0]?.kind
}

describe('迁移 0010（矩阵行 1、6）', () => {
  it('四列 persona → user_portrait；字段保真；generation_log / slow_task 不改写', async () => {
    await MIGRATION_0010.run?.(store.connection)
    expect(await kindOf('memory', 'm-persona')).toBe('user_portrait')
    expect(await kindOf('l1_inbox', 'i-persona')).toBe('user_portrait')
    expect(await kindOf('l2_inbox', 'l2-persona')).toBe('user_portrait')
    expect(await kindOf('pending_decision', 'p-persona')).toBe('user_portrait')
    // 非 persona 行原样；审计/任务 kind 原样（语义不同的 kind 列不得被篡改）。
    expect(await kindOf('memory', 'm-work')).toBe('work_fact')
    expect(await kindOf('generation_log', 'g-persona')).toBe('persona')
    expect(await kindOf('slow_task', 's-persona')).toBe('persona')

    // 字段保真：正文/优先级/层不变。
    const rows = await queryAll(
      store.connection,
      "MATCH (m:memory {id: 'm-persona'}) RETURN m.text AS text, m.priority AS priority, m.layer AS layer",
    )
    expect(rows[0]).toMatchObject({ text: '旧画像正文', priority: -1, layer: 'L1' })
  })

  it('重放幂等：第二次 run 不再有 persona 行，其它值不变', async () => {
    await MIGRATION_0010.run?.(store.connection)
    expect(await kindOf('memory', 'm-persona')).toBe('user_portrait')
    expect(await kindOf('generation_log', 'g-persona')).toBe('persona')
  })
})

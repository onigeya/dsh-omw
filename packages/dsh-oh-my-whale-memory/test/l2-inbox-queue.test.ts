/**
 * L2 提升队列与队列泛化（Story 2.5 / U1）。
 *
 * U1 裁决走路线 A：新增 `l2_inbox` 表，把 queue.ts 泛化为「表名参数化的同一套状态机」，
 * **默认实例仍是 l1_inbox**（2.2 起的所有调用点与测试零改动——那由既有的 db-inbox-queue /
 * inbox-consumer 等文件继续覆盖）。
 *
 * 本文件钉住泛化本身的三件事：
 *  ① 两张表相互独立：写 l2 的行不进 l1、取 l1 的队头看不见 l2 的行；
 *  ② l2 复用同一套 lease/attempts/回收语义（不是「另一套实现」）；
 *  ③ 建表由唯一迁移点完成（openMemoryDatabase 后两张队列表都在）。
 *
 * 单库（beforeAll 一次 open）以守 LadybugDB 每进程约 15 实例的上限。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import {
  INBOX_MAX_RETRIES,
  INBOX_STATUS_FAILED,
  INBOX_STATUS_PENDING,
  INBOX_STATUS_PROCESSING,
  claimNextInboxItem,
  completeInboxItem,
  countInboxByStatus,
  enqueueInboxItem,
  l2InboxQueue,
} from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase
let seq = 0

const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))
const nextId = (tag: string): string => `l2-${tag}-${process.pid}-${seq++}`

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-l2-inbox-')),
    dim: 4,
    modelId: 'test-embed-model',
  })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function countRows(table: string): Promise<number> {
  const rows = await queryAll(store.connection, `MATCH (q:${table}) RETURN count(q) AS total`)
  return Number(rows[0]?.total ?? 0)
}

async function readL2(id: string): Promise<Record<string, unknown>> {
  const rows = await queryAll(
    store.connection,
    `MATCH (q:l2_inbox) WHERE q.id = '${id}' RETURN q.id AS id, q.status AS status, ` +
    'q.attempts AS attempts, q.lease_owner AS lease_owner, q.payload AS payload, q.kind AS kind, ' +
    'q.last_error AS last_error',
  )
  return rows[0] as Record<string, unknown>
}

async function drainL2(): Promise<void> {
  for (;;) {
    const item = await l2InboxQueue.claimNext(store.connection, { now: at(4_000) })
    if (!item) break
    await l2InboxQueue.complete(store.connection, item.id, { now: at(4_000) })
  }
}

describe('队列泛化与 l2_inbox（U1）', () => {
  it('唯一迁移点建出两张队列表，且相互独立', async () => {
    // ③：openMemoryDatabase 之后 l2_inbox 已存在（database.ts 的迁移点调用 ensureL2InboxTables）。
    expect(await countRows('l2_inbox')).toBe(0)

    const l2Id = nextId('iso')
    await l2InboxQueue.enqueue(store.connection, { payload: 'L2 提升任务', kind: 'l1-promotion', now: at(1) })
    // 上面一次入队用的是缺省 id，这里再钉一条显式 id 的条目做读回。
    await l2InboxQueue.writeItem(store.connection, { id: l2Id, payload: 'L2 任务二', kind: 'l1-promotion', now: at(2) })

    // ① l2 的行不进 l1：l1 队列的取件看不见它。
    expect(await l2InboxQueue.readStatus(store.connection, l2Id)).toBe(INBOX_STATUS_PENDING)
    expect(await claimNextInboxItem(store.connection, { now: at(3) })).toBeNull()

    const l2Item = await l2InboxQueue.claimNext(store.connection, { now: at(3) })
    expect(l2Item?.id).toBeDefined()
    expect(l2Item?.status).toBe(INBOX_STATUS_PROCESSING)
    expect(l2Item?.leaseOwner).not.toBeNull()
    await drainL2()
  })

  it('l2 复用同一套 lease / attempts / 死信语义', async () => {
    const id = nextId('fail')
    await l2InboxQueue.writeItem(store.connection, { id, payload: 'L2 失败条目', now: at(10) })
    const claimed = await l2InboxQueue.claimNext(store.connection, { now: at(11) })
    expect(claimed?.id).toBe(id)

    // 第 1..3 次失败回 pending（带退避截止），第 4 次进 failed —— 与 l1 同一口径。
    const first = await l2InboxQueue.fail(store.connection, id, { error: new Error('boom-1'), now: at(12) })
    expect(first).toEqual({ status: INBOX_STATUS_PENDING, attempts: 1 })
    let last = first
    for (let round = 2; round <= INBOX_MAX_RETRIES + 1; round += 1) {
      // 退避截止已写进 lease_until：把时钟推后越过它才能再次取到。
      const again = await l2InboxQueue.claimNext(store.connection, { now: at(12 + round * 200) })
      expect(again?.id).toBe(id)
      last = await l2InboxQueue.fail(store.connection, id, { error: new Error('boom-' + round), now: at(13 + round * 200) })
      if (round <= INBOX_MAX_RETRIES) expect(last.status).toBe(INBOX_STATUS_PENDING)
    }
    expect(last.status).toBe(INBOX_STATUS_FAILED)
    expect(last.attempts).toBe(INBOX_MAX_RETRIES + 1)
    // 评审 P14⑤（T24）：此处原是空断言（投影不含该列 ⇒ String(undefined ?? '') 恒为 ''，
    // 与 ``toBeUndefined()`` 永不相交，永远不可能变红）。改为真的钉住末次失败原因。
    expect(String((await readL2(id)).last_error)).toContain('boom-' + String(INBOX_MAX_RETRIES + 1))
  })

  it('l2 的启动回收与按状态计数照常工作', async () => {
    const id = nextId('reclaim')
    await l2InboxQueue.writeItem(store.connection, { id, payload: 'L2 崩溃条目', now: at(20) })
    await l2InboxQueue.claimNext(store.connection, { now: at(21) })
    // 仍在 processing（模拟进程崩溃留下的行）⇒ 启动回收把它记成一次失败并回 pending。
    const reclaimed = await l2InboxQueue.reclaimProcessing(store.connection, { now: at(22) })
    expect(reclaimed).toBeGreaterThanOrEqual(1)
    const row = await readL2(id)
    expect(row.status).toBe(INBOX_STATUS_PENDING)
    expect(Number(row.attempts)).toBe(1)

    const counts = await l2InboxQueue.countByStatus(store.connection)
    expect(counts.pending).toBeGreaterThanOrEqual(1)
    // l1 的计数不受 l2 影响（两张表各算各的）。
    const l1Counts = await countInboxByStatus(store.connection)
    expect(l1Counts.done).toBe(0)
  })
})

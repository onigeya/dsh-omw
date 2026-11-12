/**
 * INBOX 队列的 at-most-once / 退避 / 崩溃循环契约测试（Story 2.3 / R1、R3①、R3②）。
 *
 * - R1：已处理标记 = status='done'，markInboxItemDone 带 processing 守卫 ⇒ at-most-once；
 * - ③ 对已 done 条目记失败是 no-op（N8：不把已完成的条目打回 pending/failed）；
 * - ⑤ 退避窗口：失败回 pending 后写 lease_until = now + backoff(attempts)，窗口内不可再取；
 * - ⑥ 第 4 次失败进 failed 且永不再被取；
 * - ⑨ 崩溃循环：启动回收把这次崩溃记成一次失败，达上限进死信（U11）。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-inbox-queue.test.ts。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import {
  INBOX_BACKOFF_BASE_MS,
  INBOX_MAX_RETRIES,
  INBOX_RECLAIM_ERROR,
  INBOX_STATUS_DONE,
  INBOX_STATUS_FAILED,
  INBOX_STATUS_PENDING,
  claimNextInboxItem,
  completeInboxItem,
  enqueueInboxItem,
  failInboxItem,
  inboxBackoffMs,
  markInboxItemDone,
  reclaimProcessingInboxItems,
} from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

/** 固定时间轴（秒偏移），与 db-inbox-queue.test.ts 同源。 */
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

let store: MemoryDatabase
let seq = 0
const nextId = (tag: string): string => 'q-amo-' + tag + '-' + process.pid + '-' + seq++

beforeAll(async () => {
  const dir = await makeTempDir('omw-inbox-amo-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function readRow(id: string): Promise<Record<string, unknown>> {
  const rows = await queryAll(
    store.connection,
    "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' RETURN q.status AS status, q.attempts AS attempts, " +
    'q.lease_owner AS lease_owner, q.lease_until AS lease_until, q.last_error AS last_error',
  )
  return rows[0] ?? {}
}

/** 清掉遗留 pending（done/failed 不可再取）：用例共用一个库，避免互相抢队头。 */
async function drainPending(): Promise<void> {
  const far = new Date(Date.UTC(2026, 11, 1))
  for (;;) {
    const item = await claimNextInboxItem(store.connection, { owner: 'drain', now: far })
    if (!item) return
    await completeInboxItem(store.connection, item.id, { now: far })
  }
}

beforeEach(drainPending)

async function enqueue(tag: string, seconds: number): Promise<string> {
  const id = nextId(tag)
  await enqueueInboxItem(store.connection, { id, payload: 'P', kind: 'work_fact', sessionId: 'sess', now: at(seconds) })
  return id
}

describe('R1：已处理标记 = done + processing 守卫（at-most-once）', () => {
  it('markInboxItemDone 只对 processing 命中一次；对 pending 不命中', async () => {
    const id = await enqueue('mark', 0)
    // 未取件（pending）→ 不命中，不偷偷改成 done。
    expect(await markInboxItemDone(store.connection, id, { now: at(1) })).toBe(false)
    expect((await readRow(id)).status).toBe(INBOX_STATUS_PENDING)

    await claimNextInboxItem(store.connection, { now: at(2) })
    expect(await markInboxItemDone(store.connection, id, { now: at(3) })).toBe(true)
    // 第二次必不命中（条件转换 processing→done 只成功一次）。
    expect(await markInboxItemDone(store.connection, id, { now: at(4) })).toBe(false)
    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_DONE)
    expect(row.lease_owner).toBeNull()
    expect(row.lease_until).toBeNull()
  })

  it('completeInboxItem 对 pending 条目返回 false 且不改状态', async () => {
    const id = await enqueue('complete-guard', 10)
    expect(await completeInboxItem(store.connection, id, { now: at(11) })).toBe(false)
    expect((await readRow(id)).status).toBe(INBOX_STATUS_PENDING)
  })
})

describe('③ N8：对非 processing 条目记失败是 no-op', () => {
  it('已 done 条目：failInboxItem 原样返回，不写库、不抛错', async () => {
    const id = await enqueue('done-noop', 20)
    await claimNextInboxItem(store.connection, { now: at(21) })
    await completeInboxItem(store.connection, id, { now: at(22) })

    const result = await failInboxItem(store.connection, id, { error: new Error('不应该写'), now: at(23) })

    expect(result).toEqual({ status: INBOX_STATUS_DONE, attempts: 0 })
    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_DONE)
    expect(Number(row.attempts)).toBe(0)
    expect(row.last_error).toBeNull()
  })

  it('pending 条目（未取件）：同样 no-op', async () => {
    const id = await enqueue('pending-noop', 30)
    const result = await failInboxItem(store.connection, id, { error: new Error('不应该写'), now: at(31) })
    expect(result).toEqual({ status: INBOX_STATUS_PENDING, attempts: 0 })
    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_PENDING)
    expect(Number(row.attempts)).toBe(0)
    expect(row.last_error).toBeNull()
  })
})

describe('⑤ R3①：失败后的退避窗口', () => {
  it('窗口内取不到，窗口过后可再取；FIFO 不被退避条目挡住', async () => {
    const backoffId = await enqueue('backoff', 40)
    const laterId = await enqueue('backoff-later', 41)
    await claimNextInboxItem(store.connection, { now: at(42) })
    const failed = await failInboxItem(store.connection, backoffId, { error: new Error('瞬时失败'), now: at(42) })
    expect(failed).toEqual({ status: INBOX_STATUS_PENDING, attempts: 1 })

    const row = await readRow(backoffId)
    expect(row.lease_until).toBe(new Date(at(42).getTime() + inboxBackoffMs(1)).toISOString())
    expect(inboxBackoffMs(1)).toBe(INBOX_BACKOFF_BASE_MS)

    // 窗口内的 now：退避条目不可取，但后面的条目照常取（FIFO 只跳过未到期者）。
    const headInWindow = await claimNextInboxItem(store.connection, { now: at(43) })
    expect(headInWindow?.id).toBe(laterId)

    // 窗口过后（lease_until <= now）可再取。
    const now = new Date(at(42).getTime() + inboxBackoffMs(1))
    await completeInboxItem(store.connection, laterId, { now })
    expect((await claimNextInboxItem(store.connection, { now }))?.id).toBe(backoffId)
    // 收尾：别把 processing 留给后面的用例（⑨ 会断言回收条数）。
    await completeInboxItem(store.connection, backoffId, { now })
  })

  it('退避按 5s/10s/20s 增长，封顶 120s', () => {
    expect(inboxBackoffMs(1)).toBe(5_000)
    expect(inboxBackoffMs(2)).toBe(10_000)
    expect(inboxBackoffMs(3)).toBe(20_000)
    expect(inboxBackoffMs(10)).toBe(120_000)
  })
})

describe('⑥ 第 4 次失败进死信', () => {
  it('attempts 累加到 4 即 failed，且此后永不被取', async () => {
    const id = await enqueue('dead', 50)
    let stamp = at(50)
    for (let attempt = 1; attempt <= INBOX_MAX_RETRIES; attempt += 1) {
      stamp = new Date(stamp.getTime() + 30_000)
      expect((await claimNextInboxItem(store.connection, { now: stamp }))?.id).toBe(id)
      const result = await failInboxItem(store.connection, id, { error: new Error('第 ' + attempt + ' 次'), now: stamp })
      expect(result).toEqual({ status: INBOX_STATUS_PENDING, attempts: attempt })
    }
    stamp = new Date(stamp.getTime() + 30_000)
    expect((await claimNextInboxItem(store.connection, { now: stamp }))?.id).toBe(id)
    expect(await failInboxItem(store.connection, id, { error: new Error('第 4 次'), now: stamp }))
      .toEqual({ status: INBOX_STATUS_FAILED, attempts: 4 })

    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_FAILED)
    expect(row.lease_until).toBeNull()
    expect(await claimNextInboxItem(store.connection, { now: new Date(stamp.getTime() + 86_400_000) })).toBeNull()
  })

  it('fatal（语义错/截断）首次即进死信，不等 attempts 累加', async () => {
    const id = await enqueue('fatal', 70)
    await claimNextInboxItem(store.connection, { now: at(71) })
    const result = await failInboxItem(store.connection, id, { error: new Error('4xx'), now: at(71), fatal: true })
    expect(result).toEqual({ status: INBOX_STATUS_FAILED, attempts: 1 })
    expect((await readRow(id)).status).toBe(INBOX_STATUS_FAILED)
  })
})

describe('⑨ R3②：崩溃循环最终进死信（U11）', () => {
  it('启动回收把每次崩溃记成一次失败，达上限后进 failed', async () => {
    const id = await enqueue('crash', 80)

    for (let crash = 1; crash <= INBOX_MAX_RETRIES; crash += 1) {
      expect((await claimNextInboxItem(store.connection, { now: at(80 + crash) }))?.id).toBe(id)
      expect(await reclaimProcessingInboxItems(store.connection, { now: at(80 + crash) })).toBe(1)
      const row = await readRow(id)
      expect(row.status).toBe(INBOX_STATUS_PENDING)
      expect(Number(row.attempts)).toBe(crash)
      expect(row.last_error).toBe(INBOX_RECLAIM_ERROR)
      expect(row.lease_until).toBeNull()
    }

    // 第 4 次崩溃：attempts+1 = 4 > INBOX_MAX_RETRIES ⇒ 直接进死信。
    expect((await claimNextInboxItem(store.connection, { now: at(90) }))?.id).toBe(id)
    expect(await reclaimProcessingInboxItems(store.connection, { now: at(90) })).toBe(1)
    const dead = await readRow(id)
    expect(dead.status).toBe(INBOX_STATUS_FAILED)
    expect(Number(dead.attempts)).toBe(INBOX_MAX_RETRIES + 1)

    // 死信不再被取，队列不会因此空转。
    expect(await claimNextInboxItem(store.connection, { now: at(100) })).toBeNull()
  })
})

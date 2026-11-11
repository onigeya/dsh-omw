/**
 * INBOX 队列与 lease 状态机真库测试（Story 2.2 / AC1-AC4）。
 *
 * 覆盖 spec intent-contract 的 I/O & Edge-Case Matrix：取队头（FIFO + lease 三列）、队空、lease 内完成、
 * 过期/未过期 lease、失败 1..3 回 pending、失败 >3 进死信、按状态计数、最近死信 5 条 + 24h stale。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-upsert.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import {
  INBOX_FAILED_STALE_MS,
  INBOX_FAILED_VIEW_LIMIT,
  INBOX_LAST_ERROR_MAX_CHARS,
  INBOX_LEASE_MS,
  INBOX_STATUS_DONE,
  INBOX_STATUS_FAILED,
  INBOX_STATUS_PENDING,
  INBOX_STATUS_PROCESSING,
  claimNextInboxItem,
  completeInboxItem,
  countInboxByStatus,
  enqueueInboxItem,
  failInboxItem,
  inboxErrorText,
  listRecentFailedInboxItems,
  reclaimExpiredLeases,
  reclaimProcessingInboxItems,
} from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let store: MemoryDatabase
let seq = 0

/** 固定时间轴（UTC ISO-8601，秒偏移）：lease 的 now/lease_until 必须可断言。 */
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))
/** 夹具时间基准：比测试用时间大得多，用于清空遗留 pending（不干扰断言）。 */
const DRAIN_AT = 5_000
const nextId = (tag: string): string => `inbox-${tag}-${process.pid}-${seq++}`

beforeAll(async () => {
  dir = await makeTempDir('omw-inbox-queue-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

async function readRow(id: string): Promise<Record<string, unknown>> {
  const rows = await queryAll(
    store.connection,
    `MATCH (q:l1_inbox) WHERE q.id = '${id}' RETURN q.id AS id, q.status AS status, q.attempts AS attempts, ` +
    'q.lease_owner AS lease_owner, q.lease_until AS lease_until, q.last_error AS last_error, ' +
    'q.enqueued_at AS enqueued_at, q.updated_at AS updated_at, ' +
    'q.payload AS payload, q.kind AS kind, q.session_id AS session_id',
  )
  return rows[0] as Record<string, unknown>
}

/**
 * 清空遗留条目：先把过期 lease 回收成 pending（否则上一个用例刻意留下的 processing 行
 * 会被 AC3 的回收条数断言一起数进去），再把所有 pending 取完标记 done。
 */
async function drainPending(): Promise<void> {
  await reclaimExpiredLeases(store.connection, { now: at(DRAIN_AT) })
  for (;;) {
    const item = await claimNextInboxItem(store.connection, { now: at(DRAIN_AT) })
    if (!item) break
    await completeInboxItem(store.connection, item.id, { now: at(DRAIN_AT) })
  }
}

describe('AC1：取队头（FIFO）与 lease 原子写入', () => {
  it('取到最早入队那条，并写入 processing + lease_owner(进程 id) + lease_until=now+60s', async () => {
    await drainPending()
    const a = nextId('a')
    const b = nextId('b')
    await enqueueInboxItem(store.connection, { id: a, payload: 'A', sessionId: 's1', kind: 'episodic', now: at(1) })
    await enqueueInboxItem(store.connection, { id: b, payload: 'B', sessionId: 's1', kind: 'episodic', now: at(2) })

    const claimed = await claimNextInboxItem(store.connection, { now: at(3) })

    expect(claimed?.id).toBe(a)
    expect(claimed?.status).toBe(INBOX_STATUS_PROCESSING)
    expect(claimed?.leaseOwner).toBe(String(process.pid))
    expect(claimed?.leaseUntil).toBe(new Date(at(3).getTime() + INBOX_LEASE_MS).toISOString())
    const row = await readRow(a)
    expect(row.status).toBe(INBOX_STATUS_PROCESSING)
    expect(row.lease_owner).toBe(String(process.pid))
    expect(row.lease_until).toBe(new Date(at(3).getTime() + INBOX_LEASE_MS).toISOString())
    // FIFO：第二条还没轮到。
    expect((await readRow(b)).status).toBe(INBOX_STATUS_PENDING)
  })

  it('连续取队头按入队序推进（FIFO），全部完成', async () => {
    await drainPending()
    await enqueueInboxItem(store.connection, { id: nextId('f1'), payload: '1', now: at(10) })
    await enqueueInboxItem(store.connection, { id: nextId('f2'), payload: '2', now: at(11) })
    await enqueueInboxItem(store.connection, { id: nextId('f3'), payload: '3', now: at(12) })
    const order: string[] = []
    for (;;) {
      const item = await claimNextInboxItem(store.connection, { now: at(20) })
      if (!item) break
      order.push(item.payload)
      await completeInboxItem(store.connection, item.id, { now: at(20) })
    }
    expect(order).toEqual(['1', '2', '3'])
  })
})

describe('队空：返回 null 且不写库', () => {
  it('全新空库取队头 → null，四状态计数全 0', async () => {
    const emptyDir = await makeTempDir('omw-inbox-empty-')
    const empty = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(emptyDir), dim: 4, modelId: 'test-embed-model' })
    const item = await claimNextInboxItem(empty.connection, { now: at(30) })
    expect(item).toBeNull()
    expect(await countInboxByStatus(empty.connection)).toEqual({
      [INBOX_STATUS_PENDING]: 0,
      [INBOX_STATUS_PROCESSING]: 0,
      [INBOX_STATUS_DONE]: 0,
      [INBOX_STATUS_FAILED]: 0,
    })
  }, 30_000)
})

describe('AC2：lease 内完成', () => {
  it('标 done 且 lease 清空', async () => {
    await drainPending()
    const id = nextId('done')
    await enqueueInboxItem(store.connection, { id, payload: 'D', now: at(40) })
    await claimNextInboxItem(store.connection, { now: at(41) })

    expect(await completeInboxItem(store.connection, id, { now: at(42) })).toBe(true)

    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_DONE)
    expect(row.lease_owner).toBeNull()
    expect(row.lease_until).toBeNull()
  })

  it('完成不存在的条目返回 false（不静默成功）', async () => {
    expect(await completeInboxItem(store.connection, 'no-such-inbox-id', { now: at(43) })).toBe(false)
  })
})

describe('AC3：lease 回收', () => {
  it('过期 lease 回收 → pending + lease 清空 + attempts 保留', async () => {
    await drainPending()
    const id = nextId('reclaim')
    await enqueueInboxItem(store.connection, { id, payload: 'R', now: at(50) })
    await claimNextInboxItem(store.connection, { now: at(51) })
    // 先制造一次失败，让 attempts=1，验证回收不动 attempts。
    await failInboxItem(store.connection, id, { error: new Error('第一次失败'), now: at(52) })
    await claimNextInboxItem(store.connection, { now: at(53) })
    const leaseUntil = new Date(at(53).getTime() + INBOX_LEASE_MS).toISOString()

    // lease 未过期不回收（活着的持有者不被抢）。
    expect(await reclaimExpiredLeases(store.connection, { now: at(60) })).toBe(0)
    expect((await readRow(id)).status).toBe(INBOX_STATUS_PROCESSING)

    const reclaimedAt = new Date(Date.parse(leaseUntil) + 1_000)
    expect(await reclaimExpiredLeases(store.connection, { now: reclaimedAt })).toBe(1)

    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_PENDING)
    expect(row.lease_owner).toBeNull()
    expect(row.lease_until).toBeNull()
    expect(Number(row.attempts)).toBe(1)
    await completeInboxItem(store.connection, id, { now: at(70) })
  })
})

describe('AC4：失败重试与死信', () => {
  it('失败 1..3 次回 pending（attempts 累加），第 4 次进 failed 并记 last_error', async () => {
    await drainPending()
    const id = nextId('fail')
    await enqueueInboxItem(store.connection, { id, payload: 'F', now: at(80) })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimNextInboxItem(store.connection, { now: at(80 + attempt) })
      expect(claimed?.id).toBe(id)
      const result = await failInboxItem(store.connection, id, {
        error: new Error(`精炼失败 ${attempt}`),
        now: at(80 + attempt),
      })
      expect(result).toEqual({ status: INBOX_STATUS_PENDING, attempts: attempt })
    }
    expect((await readRow(id)).status).toBe(INBOX_STATUS_PENDING)

    await claimNextInboxItem(store.connection, { now: at(84) })
    const dead = await failInboxItem(store.connection, id, { error: new Error('第四次失败'), now: at(84) })

    expect(dead).toEqual({ status: INBOX_STATUS_FAILED, attempts: 4 })
    const row = await readRow(id)
    expect(row.status).toBe(INBOX_STATUS_FAILED)
    expect(String(row.last_error)).toContain('第四次失败')
    // 死信不再被取（不阻塞后续条目）。
    expect(await claimNextInboxItem(store.connection, { now: at(85) })).toBeNull()
    const later = nextId('after-dead')
    await enqueueInboxItem(store.connection, { id: later, payload: 'L', now: at(86) })
    expect((await claimNextInboxItem(store.connection, { now: at(87) }))?.id).toBe(later)
  })

  it('记失败时条目不存在 → 抛错（不静默）', async () => {
    await expect(failInboxItem(store.connection, 'no-such-inbox-id', { error: new Error('x') }))
      .rejects.toThrow(/不存在/)
  })
})

describe('状态计数与最近死信视图', () => {
  it('countInboxByStatus 按状态给出四类计数', async () => {
    await drainPending()
    const before = await countInboxByStatus(store.connection)
    const pending = nextId('c-pending')
    const processing = nextId('c-processing')
    const done = nextId('c-done')
    await enqueueInboxItem(store.connection, { id: pending, payload: 'p', now: at(100) })
    await enqueueInboxItem(store.connection, { id: processing, payload: 'q', now: at(101) })
    await enqueueInboxItem(store.connection, { id: done, payload: 'r', now: at(102) })
    await claimNextInboxItem(store.connection, { now: at(103) })
    await claimNextInboxItem(store.connection, { now: at(103) })
    await completeInboxItem(store.connection, processing, { now: at(104) })

    const after = await countInboxByStatus(store.connection)
    expect(after[INBOX_STATUS_PENDING] - before[INBOX_STATUS_PENDING]).toBe(1)
    expect(after[INBOX_STATUS_PROCESSING] - before[INBOX_STATUS_PROCESSING]).toBe(1)
    expect(after[INBOX_STATUS_DONE] - before[INBOX_STATUS_DONE]).toBe(1)
    expect(after[INBOX_STATUS_FAILED] - before[INBOX_STATUS_FAILED]).toBe(0)
  })

  it('最近死信：最多 5 条、updated_at 倒序、超 24h 标 stale', async () => {
    await drainPending()
    const ids: string[] = []
    for (let i = 0; i < INBOX_FAILED_VIEW_LIMIT + 1; i += 1) {
      const id = nextId(`dead-${i}`)
      ids.push(id)
      await enqueueInboxItem(store.connection, { id, payload: `dead ${i}`, kind: 'work_fact', now: at(200 + i) })
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await claimNextInboxItem(store.connection, { now: at(300 + i) })
        await failInboxItem(store.connection, id, { error: new Error(`dead ${i}`), now: at(300 + i) })
      }
    }
    const fresh = await listRecentFailedInboxItems(store.connection, { now: at(400) })
    expect(fresh).toHaveLength(INBOX_FAILED_VIEW_LIMIT)
    expect(fresh.map((entry) => entry.id)).toEqual(ids.slice(1).reverse())
    expect(fresh.every((entry) => entry.stale === false)).toBe(true)
    expect(fresh[0].kind).toBe('work_fact')
    expect(fresh[0].attempts).toBe(4)
    expect(fresh[0].lastError).toContain('dead')

    const later = new Date(at(400).getTime() + INBOX_FAILED_STALE_MS + 60_000)
    const stale = await listRecentFailedInboxItems(store.connection, { now: later })
    expect(stale.every((entry) => entry.stale === true)).toBe(true)
  }, 60_000)
})

/**
 * 评审补丁 P9 的补充面（Story 2.2）：
 * - CLAIM_HEAD_AFTER 的同毫秒并列分支（此前全仓无一处传 after 游标）；
 * - last_error 截断（INBOX_LAST_ERROR_MAX_CHARS）与非 Error 值；
 * - enqueueInboxItem 同 id 幂等（MERGE ON CREATE，不覆盖既有行）；
 * - processing 条目不再被取出（同一轮不重复精炼同一条）；
 * - P7 写者启动回收**全部** processing（lease 未过期也回收）与 reclaimExpiredLeases 的语义差。
 */
describe('P9-②：CLAIM_HEAD_AFTER 的同毫秒并列分支', () => {
  it('同一毫秒入队三条 → 游标严格按 id 推进，抵达队尾返回 null', async () => {
    await drainPending()
    const a = nextId('tie-a')
    const b = nextId('tie-b')
    const c = nextId('tie-c')
    const stamp = at(600)
    await enqueueInboxItem(store.connection, { id: a, payload: 'A', now: stamp })
    await enqueueInboxItem(store.connection, { id: b, payload: 'B', now: stamp })
    await enqueueInboxItem(store.connection, { id: c, payload: 'C', now: stamp })
    // 断言前提：三条 enqueued_at 逐字相同，顺序只能由 id 决定。
    expect((await readRow(a)).enqueued_at).toBe((await readRow(b)).enqueued_at)
    expect((await readRow(b)).enqueued_at).toBe((await readRow(c)).enqueued_at)

    const first = await claimNextInboxItem(store.connection, { now: at(601) })
    expect(first?.id).toBe(a)
    const second = await claimNextInboxItem(store.connection, {
      now: at(601),
      after: { enqueuedAt: first!.enqueuedAt, id: first!.id },
    })
    expect(second?.id).toBe(b)
    const third = await claimNextInboxItem(store.connection, {
      now: at(601),
      after: { enqueuedAt: second!.enqueuedAt, id: second!.id },
    })
    expect(third?.id).toBe(c)
    expect(await claimNextInboxItem(store.connection, {
      now: at(601),
      after: { enqueuedAt: third!.enqueuedAt, id: third!.id },
    })).toBeNull()

    for (const id of [a, b, c]) await completeInboxItem(store.connection, id, { now: at(602) })
  })
})

describe('P9-④：last_error 的截断与非 Error 值', () => {
  it('inboxErrorText：Error 取 message、非 Error 走 String()、超长截到 INBOX_LAST_ERROR_MAX_CHARS', () => {
    expect(inboxErrorText(new Error('boom'))).toBe('boom')
    expect(inboxErrorText('plain')).toBe('plain')
    expect(inboxErrorText(null)).toBe('null')
    expect(inboxErrorText({ nope: 1 })).toBe('[object Object]')
    const long = 'y'.repeat(INBOX_LAST_ERROR_MAX_CHARS + 120)
    expect(inboxErrorText(long)).toBe(long.slice(0, INBOX_LAST_ERROR_MAX_CHARS))
    expect(inboxErrorText(long)).toHaveLength(INBOX_LAST_ERROR_MAX_CHARS)
  })

  it('failInboxItem 落库同样截断；非 Error 值照原样 String() 后记录', async () => {
    await drainPending()
    const longId = nextId('long-error')
    await enqueueInboxItem(store.connection, { id: longId, payload: 'L', now: at(700) })
    await claimNextInboxItem(store.connection, { now: at(701) })
    await failInboxItem(store.connection, longId, { error: new Error('y'.repeat(900)), now: at(702) })
    expect(String((await readRow(longId)).last_error)).toHaveLength(INBOX_LAST_ERROR_MAX_CHARS)

    const objId = nextId('obj-error')
    await enqueueInboxItem(store.connection, { id: objId, payload: 'O', now: at(703) })
    await claimNextInboxItem(store.connection, { now: at(704) })
    await failInboxItem(store.connection, objId, { error: { code: 500 }, now: at(705) })
    expect((await readRow(objId)).last_error).toBe('[object Object]')

    await completeInboxItem(store.connection, objId, { now: at(706) })
  })
})

describe('P9-⑤：enqueueInboxItem 同 id 幂等', () => {
  it('二次入队不覆盖 payload/kind/session_id/attempts/enqueued_at，且该 id 只有一行', async () => {
    await drainPending()
    const id = nextId('dup')
    await enqueueInboxItem(store.connection, {
      id, payload: '第一次', kind: 'work_fact', sessionId: 's1', now: at(800),
    })
    await enqueueInboxItem(store.connection, {
      id, payload: '第二次', kind: 'persona', sessionId: 's2', now: at(801),
    })

    const row = await readRow(id)
    expect(row.payload).toBe('第一次')
    expect(row.kind).toBe('work_fact')
    expect(row.session_id).toBe('s1')
    expect(row.enqueued_at).toBe(at(800).toISOString())
    expect(Number(row.attempts)).toBe(0)
    expect(row.status).toBe(INBOX_STATUS_PENDING)

    const rows = await queryAll(
      store.connection,
      'MATCH (q:l1_inbox) WHERE q.id = \'' + id + '\' RETURN q.id AS id',
    )
    expect(rows).toHaveLength(1)
  })
})

describe('P9-⑥：processing 条目不会被再次取出', () => {
  it('两条都 processing 后再取为 null；指向队首之前的游标也不会把 processing 行捞回', async () => {
    await drainPending()
    const first = nextId('busy-1')
    const second = nextId('busy-2')
    await enqueueInboxItem(store.connection, { id: first, payload: '1', now: at(850) })
    await enqueueInboxItem(store.connection, { id: second, payload: '2', now: at(851) })

    expect((await claimNextInboxItem(store.connection, { now: at(852) }))?.id).toBe(first)
    expect((await claimNextInboxItem(store.connection, { now: at(853) }))?.id).toBe(second)
    // 两条都在 processing：队头查询不再返回任何条目（同一轮不重复精炼同一条）。
    expect(await claimNextInboxItem(store.connection, { now: at(854) })).toBeNull()
    // 游标刻意指到队首之前：status = pending 的过滤必须优先于游标范围。
    expect(await claimNextInboxItem(store.connection, {
      now: at(855),
      after: { enqueuedAt: at(0).toISOString(), id: 'zzz' },
    })).toBeNull()

    await completeInboxItem(store.connection, first, { now: at(856) })
    await completeInboxItem(store.connection, second, { now: at(857) })
  })
})

describe('P7：写者启动回收全部 processing（AC3 超集，U7）', () => {
  it('lease 未过期也回收：reclaimExpiredLeases=0 而 reclaimProcessingInboxItems=2，attempts 保留', async () => {
    await drainPending()
    const expired = nextId('reclaim-all-e')
    const fresh = nextId('reclaim-all-f')
    await enqueueInboxItem(store.connection, { id: expired, payload: 'E', now: at(900) })
    await enqueueInboxItem(store.connection, { id: fresh, payload: 'F', now: at(901) })

    // expired：先失败一次（attempts=1）再取一次 → processing。
    await claimNextInboxItem(store.connection, { now: at(901) })
    await failInboxItem(store.connection, expired, { error: new Error('第一次失败'), now: at(902) })
    await claimNextInboxItem(store.connection, { now: at(903) })
    // fresh：lease 刻意放到 10 倍 —— 「只回收过期」的原语必须放过它。
    await claimNextInboxItem(store.connection, { now: at(903), leaseMs: 10 * INBOX_LEASE_MS })
    expect((await readRow(expired)).status).toBe(INBOX_STATUS_PROCESSING)
    expect((await readRow(fresh)).status).toBe(INBOX_STATUS_PROCESSING)

    expect(await reclaimExpiredLeases(store.connection, { now: at(904) })).toBe(0)
    expect(await reclaimProcessingInboxItems(store.connection, { now: at(904) })).toBe(2)

    const expiredRow = await readRow(expired)
    expect(expiredRow.status).toBe(INBOX_STATUS_PENDING)
    expect(expiredRow.lease_owner).toBeNull()
    expect(expiredRow.lease_until).toBeNull()
    expect(Number(expiredRow.attempts)).toBe(1)
    const freshRow = await readRow(fresh)
    expect(freshRow.status).toBe(INBOX_STATUS_PENDING)
    expect(freshRow.lease_owner).toBeNull()
    expect(Number(freshRow.attempts)).toBe(0)
  })
})

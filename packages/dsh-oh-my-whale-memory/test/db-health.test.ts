/**
 * 健康指标采集（Story 4.3 / T1；矩阵行 1–10 的 db 侧）。
 *
 * 为什么在 db 层测：`collectHealthMetrics` 的正确性全压在三态判定上（无积压 / 表缺失 /
 * 采集失败 / 超预算），其中「表缺失」「读失败」「超预算」在完整 status 路径上不可构造
 *（`countInboxByStatus` 先抛），只能直接打采集函数。完整命令路径由 `status-health.test.ts`
 * 覆盖，渲染由 `command-status.test.ts` 覆盖。
 *
 * 开库次数：本文件共 5 次（空库 / 双队列 / 零与回拨 / done 时刻 / 缺表），LadybugDB 每进程
 * 约 15 个库封顶。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { collectHealthMetrics, HEALTH_BUDGET_MS } from '../src/db/health'
import { resolveMemoryDbPath } from '../src/db/paths'
import { l1InboxQueue, l2InboxQueue } from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
/** 时间基准：所有 enqueued_at / updated_at 都以它加减，注入时钟即可精确断言。 */
const BASE = Date.parse('2026-11-01T00:00:00.000Z')
const at = (offsetMs: number): Date => new Date(BASE + offsetMs)
const iso = (offsetMs: number): string => at(offsetMs).toISOString()

let store: MemoryDatabase

async function openDb(prefix: string): Promise<MemoryDatabase> {
  return openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir(prefix)),
    dim: DIM,
    modelId: 'test-embed',
  })
}

/** 稳定时钟：先返回基准时刻，之后每次调用推进 `stepMs`（构造「首项之后已超预算」）。 */
function steppingClock(first: number, next: number): () => number {
  const values = [first, next]
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('矩阵行 1：空库、从未运行', () => {
  it('两队列都空 ⇒ 无积压；无 done 条目 ⇒ 从未完成精炼（都不是 0）', async () => {
    store = await openDb('omw-health-empty-')
    const health = await collectHealthMetrics({ connection: store.connection, now: () => BASE })
    expect(health.inboxBacklog).toEqual({ status: 'none' })
    expect(health.lastRefineAt).toEqual({ status: 'none' })
  })
})

describe('矩阵行 2/3：积压时长取两队列较大者', () => {
  it('L1 90s + L2 30s ⇒ 各自毫秒数（L2 无积压时为 null），行 2 的单队列形态也成立', async () => {
    // L1 一条 pending（enqueued_at = BASE），L2 一条 pending（BASE+60s），now = BASE+90s。
    await l1InboxQueue.enqueue(store.connection, { id: 'h-l1', payload: '{"text":"积压 L1"}', now: at(0) })
    const healthL1Only = await collectHealthMetrics({ connection: store.connection, now: () => BASE + 90_000 })
    expect(healthL1Only.inboxBacklog).toEqual({ status: 'ok', value: { l1Ms: 90_000, l2Ms: null } })

    await l2InboxQueue.enqueue(store.connection, { id: 'h-l2', payload: '{"l1Ids":["x"]}', now: at(60_000) })
    const healthBoth = await collectHealthMetrics({ connection: store.connection, now: () => BASE + 90_000 })
    expect(healthBoth.inboxBacklog).toEqual({ status: 'ok', value: { l1Ms: 90_000, l2Ms: 30_000 } })
  })
})

describe('矩阵行 4/5：0 秒不是 n/a；时钟回拨夹紧为 0', () => {
  it('刚入队 ⇒ 0 毫秒（有积压）；enqueued_at 在 now 之后 ⇒ 夹紧 0，不出现负值', async () => {
    const zeroDb = await openDb('omw-health-zero-')
    try {
      await l1InboxQueue.enqueue(zeroDb.connection, { id: 'h-zero', payload: '刚入队', now: at(0) })
      const fresh = await collectHealthMetrics({ connection: zeroDb.connection, now: () => BASE })
      expect(fresh.inboxBacklog).toEqual({ status: 'ok', value: { l1Ms: 0, l2Ms: null } })

      // 时钟回拨：条目时间晚于注入 now 5s。
      await zeroDb.connection.query("MATCH (q:l1_inbox {id: 'h-zero'}) SET q.enqueued_at = '" + iso(5_000) + "'")
      const skewed = await collectHealthMetrics({ connection: zeroDb.connection, now: () => BASE })
      expect(skewed.inboxBacklog).toEqual({ status: 'ok', value: { l1Ms: 0, l2Ms: null } })
    } finally {
      await zeroDb.close()
    }
  })
})

describe('矩阵行 6/7：最近精炼完成时刻', () => {
  it('无 done ⇒ none；两条 done 取较大 updated_at 并逐字回显', async () => {
    const doneDb = await openDb('omw-health-done-')
    try {
      await l1InboxQueue.enqueue(doneDb.connection, { id: 'h-d1', payload: '一', now: at(0) })
      await l1InboxQueue.enqueue(doneDb.connection, { id: 'h-d2', payload: '二', now: at(1_000) })

      // 行 7：只有 pending（没有 done）时不得报时刻。
      const before = await collectHealthMetrics({ connection: doneDb.connection, now: () => BASE + 10_000 })
      expect(before.lastRefineAt).toEqual({ status: 'none' })

      // 行 6：两条先后完成，updated_at 不同，取较大者（逐字回显库内值）。
      const first = await l1InboxQueue.claimNext(doneDb.connection, { owner: 'test', now: at(2_000) })
      expect(first?.id).toBe('h-d1')
      await l1InboxQueue.complete(doneDb.connection, 'h-d1', { now: at(3_000) })
      const second = await l1InboxQueue.claimNext(doneDb.connection, { owner: 'test', now: at(4_000) })
      expect(second?.id).toBe('h-d2')
      await l1InboxQueue.complete(doneDb.connection, 'h-d2', { now: at(5_000) })

      const after = await collectHealthMetrics({ connection: doneDb.connection, now: () => BASE + 10_000 })
      expect(after.lastRefineAt).toEqual({ status: 'ok', value: iso(5_000) })
      // done 条目不再算积压（BACKLOG_STATUSES 只覆盖 pending|processing）。
      expect(after.inboxBacklog).toEqual({ status: 'none' })
    } finally {
      await doneDb.close()
    }
  })
})

describe('矩阵行 8：队列表缺失 ⇒ 两项都是 n/a（表缺失），不是 0', () => {
  it('DROP l1_inbox 后：两项 missing-table，采集不抛', async () => {
    const missingDb = await openDb('omw-health-missing-')
    try {
      await missingDb.connection.query('DROP TABLE l1_inbox')
      const health = await collectHealthMetrics({ connection: missingDb.connection, now: () => BASE })
      expect(health.inboxBacklog).toEqual({ status: 'missing-table' })
      expect(health.lastRefineAt).toEqual({ status: 'missing-table' })
    } finally {
      await missingDb.close()
    }
  })
})

describe('矩阵行 9：读失败只降级自己那一项', () => {
  it('l2_inbox 查询抛错 ⇒ 积压 failed，last_refine_at 照常出值', async () => {
    const connection = store.connection
    const original = connection.prepare.bind(connection)
    const prepare = vi.spyOn(connection, 'prepare')
    prepare.mockImplementation(async (statement: string) => {
      if (statement.includes('l2_inbox')) throw new Error('模拟 l2_inbox 读失败')
      return original(statement)
    })
    try {
      const health = await collectHealthMetrics({ connection, now: () => BASE + 90_000 })
      expect(health.inboxBacklog).toEqual({ status: 'failed' })
      // 失败是逐项独立的：另一项照常采到（本夹具此时还没有 done 条目 ⇒ none）。
      expect(health.lastRefineAt).toEqual({ status: 'none' })
    } finally {
      prepare.mockRestore()
    }
  })

  it('enqueued_at 是非法时刻 ⇒ 按采集失败处理，不抛、也不当 0', async () => {
    const badDb = await openDb('omw-health-badtime-')
    try {
      await l1InboxQueue.enqueue(badDb.connection, { id: 'h-bad', payload: '脏时间', now: at(0) })
      await badDb.connection.query("MATCH (q:l1_inbox {id: 'h-bad'}) SET q.enqueued_at = 'not-a-time'")
      const health = await collectHealthMetrics({ connection: badDb.connection, now: () => BASE + 90_000 })
      expect(health.inboxBacklog).toEqual({ status: 'failed' })
    } finally {
      await badDb.close()
    }
  })
})

describe('矩阵行 10：10s 观测预算', () => {
  it('首项之后耗时 10_001ms ⇒ 首项正常出值、其余 budget（不真等 10s）', async () => {
    const health = await collectHealthMetrics({
      connection: store.connection,
      now: steppingClock(BASE + 90_000, BASE + 90_000 + HEALTH_BUDGET_MS + 1),
    })
    expect(health.inboxBacklog).toEqual({ status: 'ok', value: { l1Ms: 90_000, l2Ms: 30_000 } })
    expect(health.lastRefineAt).toEqual({ status: 'budget' })
  })

  it('耗时恰为预算整不超限（> 而非 >=）⇒ 不短路', async () => {
    const health = await collectHealthMetrics({
      connection: store.connection,
      now: steppingClock(BASE + 90_000, BASE + 90_000 + HEALTH_BUDGET_MS),
    })
    expect(health.lastRefineAt).toEqual({ status: 'none' })
  })
})

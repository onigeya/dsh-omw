/**
 * 后台 FIFO 消费者测试（Story 2.2 / AC2、AC4、AC5、AC6）。
 *
 * 真库（dim=4）+ 受控时钟。用 claim/complete 清队保证用例间互不影响（Failed/Done 条目
 * 不可再取，不影响下一轮的 runOnce 计数）。
 * - AC2：lease 内完成 → done，随后继续取下一队头（FIFO 不回头）；process 回调里断言
 *   条目此刻已是 processing 且 lease_owner 是本消费者；
 * - AC4：单条失败不阻塞后续条目（同一轮里 good 照常 done）；连续失败超 3 轮进 failed
 *   死信，之后新条目照常消费；
 * - AC5：空闲闸门（turn 窗口内不取队头，多会话按活跃 turn 计数）+ start/stop 生命周期
 *   + 在飞后台 promise 挂在模块级 Set（INBOX_BACKGROUND_TASKS）；
 * - AC6：成功消费驱动提升触发信号（阈值注入 2，避免真堆 20 条）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { createIdleGate } from '../src/inbox/idle-gate'
import { createPromotionTracker, type PromotionTrigger } from '../src/inbox/promotion-trigger'
import { INBOX_BACKGROUND_TASKS, createInboxConsumer, type InboxConsumer } from '../src/inbox/consumer'
import { claimNextInboxItem, completeInboxItem, enqueueInboxItem } from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'test-embed-model'
const OWNER = 'test-owner'
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

let dir: string
let store: MemoryDatabase
let seq = 0
const nextId = (tag: string): string => `consume-${tag}-${process.pid}-${seq++}`

beforeAll(async () => {
  dir = await makeTempDir('omw-inbox-consume-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

/** 清掉遗留 pending 条目（Done/Failed 不可再取，无需清）。 */
async function drainPending(): Promise<void> {
  for (;;) {
    const item = await claimNextInboxItem(store.connection, { owner: 'drain', now: at(9000) })
    if (!item) return
    await completeInboxItem(store.connection, item.id, { now: at(9000) })
  }
}

afterEach(drainPending)

interface RowView {
  status: string
  attempts: number
  leaseOwner: string | null
}

async function readRow(id: string): Promise<RowView | undefined> {
  const rows = await queryAll(
    store.connection,
    `MATCH (q:l1_inbox) WHERE q.id = '${id}' RETURN q.status AS status, q.attempts AS attempts, q.lease_owner AS lease_owner`,
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    status: String(row.status),
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
  }
}

function makeConsumer(options: {
  gate?: ReturnType<typeof createIdleGate>
  process?: (item: { id: string; sessionId: string; kind: string; payload: string }) => Promise<void>
  promotion?: ReturnType<typeof createPromotionTracker>
  intervalMs?: number
  logger?: { warn(message: string): void }
} = {}): InboxConsumer {
  return createInboxConsumer({
    connection: () => store.connection,
    gate: options.gate ?? createIdleGate(),
    owner: OWNER,
    now: () => at(500),
    intervalMs: options.intervalMs ?? 5,
    process: options.process,
    promotion: options.promotion,
    logger: options.logger,
  })
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时')
    await new Promise((wake) => setTimeout(wake, 5))
  }
}

describe('AC5：空闲闸门与「无处理器不消费」', () => {
  it('没有精炼处理器时不取队头（不丢条目、不误标 done）', async () => {
    const id = nextId('no-process')
    await enqueueInboxItem(store.connection, { payload: '待精炼草稿', kind: 'episodic', now: at(1), id })
    const consumer = makeConsumer()
    expect(await consumer.runOnce()).toBe(0)
    expect(await readRow(id)).toMatchObject({ status: 'pending', attempts: 0, leaseOwner: null })
    consumer.stop()
  })

  it('turn 窗口内不取队头，turn 结束（exitTurn）后才取', async () => {
    const id = nextId('gate')
    await enqueueInboxItem(store.connection, { payload: '闸门夹具', now: at(2), id })
    const gate = createIdleGate()
    const consumer = makeConsumer({ gate, process: async () => undefined })

    gate.enterTurn('session-1')
    expect(gate.isIdle()).toBe(false)
    expect(await consumer.runOnce()).toBe(0)
    expect((await readRow(id))!.status).toBe('pending')

    gate.exitTurn('session-1')
    expect(gate.isIdle()).toBe(true)
    expect(await consumer.runOnce()).toBe(1)
    expect((await readRow(id))!.status).toBe('done')
    consumer.stop()
  })

  it('多会话按活跃 turn 计数：任一 turn 未结束就仍挡着', async () => {
    const id = nextId('multi-session')
    await enqueueInboxItem(store.connection, { payload: '多会话夹具', now: at(3), id })
    const gate = createIdleGate()
    const consumer = makeConsumer({ gate, process: async () => undefined })

    gate.enterTurn('session-a')
    gate.enterTurn('session-b')
    gate.exitTurn('session-a')
    expect(gate.depthFor('session-b')).toBe(1)
    expect(await consumer.runOnce()).toBe(0)
    expect((await readRow(id))!.status).toBe('pending')

    gate.exitTurn('session-b')
    expect(await consumer.runOnce()).toBe(1)
    expect((await readRow(id))!.status).toBe('done')
    consumer.stop()
  })
})

describe('AC2：lease 内完成 → done，继续取下一队头（FIFO）', () => {
  it('两条按入队序处理；process 回调里已是 processing + 本消费者持 lease', async () => {
    const first = nextId('fifo-first')
    const second = nextId('fifo-second')
    await enqueueInboxItem(store.connection, { payload: '第一条', now: at(10), id: first })
    await enqueueInboxItem(store.connection, { payload: '第二条', now: at(11), id: second })

    const seen: string[] = []
    const consumer = makeConsumer({
      process: async (item) => {
        const row = await readRow(item.id)
        seen.push(`${item.id}:${row?.status}:${row?.leaseOwner}`)
        // lease 未过期（now=at(500) 固定，lease_until=at(560)）
        const leaseRows = await queryAll(store.connection, `MATCH (q:l1_inbox) WHERE q.id = '${item.id}' RETURN q.lease_until AS lease_until`)
        seen.push('lease_until=' + String(leaseRows[0]?.lease_until))
      },
    })

    expect(await consumer.runOnce()).toBe(2)
    expect(seen).toEqual([
      `${first}:processing:${OWNER}`,
      'lease_until=2026-11-11T00:09:20.000Z',
      `${second}:processing:${OWNER}`,
      'lease_until=2026-11-11T00:09:20.000Z',
    ])
    expect(await readRow(first)).toMatchObject({ status: 'done', leaseOwner: null })
    expect(await readRow(second)).toMatchObject({ status: 'done', leaseOwner: null })
    consumer.stop()
  })
})

describe('AC4：失败不阻塞后续；超 3 轮进死信', () => {
  it('同一轮里 bad 失败回 pending、good 照常 done', async () => {
    const bad = nextId('bad')
    const good = nextId('good')
    await enqueueInboxItem(store.connection, { payload: '会炸的', kind: 'work_fact', now: at(20), id: bad })
    await enqueueInboxItem(store.connection, { payload: '正常的', kind: 'persona', now: at(21), id: good })

    const warning = vi.fn()
    const consumer = makeConsumer({
      logger: { warn: warning },
      process: async (item) => {
        if (item.id === bad) throw new Error('精炼炸了')
      },
    })

    expect(await consumer.runOnce()).toBe(1)
    expect(await readRow(bad)).toMatchObject({ status: 'pending', attempts: 1, leaseOwner: null })
    expect(await readRow(good)).toMatchObject({ status: 'done', attempts: 0 })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('精炼炸了'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('attempts=1'))
    consumer.stop()
  })

  it('连续 4 轮失败 → failed 死信；死信不阻塞后续新条目', async () => {
    const dead = nextId('dead')
    await enqueueInboxItem(store.connection, { payload: '必死', kind: 'work_fact', now: at(22), id: dead })

    const warning = vi.fn()
    const consumer = makeConsumer({
      logger: { warn: warning },
      process: async (item) => {
        if (item.id === dead) throw new Error('第四次失败')
      },
    })

    for (let round = 0; round < 4; round += 1) expect(await consumer.runOnce()).toBe(0)
    expect(await readRow(dead)).toMatchObject({ status: 'failed', attempts: 4, leaseOwner: null })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('第四次失败'))

    const later = nextId('later')
    await enqueueInboxItem(store.connection, { payload: '死信之后的新条目', kind: 'instruction', now: at(30), id: later })
    expect(await consumer.runOnce()).toBe(1)
    expect(await readRow(later)).toMatchObject({ status: 'done' })
    expect(await readRow(dead)).toMatchObject({ status: 'failed', attempts: 4 })
    consumer.stop()
  })
})

describe('AC6：成功消费驱动提升触发信号（L2 提升本体属 Story 2.5）', () => {
  it('精炼落库计数跨过阈值时回调一次', async () => {
    const first = nextId('promote-1')
    const second = nextId('promote-2')
    await enqueueInboxItem(store.connection, { payload: '提升一', kind: 'episodic', sessionId: 'sess', now: at(40), id: first })
    await enqueueInboxItem(store.connection, { payload: '提升二', kind: 'episodic', sessionId: 'sess', now: at(41), id: second })

    const triggers: PromotionTrigger[] = []
    const promotion = createPromotionTracker({ onTrigger: (trigger) => triggers.push(trigger), l1Threshold: 2 })
    const consumer = makeConsumer({ promotion, process: async () => undefined })

    expect(await consumer.runOnce()).toBe(2)
    expect(promotion.totalL1).toBe(2)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({
      reason: 'l1-total',
      totalL1: 2,
      sessionId: 'sess',
      kind: 'episodic',
      sessionKindCount: 0,
    })
    consumer.stop()
  })
})

describe('AC5：start/stop 生命周期与后台任务强引用', () => {
  it('start 后台不停消费、stop 后不再取队头；在飞 promise 挂在模块级 Set 上', async () => {
    const id = nextId('lifecycle')
    await enqueueInboxItem(store.connection, { payload: '生命周期夹具', now: at(50), id })

    const seen: string[] = []
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const consumer = makeConsumer({
      process: async (item) => {
        seen.push(item.id)
        await blocked
      },
    })

    const before = INBOX_BACKGROUND_TASKS.size
    consumer.start()
    expect(consumer.isRunning()).toBe(true)

    await waitUntil(() => seen.length === 1)
    expect(INBOX_BACKGROUND_TASKS.size).toBeGreaterThan(before)

    release()
    consumer.stop()
    expect(consumer.isRunning()).toBe(false)
    await waitUntil(() => INBOX_BACKGROUND_TASKS.size === before)
    expect((await readRow(id))!.status).toBe('done')

    const afterStop = nextId('after-stop')
    await enqueueInboxItem(store.connection, { payload: '停机后不该被消费', now: at(60), id: afterStop })
    await new Promise((wake) => setTimeout(wake, 40))
    expect(seen).toHaveLength(1)
    expect((await readRow(afterStop))!.status).toBe('pending')
  })
})

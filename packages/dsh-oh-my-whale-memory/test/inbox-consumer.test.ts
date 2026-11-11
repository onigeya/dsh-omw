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
import {
  INBOX_BACKGROUND_TASKS,
  createInboxConsumer,
  drainInboxBackgroundTasks,
  type InboxConsumer,
} from '../src/inbox/consumer'
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
  /** 连接替身（默认真库连接）：只用于模拟「记账（complete）失败」这一条路径。 */
  connection?: () => MemoryDatabase['connection']
} = {}): InboxConsumer {
  return createInboxConsumer({
    connection: options.connection ?? (() => store.connection),
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

/** 用**真正的** setTimeout 轮询：P4 用例把全局 setTimeout 换成假定时器后 waitUntil 会挂死。 */
async function waitWithRealTimers(
  realSetTimeout: typeof setTimeout,
  check: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitWithRealTimers 超时')
    await new Promise((wake) => realSetTimeout(wake as () => void, 5))
  }
}

/**
 * 连接替身（P1/P2 用）：只改写「标 done」那条语句（COMPLETE 是唯一含 $done 的语句）的结果，
 * 用来模拟 completeInboxItem 落空（返回 false）或抛错；BEGIN/COMMIT/ROLLBACK 与其余读写一律透传真连接。
 */
function shimConnection(
  real: MemoryDatabase['connection'],
  behavior: (id: string) => 'ok' | 'empty' | 'throw',
): MemoryDatabase['connection'] {
  return {
    query: (statement: string) => real.query(statement),
    prepare: async (statement: string) => ({ statement, inner: await real.prepare(statement) }),
    execute: async (prepared: unknown, params: Record<string, unknown>) => {
      const handle = prepared as { statement: string; inner: never }
      if (handle.statement.includes('$done')) {
        const mode = behavior(String(params.id ?? ''))
        if (mode === 'throw') throw new Error('标 done 落库炸了')
        if (mode === 'empty') {
          // 真实的空结果集：语句合法但 MATCH 不到行 → completeInboxItem 返回 false（不静默成功）。
          const miss = await real.prepare(
            "MATCH (q:l1_inbox) WHERE q.id = 'shim-missing-id' RETURN q.id AS id",
          )
          return real.execute(miss, {})
        }
      }
      return real.execute(handle.inner, params as never)
    },
  } as unknown as MemoryDatabase['connection']
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

describe('P3：stop() 后在飞条目结算完即退出（不中断、不再开新轮）', () => {
  it('第一条卡住时 stop：第一条 done、第二条仍 pending；drain 后模块级 Set 清空', async () => {
    const first = nextId('stop-mid-1')
    const second = nextId('stop-mid-2')
    await enqueueInboxItem(store.connection, { payload: '第一条', now: at(80), id: first })
    await enqueueInboxItem(store.connection, { payload: '第二条', now: at(81), id: second })

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
    await waitUntil(() => seen.length === 1)

    // 第一条还在飞（process 卡住）时停机：在飞条目必须结算完，第二条不得被取出。
    consumer.stop()
    release()

    await waitUntil(() => INBOX_BACKGROUND_TASKS.size === before)
    await drainInboxBackgroundTasks()
    expect(INBOX_BACKGROUND_TASKS.size).toBe(0)

    expect(seen).toEqual([first])
    expect(await readRow(first)).toMatchObject({ status: 'done' })
    expect(await readRow(second)).toMatchObject({ status: 'pending', attempts: 0, leaseOwner: null })
  })
})

describe('P1：completeInboxItem 未落库 → 不计成功、不记提升信号、不改队列状态', () => {
  it('落空（返回 false）时 warn 带 id，条目仍是 processing（不写回 pending/failed）', async () => {
    const id = nextId('complete-miss')
    await enqueueInboxItem(store.connection, {
      payload: '完成落空', kind: 'episodic', sessionId: 'sess-account', now: at(70), id,
    })
    const warning = vi.fn()
    const triggers: PromotionTrigger[] = []
    const promotion = createPromotionTracker({
      onTrigger: (trigger) => triggers.push(trigger),
      l1Threshold: 1,
    })
    const shim = shimConnection(store.connection, () => 'empty')
    const consumer = makeConsumer({
      logger: { warn: warning },
      promotion,
      process: async () => undefined,
      connection: () => shim,
    })

    expect(await consumer.runOnce()).toBe(0)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('完成未落库'))
    expect(warning.mock.calls.flat().join('\n')).toContain(id)
    // 队列状态没被改写：仍 processing、lease 未清、attempts 未 +1（没走 failInboxItem）。
    expect(await readRow(id)).toMatchObject({ status: 'processing', attempts: 0, leaseOwner: OWNER })
    expect(promotion.totalL1).toBe(0)
    expect(triggers).toHaveLength(0)

    // 清理：用真连接补一次完成（替身会让它永远停在 processing）。
    await completeInboxItem(store.connection, id, { now: at(71) })
    consumer.stop()
  })

  it('promotion.recordL1 抛错 → 条目照常 done，只 warn（旁路记账失败不入死信）', async () => {
    const id = nextId('account-throw')
    await enqueueInboxItem(store.connection, {
      payload: '记账抛错', kind: 'persona', sessionId: 'sess-account', now: at(72), id,
    })
    const warning = vi.fn()
    const promotion = createPromotionTracker({
      onTrigger: () => {
        throw new Error('记账炸了')
      },
      l1Threshold: 1,
    })
    const consumer = makeConsumer({ logger: { warn: warning }, promotion, process: async () => undefined })

    expect(await consumer.runOnce()).toBe(1)
    expect(await readRow(id)).toMatchObject({ status: 'done', attempts: 0, leaseOwner: null })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('提升记账失败'))
    expect(warning.mock.calls.flat().join('\n')).toContain('记账炸了')
    consumer.stop()
  })

  it('completeInboxItem 抛错 → 该条仍 processing，且不冲垮本轮后续条目', async () => {
    const bad = nextId('complete-throw')
    const good = nextId('complete-throw-next')
    await enqueueInboxItem(store.connection, { payload: '完成抛错', now: at(73), id: bad })
    await enqueueInboxItem(store.connection, { payload: '后续条目', now: at(74), id: good })
    const warning = vi.fn()
    const shim = shimConnection(store.connection, (id) => (id === bad ? 'throw' : 'ok'))
    const consumer = makeConsumer({
      logger: { warn: warning },
      process: async () => undefined,
      connection: () => shim,
    })

    expect(await consumer.runOnce()).toBe(1)
    expect(warning.mock.calls.flat().join('\n')).toContain('完成落库异常')
    expect(warning.mock.calls.flat().join('\n')).toContain(bad)
    expect(await readRow(bad)).toMatchObject({ status: 'processing', attempts: 0 })
    expect(await readRow(good)).toMatchObject({ status: 'done' })

    await completeInboxItem(store.connection, bad, { now: at(75) })
    consumer.stop()
  })
})

describe('P4：arm() 先清既有定时器（同时只有一个待触发轮询）', () => {
  it('在飞轮次期间 stop()+start()：续期清掉 start() 排下的定时器，不出现两条轮询链', async () => {
    const realSetTimeout = globalThis.setTimeout
    const timeouts: Array<{ id: number; fn: () => void }> = []
    const cleared: number[] = []
    let nextHandle = 1
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      const id = nextHandle++
      timeouts.push({ id, fn })
      return { id, unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: { id?: number } | null) => {
      if (handle && typeof handle.id === 'number') cleared.push(handle.id)
    }) as unknown as typeof clearTimeout)

    try {
      const id = nextId('arm-guard')
      await enqueueInboxItem(store.connection, { payload: '定时器夹具', now: at(90), id })
      const seen: string[] = []
      let release: () => void = () => undefined
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const consumer = makeConsumer({
        intervalMs: 7,
        process: async (item) => {
          seen.push(item.id)
          await blocked
        },
      })

      consumer.start()
      const firstHandle = timeouts[timeouts.length - 1].id
      timeouts[timeouts.length - 1].fn() // 触发首轮：timer 已置 null，runOnce 卡在 process
      await waitWithRealTimers(realSetTimeout, () => seen.length === 1)

      consumer.stop()
      consumer.start()
      const secondHandle = timeouts[timeouts.length - 1].id
      expect(secondHandle).not.toBe(firstHandle)

      release()
      await waitWithRealTimers(realSetTimeout, () => timeouts.length >= 3)
      const resumedHandle = timeouts[timeouts.length - 1].id
      // 续期前必须清掉 start() 排下的那个定时器，否则会多出第二条轮询链。
      expect(cleared).toContain(secondHandle)
      expect(resumedHandle).not.toBe(secondHandle)

      consumer.stop()
      expect(cleared).toContain(resumedHandle)
    } finally {
      timeoutSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

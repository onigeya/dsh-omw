/**
 * 慢路径队列（Story 7.2 第 2 轮 / AD-6、AD-20、Q-4）。
 *
 * 覆盖 spec「慢路径」矩阵：入队/租约/完成、有界重试 3 次、退避与 jitter 边界、整窗重扫 ≤2 轮、
 * 达上限后抛 `slow_task_window_exhausted`（调用方转运行级短路）、队列可观测性统计。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import {
  SLOW_PATH_BACKOFF_INITIAL_MS,
  SLOW_PATH_BACKOFF_MAX_MS,
  SLOW_PATH_MAX_ATTEMPTS,
  SLOW_PATH_MAX_WINDOW_ROUNDS,
  backoffDelayMs,
  completeSlowTask,
  enqueueSlowTask,
  failSlowTask,
  leaseNextSlowTask,
  readSlowTask,
  rescanSlowTaskWindow,
  slowQueueStats,
} from '../src/strategy/slow-queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'
const WINDOW = '2026-06-01T00:00'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-slow-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('慢路径队列：基本生命周期', () => {
  it('入队 ⇒ 租约取到（状态 processing）⇒ complete 置 done', async () => {
    await enqueueSlowTask(store.connection, {
      id: 'slow-1',
      kind: 'reflection',
      payload: '窗口 A',
      createdAt: T0,
    })
    expect((await readSlowTask(store.connection, 'slow-1'))?.state).toBe('pending')

    const leased = await leaseNextSlowTask(store.connection, {
      owner: 'owner-1',
      leaseUntil: '2026-06-01T00:01:00.000Z',
      nowIso: T0,
    })
    expect(leased?.id).toBe('slow-1')
    expect(leased?.state).toBe('processing')

    await completeSlowTask(store.connection, 'slow-1', T0)
    expect((await readSlowTask(store.connection, 'slow-1'))?.state).toBe('done')
  })

  it('空队列 ⇒ 租约为 null（不是错误）', async () => {
    const leased = await leaseNextSlowTask(store.connection, {
      owner: 'owner-1',
      leaseUntil: '2026-06-01T00:01:00.000Z',
      nowIso: T0,
    })
    expect(leased).toBeNull()
  })
})

describe('有界重试集（Q-4：单任务 3 次）', () => {
  it('前两次失败 ⇒ 回 pending 且给 nextAttemptAt；第三次 ⇒ failed 且无下次', async () => {
    await enqueueSlowTask(store.connection, {
      id: 'slow-retry',
      kind: 'reflection',
      payload: '重试样本',
      createdAt: WINDOW,
    })
    const first = await failSlowTask(store.connection, {
      id: 'slow-retry',
      error: 'boom-1',
      nowIso: T0,
      random: () => 0.5,
    })
    expect(first.state).toBe('pending')
    expect(first.attempts).toBe(1)
    expect(first.nextAttemptAt).toBe(new Date(Date.parse(T0) + SLOW_PATH_BACKOFF_INITIAL_MS).toISOString())

    const second = await failSlowTask(store.connection, {
      id: 'slow-retry',
      error: 'boom-2',
      nowIso: T0,
      random: () => 0.5,
    })
    expect(second.attempts).toBe(2)
    expect(second.nextAttemptAt).toBe(new Date(Date.parse(T0) + SLOW_PATH_BACKOFF_INITIAL_MS * 2).toISOString())

    const third = await failSlowTask(store.connection, {
      id: 'slow-retry',
      error: 'boom-3',
      nowIso: T0,
      random: () => 0.5,
    })
    expect(third.state).toBe('failed')
    expect(third.attempts).toBe(SLOW_PATH_MAX_ATTEMPTS)
    expect(third.nextAttemptAt).toBeNull()
    expect((await readSlowTask(store.connection, 'slow-retry'))?.lastError).toBe('boom-3')
  })

  it('退避：jitter 双侧 ±20%、上限 120s、attempts ≤ 0 走初始值', () => {
    expect(backoffDelayMs(1, () => 0.5)).toBe(SLOW_PATH_BACKOFF_INITIAL_MS)
    expect(backoffDelayMs(1, () => 0)).toBe(Math.round(SLOW_PATH_BACKOFF_INITIAL_MS * 0.8))
    expect(backoffDelayMs(1, () => 1)).toBe(Math.round(SLOW_PATH_BACKOFF_INITIAL_MS * 1.2))
    expect(backoffDelayMs(10, () => 0.5)).toBe(SLOW_PATH_BACKOFF_MAX_MS)
    expect(backoffDelayMs(0, () => 0.5)).toBe(SLOW_PATH_BACKOFF_INITIAL_MS)
  })

  it('不存在的 id ⇒ slow_task_not_found', async () => {
    await expect(failSlowTask(store.connection, { id: 'nope', error: 'x', nowIso: T0 }))
      .rejects.toMatchObject({ code: 'slow_task_not_found' })
  })
})

describe('撤章整窗重扫（Q-4：≤2 轮）', () => {
  it('第一轮：failed 行全部退回 pending、attempts 清零、window_round +1', async () => {
    const result = await rescanSlowTaskWindow(store.connection, { windowPrefix: WINDOW, nowIso: T0 })
    expect(result.requeued).toBeGreaterThan(0)
    expect(result.windowRound).toBe(1)
    const task = await readSlowTask(store.connection, 'slow-retry')
    expect(task?.state).toBe('pending')
    expect(task?.attempts).toBe(0)
    expect(task?.windowRound).toBe(1)
  })

  it('第二轮仍可重扫；第三轮达上限 ⇒ slow_task_window_exhausted', async () => {
    // 再造一次失败，使该窗有 failed 行
    await failSlowTask(store.connection, { id: 'slow-retry', error: 'again', nowIso: T0, random: () => 0.5 })
    for (let attempt = 0; attempt < SLOW_PATH_MAX_ATTEMPTS - 1; attempt += 1) {
      await failSlowTask(store.connection, { id: 'slow-retry', error: 'again', nowIso: T0, random: () => 0.5 })
    }
    const second = await rescanSlowTaskWindow(store.connection, { windowPrefix: WINDOW, nowIso: T0 })
    expect(second.windowRound).toBe(2)

    // 再失败三轮 → 又成 failed；此时第三轮重扫应被拒
    for (let attempt = 0; attempt < SLOW_PATH_MAX_ATTEMPTS; attempt += 1) {
      await failSlowTask(store.connection, { id: 'slow-retry', error: 'again', nowIso: T0, random: () => 0.5 })
    }
    await expect(rescanSlowTaskWindow(store.connection, { windowPrefix: WINDOW, nowIso: T0 }))
      .rejects.toMatchObject({ code: 'slow_task_window_exhausted' })
    expect(SLOW_PATH_MAX_WINDOW_ROUNDS).toBe(2)
  })

  it('空窗 ⇒ 不报错、requeued=0', async () => {
    const result = await rescanSlowTaskWindow(store.connection, { windowPrefix: '1999-01-01', nowIso: T0 })
    expect(result).toEqual({ requeued: 0, windowRound: 0 })
  })
})

describe('队列可观测性（AC:1433-1435）', () => {
  it('统计 depth / retrySet / exhausted / windowRound', async () => {
    // 先放一条新的 pending：上一个用例结束时 slow-retry 已 failed（attempts=3），depth 应为 0。
    await enqueueSlowTask(store.connection, {
      id: 'slow-stats',
      kind: 'reflection',
      payload: '统计样本',
      createdAt: WINDOW,
    })
    const stats = await slowQueueStats(store.connection)
    expect(stats.depth).toBe(1)
    expect(stats.windowRound).toBe(2)
    // slow-retry 已达上限 ⇒ 计入 exhausted（死信候选），不进重试集
    expect(stats.exhausted).toBe(1)
    expect(stats.retrySet).toBe(0)
    expect(stats.shortCircuited).toBe(false)
  })
})

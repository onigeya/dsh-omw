/**
 * 后台 FIFO 消费者（Story 2.2 / AD-6、NFR7）。
 *
 * 运行纪律：
 * - 只在空闲闸门放开时取队头；turn 一开始（enterTurn）就停止取，本轮不再推进；
 * - **无精炼处理器时绝不取队头**：Story 2.3 才提供 ctx.llm 精炼，此刻取队会丢条目或
 *   把没精炼的条目误标 done（AC3「不丢条目」）。生产接线由 apply 启动/停止它；
 * - 单轮内用 FIFO 游标推进，一条失败回 pending 也不会在同一轮被重复取出，
 *   从而「失败不阻塞后续条目」（AC4）；
 * - 后台 promise 全部登记进模块级 Set<Promise> 持强引用防 GC（§14），完成后自我移除；
 * - 定时器在 stop() 里 clear，dispose 时由既有的 db effect disposer 调用（不新增 effect）。
 */
import type * as lbug from '@ladybugdb/core'
import {
  claimNextInboxItem,
  completeInboxItem,
  failInboxItem,
  inboxErrorText,
  type InboxItem,
} from './queue.js'
import type { IdleGate } from './idle-gate.js'
import type { PromotionTracker } from './promotion-trigger.js'

/** 模块级强引用：后台任务在结算前不会被 GC（§14）。 */
export const INBOX_BACKGROUND_TASKS = new Set<Promise<unknown>>()

/** 把后台 promise 登记进 Set，并在结算后自我移除（成功失败都要移除）。 */
export function trackInboxBackgroundTask<T>(promise: Promise<T>): Promise<T> {
  INBOX_BACKGROUND_TASKS.add(promise)
  const remove = (): void => {
    INBOX_BACKGROUND_TASKS.delete(promise)
  }
  void promise.then(remove, remove)
  return promise
}

export const INBOX_POLL_INTERVAL_MS = 1_000

export interface InboxConsumerOptions {
  /** 惰性取连接（apply 期间建库完成后才可用；未就绪 → 本轮不消费）。 */
  readonly connection: () => lbug.Connection | null
  readonly gate: IdleGate
  /** lease 持有者，缺省进程 id。 */
  readonly owner?: string
  readonly now?: () => Date
  readonly intervalMs?: number
  /**
   * 精炼处理器（Story 2.3 注入 ctx.llm 精炼 + L1 落库）。缺省 = 不消费。
   */
  readonly process?: (item: InboxItem) => Promise<void>
  readonly promotion?: PromotionTracker
  readonly logger?: { warn(message: string): void }
}

export interface InboxConsumer {
  /** 启动消费循环（幂等）。 */
  start(): void
  /** 停止并清掉待触发的定时器（幂等）。 */
  stop(): void
  isRunning(): boolean
  /** 跑一轮：返回本轮成功消费的条数（测试与诊断入口）。 */
  runOnce(): Promise<number>
}

export function createInboxConsumer(options: InboxConsumerOptions): InboxConsumer {
  const intervalMs = options.intervalMs ?? INBOX_POLL_INTERVAL_MS
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const runOnce = async (): Promise<number> => {
    const process = options.process
    if (!process) return 0
    if (!options.gate.isIdle()) return 0
    const connection = options.connection()
    if (!connection) return 0
    let processed = 0
    let after: { enqueuedAt: string; id: string } | undefined
    for (;;) {
      if (!options.gate.isIdle()) break
      const item = await claimNextInboxItem(connection, {
        owner: options.owner,
        now: options.now?.(),
        after,
      })
      if (!item) break
      after = { enqueuedAt: item.enqueuedAt, id: item.id }
      try {
        await process(item)
        await completeInboxItem(connection, item.id, { now: options.now?.() })
        options.promotion?.recordL1({ sessionId: item.sessionId, kind: item.kind })
        processed += 1
      } catch (error) {
        const result = await failInboxItem(connection, item.id, { error, now: options.now?.() })
        options.logger?.warn(
          'INBOX 条目精炼失败（id=' + item.id + '，attempts=' + result.attempts +
          '，status=' + result.status + '）：' + inboxErrorText(error),
        )
      }
    }
    return processed
  }

  const tick = (): void => {
    timer = null
    if (!running) return
    const task = trackInboxBackgroundTask(
      runOnce().catch((error: unknown) => {
        options.logger?.warn('INBOX 消费轮次异常：' + inboxErrorText(error))
        return 0
      }),
    )
    void task.then(() => {
      if (running) arm(intervalMs)
    })
  }

  const arm = (delayMs: number): void => {
    const handle = setTimeout(tick, delayMs)
    // 不因一个待触发的轮询把宿主进程钉在事件循环上。
    if (typeof handle.unref === 'function') handle.unref()
    timer = handle
  }

  return {
    start() {
      if (running) return
      running = true
      arm(0)
    },
    stop() {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    isRunning() {
      return running
    },
    runOnce,
  }
}

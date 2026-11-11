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
 *   dispose 时先用 drainInboxBackgroundTasks() 等在飞轮次结算，再关库；
 * - stop() 只保证不再**开**新一轮取队：已取出/正在精炼的条目照常结算完，不得中断在飞条目
 *   （AC3「不丢条目」）；定时器在 stop() 里 clear，dispose 由既有的 db effect disposer 调用
 *   （不新增 effect）。
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

/**
 * 等全部在飞后台任务结算（dispose 用）：stop() 只保证不再开新轮，不等待已开的轮次；
 * 关库前必须先把它们等干净，否则精炼/写库会落在已关闭的连接上。
 */
export async function drainInboxBackgroundTasks(): Promise<void> {
  await Promise.allSettled([...INBOX_BACKGROUND_TASKS])
}

export const INBOX_POLL_INTERVAL_MS = 1_000

/**
 * 精炼处理器的返回值（Story 2.3 / R1、R4①）。
 *
 * - `completed: true` = 处理器已在**自身事务内**把条目转成 done（`markInboxItemDone` 与产出同事务，
 *   at-most-once）；消费者据此**不再**重复 complete（第二次必不命中）。缺省 = 由消费者照旧收尾（2.2 行为）。
 * - `kinds` = 本次精炼产出的节点 kind 列表（不是采集来源标签 step|turn|compaction）；
 *   消费者按它逐条记提升信号（R4①）。缺省 = 沿用条目自身的 kind（2.2 兼容路径）。
 */
export interface InboxProcessResult {
  readonly completed?: boolean
  readonly kinds?: readonly string[]
}

/**
 * 精炼处理器抛出的失败（Story 2.3）：`fatal` 区分「瞬时（退避重试）」与
 * 「语义错（4xx / 输出截断，首次即降级、直接进死信，AC:581）」。消费者按结构读取 `fatal`。
 */
export class InboxRefineError extends Error {
  readonly reason: string
  readonly fatal: boolean

  constructor(message: string, options: { readonly reason: string; readonly fatal: boolean }) {
    super(message)
    this.name = 'InboxRefineError'
    this.reason = options.reason
    this.fatal = options.fatal
  }
}

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
   * 可返回 {@link InboxProcessResult} 声明「已在事务内标 done」与「精炼后的 kind」（R1 / R4①）。
   */
  readonly process?: (item: InboxItem) => Promise<InboxProcessResult | void>
  readonly promotion?: PromotionTracker
  readonly logger?: { warn(message: string): void }
}

export interface InboxConsumer {
  /** 启动消费循环（幂等）。 */
  start(): void
  /** 停止并清掉待触发的定时器（幂等）；在飞轮次会结算完当前条目后退出。 */
  stop(): void
  isRunning(): boolean
  /** 跑一轮：返回本轮成功消费的条数（测试与诊断入口）。 */
  runOnce(): Promise<number>
}

export function createInboxConsumer(options: InboxConsumerOptions): InboxConsumer {
  const intervalMs = options.intervalMs ?? INBOX_POLL_INTERVAL_MS
  let running = false
  // stop() 置位、start() 复位：runOnce 的循环据此在**当前条目结算完**后退出，不中断在飞条目。
  // 不能直接读 running——诊断/测试会不经 start() 直接调 runOnce（那时 running 一直是 false）。
  let stopRequested = false
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
      // stop() 后不再开新一轮取队；本条已取出/正在精炼的照常结算完（不丢条目）。
      if (stopRequested) break
      if (!options.gate.isIdle()) break
      const item = await claimNextInboxItem(connection, {
        owner: options.owner,
        now: options.now?.(),
        after,
      })
      if (!item) break
      after = { enqueuedAt: item.enqueuedAt, id: item.id }
      // 只有**精炼本身**失败才算这条失败：记账（complete / recordL1）失败不得把精炼成功的条目
      // 写回 pending/failed——那会重复精炼，attempts 已 3 时还会误送死信。
      let result: InboxProcessResult | void
      try {
        result = await process(item)
      } catch (error) {
        // AC:581：语义错首次即降级不重试 ⇒ 直接进死信；瞬时失败走退避。
        const fatal = error instanceof InboxRefineError && error.fatal
        const failed = await failInboxItem(connection, item.id, { error, now: options.now?.(), fatal })
        options.logger?.warn(
          'INBOX 条目精炼失败（id=' + item.id + '，attempts=' + failed.attempts +
          '，status=' + failed.status + '）：' + inboxErrorText(error),
        )
        continue
      }
      // R1：处理器若已在自身事务内标 done（与产出同事务），这里不能再 complete——
      // 第二次转换必不命中，会把成功路径误判成「未落库」。
      let completed = result?.completed === true
      if (!completed) {
        // completeInboxItem 返回 false = 未落库（其文档明写不静默 no-op）：不计成功、不记提升信号。
        try {
          completed = await completeInboxItem(connection, item.id, { now: options.now?.() })
        } catch (error) {
          options.logger?.warn('INBOX 条目完成落库异常（id=' + item.id + '）：' + inboxErrorText(error))
        }
        if (!completed) {
          options.logger?.warn('INBOX 条目完成未落库（id=' + item.id + '）：本轮不计成功、不记提升信号')
          continue
        }
      }
      processed += 1
      // 提升记账是旁路：记账失败不改队列状态（条目已 done），也不中断本轮。
      // R4①：有精炼结果时按**精炼后的节点 kind** 逐条记账；无（2.2 兼容路径）才退回条目 kind。
      try {
        const kinds = result?.kinds
        if (kinds === undefined) {
          options.promotion?.recordL1({ sessionId: item.sessionId, kind: item.kind })
        } else {
          for (const kind of kinds) options.promotion?.recordL1({ sessionId: item.sessionId, kind })
        }
      } catch (error) {
        options.logger?.warn('INBOX 提升记账失败（id=' + item.id + '）：' + inboxErrorText(error))
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
    // 先清掉既有待触发定时器：在飞轮次结算后的续期与 start() 可能各排一个，
    // 不清就会形成两条轮询链（定时器泄漏 + 并发消费）。
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const handle = setTimeout(tick, delayMs)
    // 不因一个待触发的轮询把宿主进程钉在事件循环上。
    if (typeof handle.unref === 'function') handle.unref()
    timer = handle
  }

  return {
    start() {
      if (running) return
      running = true
      stopRequested = false
      arm(0)
    },
    stop() {
      running = false
      stopRequested = true
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

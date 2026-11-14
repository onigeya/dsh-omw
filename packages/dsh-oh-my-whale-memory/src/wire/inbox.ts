/**
 * INBOX 后台消费域装配（Story 2.2 / 2.5 / 评审 P7、P12、P18a、P6/P6b）。
 *
 * 三段，均在 writer 路径：
 * 1) `createPromotionWiring`：L1→L2 提升的入队动作与触发器（onTrigger 是同步回调，
 *    入队 fire-and-forget，挂模块级 Set 持强引用，失败只告警不抛）；
 * 2) `reclaimInboxOnStartup`：启动回收**全部** processing → pending（L1 与 L2 同口径，
 *    AD-12 写者锁保证单写进程，故启动时看到的 processing 必属已死进程）；
 * 3) `startInboxConsumers`：L1 主路径 + L2 提升慢循环两条消费链，挂在既有 db effect
 *    的 disposer 上（不新增 ctx.effect，entry-exports 钉死 closer 数）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDatabase } from '../db/database.js'
import { runInTransaction } from '../db/transaction.js'
import {
  listEffectiveMemoryIdsByLayer,
  readL2PromotionCursor,
  writeL2PromotionCursor,
} from '../db/memory.js'
import { MEMORY_REMEMBER_LAYER } from '../tools/memory-remember.js'
import { createInboxConsumer, trackInboxBackgroundTask } from '../inbox/consumer.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import { createPromotionTracker, type PromotionTracker } from '../inbox/promotion-trigger.js'
import { l1InboxQueue, l2InboxQueue, reclaimProcessingInboxItems } from '../inbox/queue.js'
import {
  L2_INBOX_KIND,
  L2_PROMOTION_INTERVAL_MS,
  buildL2PromotionItemId,
  type L2PromotionPayload,
} from '../distill/promotion.js'
import type { InboxProcessor } from './distill.js'
import type { MemoryRuntimeSlots } from './runtime.js'

export interface PromotionWiringOptions {
  readonly ctx: Context
  readonly getDb: () => MemoryDatabase | undefined
}

/**
 * L1→L2 提升入队（Story 2.5 / U3、U10）。
 *
 * - 条目 id 是确定性内容键（{@link buildL2PromotionItemId}）：MERGE ON CREATE 只建一次、不覆盖
 *   既有行 ⇒ 同一 L1 不会重复入队、崩溃重放不产重条目，**v1 的「丢弃不重试」**由此成立。
 * - 已在队列里的（pending/processing/done/failed）直接跳过：done = 已有结论，failed = 已耗尽
 *   4 次机会。要重试只能改 L1 文本（换指纹）或调阈值重新标定。
 * - sessionId 取触发信号的会话：L2 条目的路由解析靠它（缺省回退到 Config 的显式路由）。
 *
 * 评审 P1（T1）：候选**按 `(recorded_at, id)` 升序游标分页**取（页大小 200），不再把触发阈值
 * 当 LIMIT —— 旧口径每轮只覆盖最新 20 条有效 L1，更早的永久不可达。游标存 omw_meta，
 * 页尾（本页不足一页）回绕到起点，与确定性条目 id + readStatus 跳过共同保证收敛。
 * 评审 P12（T18）：整批入队 + 游标推进在**同一个 runInTransaction** 里完成，且循环内只能用
 * `writeItem`（`enqueue` 自带事务，重入会抛）—— 避免裸语句与 L1 写链交错。
 */
export function createPromotionWiring(options: PromotionWiringOptions): PromotionTracker {
  const { ctx, getDb } = options
  const enqueuePromotion = async (trigger: { readonly reason: string; readonly sessionId: string }): Promise<number> => {
    const connection = getDb()?.connection
    if (!connection) return 0
    const after = await readL2PromotionCursor(connection)
    const page = await listEffectiveMemoryIdsByLayer(connection, MEMORY_REMEMBER_LAYER, { after })
    const enqueued = await runInTransaction(connection, async () => {
      let written = 0
      for (const l1Id of page.ids) {
        const id = buildL2PromotionItemId(l1Id)
        if (await l2InboxQueue.readStatus(connection, id) !== null) continue
        const payload: L2PromotionPayload = { l1Ids: [l1Id] }
        await l2InboxQueue.writeItem(connection, {
          id,
          sessionId: trigger.sessionId,
          kind: L2_INBOX_KIND,
          payload: JSON.stringify(payload),
        })
        written += 1
      }
      // 游标与入队同一事务：否则崩溃会让游标前进而条目未入队，那批候选永久不可达。
      await writeL2PromotionCursor(connection, page.nextCursor ?? '')
      return written
    })
    if (enqueued > 0) {
      ctx.logger.info(
        `L1→L2 提升入队：${enqueued} 条 L1 进 l2_inbox（原因 ${trigger.reason}）`,
      )
    }
    return enqueued
  }

  return createPromotionTracker({
    // AC:721「后台 FIFO 消费者」：触发信号在这里转成入队动作。onTrigger 是同步回调，
    // 故入队 fire-and-forget —— 挂模块级 Set 持强引用（§14），失败只告警不抛（信号不该拖垮采集）。
    onTrigger: (trigger) => {
      void trackInboxBackgroundTask(
        enqueuePromotion(trigger).catch((error: unknown) => {
          ctx.logger.warn(
            'L1→L2 提升入队失败：' + (error instanceof Error ? error.message : String(error)),
          )
          return 0
        }),
      )
    },
  })
}

/**
 * 启动回收用「全部 processing 回 pending」，而不是只回收过期 lease（U7）：AD-12 的写者锁保证
 * 同一库同一时刻只有一个写进程，故本进程刚启动时看到的任何 processing 行都属于已死进程。
 * 只回收过期条目会让「T 崩溃、T+20s 重启（lease 到 T+60）」的条目卡到**下一次**重启才自愈。
 */
export async function reclaimInboxOnStartup(options: PromotionWiringOptions): Promise<void> {
  const { ctx, getDb } = options
  const connection = getDb()?.connection
  if (!connection) return
  const reclaimed = await reclaimProcessingInboxItems(connection)
  if (reclaimed > 0) {
    ctx.logger.info(`INBOX 启动回收：${reclaimed} 条 processing 回 pending（单写者下必属已死进程）`)
  }
  // Story 2.5：L2 队列的启动回收与 L1 同口径（U7：单写者下 processing 必属已死进程）。
  const reclaimedL2 = await l2InboxQueue.reclaimProcessing(connection)
  if (reclaimedL2 > 0) {
    ctx.logger.info(`L2 INBOX 启动回收：${reclaimedL2} 条 processing 回 pending（单写者下必属已死进程）`)
  }
}

export interface InboxConsumerWiringOptions {
  readonly ctx: Context
  readonly getDb: () => MemoryDatabase | undefined
  readonly slots: MemoryRuntimeSlots
  readonly gate: IdleGate
  readonly promotion: PromotionTracker
  readonly l1Processor: InboxProcessor
  readonly l2Processor: InboxProcessor
  readonly maintenance: () => Promise<number>
}

/** 创建并启动两条消费链；句柄写回 slots，dispose 由 lifecycle 的 teardown 统一停。 */
export function startInboxConsumers(options: InboxConsumerWiringOptions): void {
  const { ctx, getDb, slots, gate, promotion } = options
  const getConnection = () => getDb()?.connection ?? null

  slots.inboxConsumer = createInboxConsumer({
    connection: getConnection,
    gate,
    promotion,
    process: options.l1Processor,
    maintenance: options.maintenance,
    logger: ctx.logger,
  })
  slots.inboxConsumer.start()

  // Story 2.5：L1→L2 提升的第二条消费链。
  // - 慢循环：intervalMs 调到 30s（AC:721），并用 claimGuard 给 L1 主路径让路（L1 待处理时本轮不取件）。
  slots.l2Consumer = createInboxConsumer({
    connection: getConnection,
    gate,
    intervalMs: L2_PROMOTION_INTERVAL_MS,
    queue: l2InboxQueue,
    process: options.l2Processor,
    // 让路规则（brief §5.4 + 评审 P6/P6b）：L1 队列还有**现在就该干**的活儿就让路。
    // - P6：不能只数 pending —— L1 正在精炼（processing）时同样不该起 L2；
    // - P6b：也不能把**退避中**的 pending 算成忙 —— 退避窗口最长 120s，
    //   那会让 L2 慢循环整段时间完全不取件（提升停顿）。
    // 连接为空（dispose 之后）⇒ 按忙处理并 warn，不再用 `db!` 抛异常被吞。
    claimGuard: async () => {
      const connection = getDb()?.connection
      if (!connection) {
        ctx.logger.warn('L2 提升让路闸门：数据库连接不可用（按忙处理）')
        return false
      }
      return (await l1InboxQueue.countBusy(connection)) === 0
    },
    logger: ctx.logger,
  })
  slots.l2Consumer.start()
}

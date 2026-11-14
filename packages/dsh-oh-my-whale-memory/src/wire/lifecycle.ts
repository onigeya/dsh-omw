/**
 * 库句柄 / 写者锁 / 消费者的回收编排（Story 1.5、2.2；2026-11-14 dispose 修复）。
 *
 * 注册的全是 effect：自己打开的资源必须挂 disposer 由宿主统一释放。
 * 异步 disposer：宿主/测试都会 await 它（entry-exports.test.ts 逐个 await closers）。
 *
 * **回收顺序与 disposer 执行顺序解耦**：cordis 对同一 fiber 的兄弟 effect 是「逆注册序启动 +
 * Promise.all 并发完成」，没有完成顺序保证（harness `vendor/cordis/src/utils.ts:27-31`、
 * `vendor/cordis/src/fiber.ts:712-730`；cordis-tutorial/02-lifecycle-and-effects.md:94）。
 * 所以不能依赖「谁先注册谁先跑」：两个 effect 都经由记忆化的 runTeardown() 进入同一份 promise，
 * 于是「停消费者 → 等在飞轮次结算 → 关库句柄 → 释放写者锁」恒定成立。顺序本身有语义：
 * 写者锁若在库句柄还开着时就被释放，第二个实例会拿到锁却在 open 阶段撞上 LadybugDB 自己的
 * 文件锁（Error: 33），把「第二实例降级只读」变成启动失败。
 */
import type { Context } from '@deepseek-ai/cordis'
import { closeMemoryDatabase, memoryDatabaseBackendKind } from '../db/database.js'
import type { MemoryWriterLock } from '../db/writer-lock.js'
import { drainInboxBackgroundTasks } from '../inbox/consumer.js'
import type { MemoryRuntimeSlots } from './runtime.js'

export interface MemoryLifecycleOptions {
  readonly ctx: Context
  readonly dbPath: string
  readonly lock: MemoryWriterLock
  readonly slots: MemoryRuntimeSlots
}

/**
 * 注册 `omw-memory-db` 与 `omw-memory-writer-lock` 两个 effect（既有 closer 数不变）。
 * 调用点必须在库已成功打开之后。
 */
export function wireMemoryLifecycle(options: MemoryLifecycleOptions): void {
  const { ctx, dbPath, lock, slots } = options
  // 句柄所属后端在 apply 时定格：teardown 时句柄可能已被驱逐/关闭，再探测只会回落到「当前运行时」。
  // 该判定决定 dispose 是否真关句柄（wasm 可安全关闭并重开；native 关闭会打死同进程重开，
  // 见 db/database.ts closeMemoryDatabase 的两后端实测差异）。
  const backendKind = memoryDatabaseBackendKind(dbPath)

  const teardownResources = async (): Promise<void> => {
    // 每一步都不许把错误抛回宿主 dispose 流程：回收失败只告警，否则后续步骤（含锁释放）不执行。
    slots.inboxConsumer?.stop()
    slots.inboxConsumer = null
    slots.l2Consumer?.stop()
    slots.l2Consumer = null
    try {
      // drain 等在飞精炼结算（含在飞 LLM 调用）：stop() 只保证不再开新轮，不中断已取出条目
      // （AC3 不丢条目）。每次 LLM 调用自带 20–30s 预算，故等待有界，不做强制 abort。
      await drainInboxBackgroundTasks()
    } catch (error) {
      ctx.logger.warn('dispose：等在飞 INBOX 任务结算失败：' + (error instanceof Error ? error.message : String(error)))
    }
    try {
      // 句柄回收（2026-11-14 实测，0.22.3，见 db/database.ts closeMemoryDatabase 头注）：
      // wasm（Electron 宿主生产路径）close 后同进程可反复重开 ⇒ 真正关闭，释放 buffer pool
      // 与 worker 侧结果对象；native close 后同进程重开必失败 Error: 33 ⇒ 保留句柄，否则
      // 「禁用→启用」会在 apply 阶段直接失败（副作用大于回收收益）。
      if (backendKind === 'wasm') await closeMemoryDatabase(dbPath)
      else await slots.db?.close()
    } catch (error) {
      ctx.logger.warn('dispose：回收记忆库句柄失败：' + (error instanceof Error ? error.message : String(error)))
    }
    // 清掉本实例的引用：dispose 后到达的钩子/命令（若宿主顺序上还有在飞回调）看到的是「库未就绪」，
    // 而不是一个已关闭句柄上的半可用连接。
    slots.db = undefined
    slots.systemOneClient = null
  }

  let teardown: Promise<void> | null = null
  const runTeardown = (): Promise<void> => {
    teardown ??= teardownResources()
    return teardown
  }
  ctx.effect(() => runTeardown, 'omw-memory-db')
  // 写者锁最后释放：必须等库句柄真正归还之后（顺序由 runTeardown 保证，见上）。
  ctx.effect(() => async () => {
    await runTeardown()
    await lock.release()
  }, 'omw-memory-writer-lock')
}

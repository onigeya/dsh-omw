/**
 * 插件 dispose 资源回收回归测试（2026-11-14 修复）。
 *
 * 保护的行为（`src/index.ts` 的 `omw-memory-db` / `omw-memory-writer-lock` 两个 effect）：
 *
 * 1. **回收顺序与 disposer 执行顺序解耦**：cordis 对同一 fiber 的兄弟 effect 是「逆注册序
 *    启动 + Promise.all 并发完成」，没有完成顺序保证（harness `vendor/cordis/src/utils.ts`、
 *    `fiber.ts`；cordis-tutorial/02-lifecycle-and-effects.md:94）。写者锁 effect 注册在后 ⇒
 *    它的 disposer 会先启动。修复前它直接 `lock.release()`：写者锁可能在库句柄还开着时就被
 *    释放，另一个实例拿到锁却在 open 阶段撞上 LadybugDB 自己的文件锁（`Error: 33`），把
 *    「第二实例降级只读」变成启动失败。修复后两个 disposer 都走**同一个记忆化 teardown**：
 *    停消费者 → `drainInboxBackgroundTasks()` → 按后端回收 DB 句柄 → 才 `lock.release()`。
 *    所以**先 await writer-lock closer 之后**，teardown 必须已经跑完。
 *
 * 2. **幂等**：宿主 disable→enable 会重新 apply（新 fiber、同进程、ESM 缓存不逐出 ⇒ 模块级
 *    Map 复用），重复 dispose 不得抛错、不得把重启打死。
 *
 * 3. **dispose 后可重新 apply**：Node 测试环境是 native 后端，teardown 只关 facade、保留
 *    进程内句柄（native close 后同进程重开必失败 `IO exception: Could not set lock on file
 *    ... (Error: 33)`）。本文件**不断言** native 下句柄被真正 close，只钉「重新 apply 成功」。
 *
 * 4. **dispose 后无残留后台任务**：drainInboxBackgroundTasks() 立即结算。
 *
 * fake ctx 构造参考 test/inbox-apply-lifecycle.test.ts（记录 ctx.effect 注册的
 * `{name, dispose}`、tools.register、commands.register、on 等；profileContext.dir 指向临时目录）。
 * 每个测试用独立临时目录，避免跨测试共享 DB 路径（同进程同路径会被句柄缓存复用，串味）。
 */
import { access } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import type { MemoryCommandDefinition } from '../src/command'
import {
  INBOX_BACKGROUND_TASKS,
  drainInboxBackgroundTasks,
  type InboxConsumer,
} from '../src/inbox/consumer'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
/**
 * 最小合法配置：embedding 只给 token/model/dim（无 endpoint ⇒ embeddingMode='disabled'，
 * 只 warn 不抛错，也不会构造会发网络请求的客户端）；systemOne 关闭避免无关的运行态。
 */
const CONFIG = {
  embedding: { token: 'sk-test', model: 'bge-m3', dim: DIM },
  systemOne: { enabled: false },
}

/**
 * 捕获 apply 创建的两条消费链（L1 主路径 + L2 提升慢路径）。
 *
 * 「先跑 writer-lock closer 后消费者已停」是「锁释放必须等库 teardown」在测试里**可观测**的
 * 信号：修复前 writer-lock disposer 只 release 锁、不碰消费者，这个断言会红。
 */
const captured = vi.hoisted(() => ({ consumers: [] as InboxConsumer[] }))

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      const consumer = actual.createInboxConsumer(options)
      captured.consumers.push(consumer)
      return consumer
    },
  }
})

afterAll(cleanupTempDirs)

interface DisposeEntry {
  readonly name: string | undefined
  readonly dispose: () => unknown
}

interface Harness {
  readonly ctx: Parameters<typeof plugin.apply>[0]
  readonly disposers: DisposeEntry[]
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

/** apply 级最小 ctx：profileContext + commands + effect + tools.register + session/event 捕获。 */
function makeCtx(profileDir: string): Harness {
  const disposers: DisposeEntry[] = []
  const info = vi.fn()
  const warn = vi.fn()
  const ctx = {
    logger: { warn, info },
    get: (key: string) => {
      if (key === 'profileContext') return { dir: profileDir }
      if (key === 'commands') {
        return {
          register: (definition: MemoryCommandDefinition) => {
            void definition
            return () => {}
          },
        }
      }
      return undefined
    },
    effect: (factory: () => () => unknown, name?: string) => {
      const dispose = factory()
      disposers.push({ name, dispose })
      return dispose
    },
    tools: { register: () => () => {} },
    on: () => () => {},
  } as unknown as Parameters<typeof plugin.apply>[0]
  return { ctx, disposers, info, warn }
}

/** 按 effect name 取 closer（宿主逆注册序下会先启动的就是后注册的 writer-lock closer）。 */
function closer(harness: Harness, name: string): () => Promise<unknown> {
  const entry = harness.disposers.find((candidate) => candidate.name === name)
  if (!entry) {
    throw new Error(
      `未找到 effect ${name}；实际注册：${harness.disposers.map((candidate) => candidate.name).join(', ')}`,
    )
  }
  return async () => entry.dispose()
}

/** 跑一次 apply 并返回本次 apply 创建的两条消费链。 */
async function applyPlugin(harness: Harness): Promise<InboxConsumer[]> {
  const start = captured.consumers.length
  await plugin.apply(harness.ctx, CONFIG)
  const consumers = captured.consumers.slice(start)
  // 写者实例启动 L1 主路径 + L2 提升慢路径各一条（只读实例不启动，这里必然是写者）。
  expect(consumers).toHaveLength(2)
  return consumers
}

/** 逆注册序 dispose（与宿主启动 disposer 的顺序一致：writer-lock → db → command）。 */
async function disposeAll(disposers: readonly DisposeEntry[]): Promise<void> {
  for (const entry of [...disposers].reverse()) await entry.dispose()
}

function lockPathOf(dbPath: string): string {
  return `${dbPath}.lock`
}

describe('dispose 回收顺序：写者锁必须等库 teardown 完成', () => {
  it('先跑 writer-lock closer：完成时消费者已停（teardown 已执行）、锁文件已消失，随后 db closer 幂等', async () => {
    const dir = await makeTempDir('omw-dispose-order-')
    const dbPath = resolveMemoryDbPath(dir)
    const harness = makeCtx(dir)
    const consumers = await applyPlugin(harness)

    // apply 后：写者锁文件在位、两条消费链都在跑。
    await expect(access(lockPathOf(dbPath))).resolves.toBeUndefined()
    expect(consumers.map((consumer) => consumer.isRunning())).toEqual([true, true])

    // 宿主会**先启动** writer-lock 的 disposer（逆注册序）。这里单独 await 它，观察锁释放阶段。
    await closer(harness, 'omw-memory-writer-lock')()

    // 修复核心：writer-lock closer 完成 ⇒ teardown 已跑完（消费者已停）。
    // 退回「disposer 直接 lock.release()」时消费者仍在跑，本条立刻变红。
    expect(consumers.map((consumer) => consumer.isRunning())).toEqual([false, false])
    // ① 写者锁文件已消失（release 已收尾，不是只删内存引用）。
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()

    // ② 再调用 db closer：不抛错且幂等（两个 disposer 共享记忆化 teardown 的同一 promise）。
    const dbCloser = closer(harness, 'omw-memory-db')
    await expect(dbCloser()).resolves.toBeUndefined()
    await expect(dbCloser()).resolves.toBeUndefined()
    // writer-lock closer 重复调用同样幂等（它已经等过 teardown，重复只是复用）。
    await expect(closer(harness, 'omw-memory-writer-lock')()).resolves.toBeUndefined()
  }, 60_000)

  it('两个 closer 各调用两次不抛错，且最终锁文件已释放', async () => {
    const dir = await makeTempDir('omw-dispose-idempotent-')
    const dbPath = resolveMemoryDbPath(dir)
    const harness = makeCtx(dir)
    await applyPlugin(harness)

    const lockCloser = closer(harness, 'omw-memory-writer-lock')
    const dbCloser = closer(harness, 'omw-memory-db')
    // 宿主 Promise.all 并发完成 ⇒ 两种顺序都可能；重复调用必须都安全。
    for (let round = 0; round < 2; round += 1) {
      await expect(lockCloser()).resolves.toBeUndefined()
      await expect(dbCloser()).resolves.toBeUndefined()
    }
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  }, 60_000)
})

describe('disable→enable：dispose 后可重新 apply（同进程句柄复用）', () => {
  it('全部 closers 跑完后再次 apply 成功（不抛 db_open_failed / Error 33），新库可读，再 dispose 也正常', async () => {
    const dir = await makeTempDir('omw-dispose-reapply-')
    const dbPath = resolveMemoryDbPath(dir)
    const harness = makeCtx(dir)

    const firstConsumers = await applyPlugin(harness)
    const firstClosers = [...harness.disposers]
    // 每次成功 apply：命令 effect + db closer + 写者锁 closer = 3（entry-exports 钉死 closer 数）。
    expect(firstClosers).toHaveLength(3)

    await disposeAll(firstClosers)
    expect(firstConsumers.map((consumer) => consumer.isRunning())).toEqual([false, false])
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()

    // 再次 apply：native 下 teardown 只关 facade、保留进程内句柄 ⇒ 复用句柄重建 facade。
    // 修复前（句柄被真关 / 锁在库还开着时就被释放）这里会抛 db_open_failed / Error: 33。
    const beforeSecondApply = harness.disposers.length
    await expect(plugin.apply(harness.ctx, CONFIG)).resolves.toBeUndefined()
    expect(harness.disposers.length).toBe(beforeSecondApply + 3)
    const secondConsumers = captured.consumers.slice(-2)
    expect(secondConsumers.map((consumer) => consumer.isRunning())).toEqual([true, true])
    // 写者实例：第二次 apply 仍拿到写者锁（不是降级只读）。
    await expect(access(lockPathOf(dbPath))).resolves.toBeUndefined()

    // 第二次 apply 的库真的可用（不只是 apply resolve）：经同一 facade 读库级元数据。
    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'bge-m3' })
    const meta = await queryAll(store.connection, 'MATCH (m:omw_meta) RETURN count(m) AS c')
    expect(Number(meta[0]?.c)).toBeGreaterThan(0)

    // 第二次 dispose：同样正常，锁释放、消费者停止。
    await disposeAll(harness.disposers.slice(beforeSecondApply))
    expect(secondConsumers.map((consumer) => consumer.isRunning())).toEqual([false, false])
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  }, 60_000)

  it('dispose 后 drainInboxBackgroundTasks() 立即结算，无残留后台任务', async () => {
    const dir = await makeTempDir('omw-dispose-drain-')
    const harness = makeCtx(dir)
    await applyPlugin(harness)

    // 让消费者的第一个 tick（arm(0)）真的跑起来：teardown 的 drain 必须能把在飞轮次等干净。
    await new Promise((resolve) => setTimeout(resolve, 50))

    await disposeAll(harness.disposers)

    const startedAt = Date.now()
    await expect(drainInboxBackgroundTasks()).resolves.toBeUndefined()
    // 「立即」= 不再有需要等待的在飞任务（给 1s 余量，远小于单次 LLM/网络预算）。
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(INBOX_BACKGROUND_TASKS.size).toBe(0)
  }, 60_000)
})

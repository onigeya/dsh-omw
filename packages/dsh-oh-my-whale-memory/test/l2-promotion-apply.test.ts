/**
 * apply 级接线测试（Story 2.5 / U1、U6、U9、brief §5.4）。
 *
 * 只有在这一层才看得见的四件事：
 * ① 第二条消费链真的绑在 l2_inbox 上、intervalMs 是 30s 慢节律（AC:721 不与 L1 争资源）；
 * ② 让路闸门真的按「L1 有待处理条目」为假（brief §5.4）——闸门接反了宿主级测试看不出来；
 * ③ L2 队列的启动回收真的在 apply 里跑了（U7 口径）；
 * ④ /memory status 的 systemOne 行取自配置态与运行态两个来源（U6/U12）；
 * ⑤ 评审 P15（T14）：dispose 时**两条**消费链都被停掉（此前只断言到 L1 那条）；
 * ⑥ 评审 P14⑥（T26）：注入 L2 处理器的 systemOne 客户端真的跟着配置开关为 null / 非 null。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { l1InboxQueue, l2InboxQueue, enqueueInboxItem } from '../src/inbox/queue'
import { drainInboxBackgroundTasks, type InboxConsumerOptions } from '../src/inbox/consumer'
import { L2_PROMOTION_INTERVAL_MS } from '../src/distill/promotion'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

/** createInboxConsumer 的捕获点：按创建顺序留下每次 options（L1 先、L2 后）。 */
/** createInboxConsumer / createL2PromotionProcessor 的捕获点（评审 P15、P14⑥）。 */
const captured = vi.hoisted(() => ({
  all: [] as unknown[],
  /** dispose 断言用：每次 createInboxConsumer 的 stop 都被包一层。 */
  stops: [] as ReturnType<typeof vi.fn>[],
  /** P14⑥：createL2PromotionProcessor 收到的 deps（取最后一次）。 */
  processorDeps: [] as unknown[],
  /** apply 注册的 effect closers（宿主负责 await 它们）。 */
  closers: [] as (() => unknown)[],
}))

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      captured.all.push(options)
      const consumer = actual.createInboxConsumer(options)
      const stop = vi.fn(() => consumer.stop())
      captured.stops.push(stop)
      return { ...consumer, stop }
    },
  }
})

vi.mock('../src/distill/promotion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/distill/promotion')>()
  return {
    ...actual,
    createL2PromotionProcessor: (deps: Parameters<typeof actual.createL2PromotionProcessor>[0]) => {
      captured.processorDeps.push(deps)
      return actual.createL2PromotionProcessor(deps)
    },
  }
})

afterAll(cleanupTempDirs)

interface Harness {
  readonly ctx: Parameters<typeof plugin.apply>[0]
  readonly registeredDefs: MemoryCommandDefinition[]
  readonly info: ReturnType<typeof vi.fn>
}

function makeCtx(profileDir: string): Harness {
  const registeredDefs: MemoryCommandDefinition[] = []
  const info = vi.fn()
  const warn = vi.fn()
  const ctx = {
    logger: { warn, info },
    sessions: { flush: async () => undefined },
    get: (key: string) => {
      if (key === 'profileContext') return { dir: profileDir }
      if (key === 'commands') {
        return {
          register: (definition: MemoryCommandDefinition) => {
            registeredDefs.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    // 评审 P15：closer 必须被收下来才能在用例里验证 dispose 顺序（此前直接丢弃）。
    effect: (factory: () => () => unknown) => { captured.closers.push(factory()); return () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
  } as unknown as Parameters<typeof plugin.apply>[0]
  return { ctx, registeredDefs, info }
}

/** 每个用例独立库 + 独立 apply ⇒ 捕获点也要清干净（否则跨用例累积）。 */
function resetCaptured(): void {
  captured.all.length = 0
  captured.stops.length = 0
  captured.processorDeps.length = 0
  captured.closers.length = 0
}

async function openStore(prefix: string): Promise<{ store: MemoryDatabase, dbPath: string, dir: string }> {
  const dir = await makeTempDir(prefix)
  const dbPath = resolveMemoryDbPath(dir)
  await ensureMemoryDbDirectory(dbPath)
  const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })
  return { store, dbPath, dir }
}

describe('Story 2.5：apply 装配第二条消费链', () => {
  it('L2 消费者绑 l2_inbox、30s 慢节律、带让路闸门；闸门按 L1 队列是否为空作答', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-wire-')
    const harness = makeCtx(dir)

    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)
    // 两条消费链：L1（主路径）+ L2（提升慢路径）。
    expect(captured.all).toHaveLength(2)
    const l1Options = captured.all[0] as InboxConsumerOptions
    const l2Options = captured.all[1] as InboxConsumerOptions

    // L1 主路径不传 queue（缺省 = l1_inbox，2.2 行为逐字不变）；L2 传的就是 l2InboxQueue 实例本身。
    expect(l1Options.queue).toBeUndefined()
    expect(l2Options.queue).toBe(l2InboxQueue)
    expect(l2Options.queue?.table).toBe('l2_inbox')
    expect(l2Options.intervalMs).toBe(L2_PROMOTION_INTERVAL_MS)
    expect(typeof l2Options.process).toBe('function')
    expect(typeof l2Options.claimGuard).toBe('function')

    // 让路闸门：L1 无 pending ⇒ 放行；插一条 L1 pending ⇒ 挡下（慢路径给主路径让路）。
    expect(await l2Options.claimGuard?.()).toBe(true)
    await enqueueInboxItem(store.connection, { payload: 'L1 待处理', kind: 'work_fact', now: at(1) })
    expect(await l2Options.claimGuard?.()).toBe(false)

    await drainInboxBackgroundTasks()
    await store.close()
  })

  it('apply 启动回收 L2 队列的 processing（U7：单写者下必属已死进程）并打日志', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-reclaim-')
    // 预置一条 L2 processing 行：模拟上个进程崩在提升中途。
    await l2InboxQueue.enqueue(store.connection, { id: 'l2-stuck', payload: '{"l1Ids":["x"]}', now: at(1) })
    await l2InboxQueue.claimNext(store.connection, { owner: 'dead-process', now: at(1) })
    expect(String((await queryAll(store.connection, "MATCH (q:l2_inbox {id: 'l2-stuck'}) RETURN q.status AS status"))[0]!.status)).toBe('processing')

    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)

    const rows = await queryAll(store.connection, "MATCH (q:l2_inbox {id: 'l2-stuck'}) RETURN q.status AS status")
    expect(String(rows[0]!.status)).toBe('pending')
    expect(harness.info.mock.calls.some((call) => String(call[0]).includes('L2 INBOX 启动回收'))).toBe(true)

    await drainInboxBackgroundTasks()
    await store.close()
  })

  // 评审 P15（T14）：dispose 顺序的**两条链**都必须被停。此前 makeCtx 丢弃了 closer，
  // 且捕获点只在 options.queue === undefined 时记录 consumer ⇒ L2 的 dispose 无断言。
  it('dispose 时 L1 与 L2 两条消费链都被 stop（且先于关库）', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-dispose-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)

    expect(captured.stops).toHaveLength(2)
    expect(captured.closers.length).toBeGreaterThan(0)
    expect(captured.stops[1]!.mock.calls).toHaveLength(0)

    // 宿主 await 每一个 closer（entry-exports 同款用法）⇒ 第二条（db）closer 内停两条消费者。
    for (const closer of captured.closers) {
      try { await closer() } catch { /* 锁释放等其它 closer 的失败与本用例无关 */ }
    }
    expect(captured.stops[0]!.mock.calls).toHaveLength(1)
    expect(captured.stops[1]!.mock.calls).toHaveLength(1)

    await drainInboxBackgroundTasks()
    await store.close()
  })
})

describe('Story 2.5 / U6：status 的 systemOne 行', () => {
  it('配置开启且未降级 ⇒ systemOne: enabled', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-status-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)

    // 评审 P14⑥（T26）：配置开启 ⇒ 真客户端被注入提升处理器（此前无任何断言）。
    expect(captured.processorDeps.at(-1)).toMatchObject({ systemOne: expect.anything() })
    expect((captured.processorDeps.at(-1) as { systemOne?: unknown } | undefined)?.systemOne).not.toBeNull()

    const result = await harness.registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('systemOne: enabled')

    await drainInboxBackgroundTasks()
    await store.close()
  })

  it('配置关闭（systemOne.enabled=false）⇒ systemOne: disabled-by-config（降级回 ctx.llm）', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-status-off-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, { ...EMBEDDING_CONFIG, systemOne: { enabled: false } })

    // 评审 P14⑥（T26）：配置关闭 ⇒ 处理器拿到的是 null（整体回落 ctx.llm）。
    expect((captured.processorDeps.at(-1) as { systemOne?: unknown } | undefined)?.systemOne).toBeNull()

    const result = await harness.registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('systemOne: disabled-by-config（已降级回 ctx.llm）')

    await drainInboxBackgroundTasks()
    await store.close()
  })
  /**
   * 评审 P24（变异审计 M6）：让路闸门必须按**「现在就能干的活」**作答，不是按 pending 计数。
   *
   * 变异敏感度：把 index.ts 的 `(await l1InboxQueue.countBusy(connection)) === 0` 换回
   * `.countByStatus(connection)).pending === 0` ⇒ 本条变红。
   * 关键状态：退避中的 pending（lease_until 在未来，最长 120s）**不算忙** —— 它现在取不出来，
   * 让 L2 慢循环停摆纯属浪费；现有断言只覆盖「无 pending」与「有 pending 且可立即取」。
   */
  it('L1 只有退避中的 pending（lease_until 在未来）⇒ 不算忙，闸门放行（变异审计 M6）', async () => {
    resetCaptured()
    const { store, dir } = await openStore('omw-l2-busy-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)
    const l2Options = captured.all[1] as InboxConsumerOptions
    // apply 之后再入队：L1 消费者此刻已就位，故必须让「有活儿」这件事在库状态上静止。
    await enqueueInboxItem(store.connection, { id: 'l1-backoff', payload: '退避中的 L1', kind: 'work_fact', now: at(1) })
    await store.connection.query(
      "MATCH (q:l1_inbox {id: 'l1-backoff'}) SET q.lease_until = '2099-01-01T00:00:00.000Z'",
    )

    // 反面前提：按 pending **计数**确实是 1（故变异实现会误判为「忙」），而按 countBusy 是 0。
    expect(await l1InboxQueue.countByStatus(store.connection)).toMatchObject({ pending: 1 })
    expect(await l1InboxQueue.countBusy(store.connection)).toBe(0)
    expect(await l2Options.claimGuard?.()).toBe(true)

    await drainInboxBackgroundTasks()
    await store.close()
  })
})

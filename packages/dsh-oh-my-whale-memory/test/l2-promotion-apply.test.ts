/**
 * apply 级接线测试（Story 2.5 / U1、U6、U9、brief §5.4）。
 *
 * 只有在这一层才看得见的四件事：
 * ① 第二条消费链真的绑在 l2_inbox 上、intervalMs 是 30s 慢节律（AC:721 不与 L1 争资源）；
 * ② 让路闸门真的按「L1 有待处理条目」为假（brief §5.4）——闸门接反了宿主级测试看不出来；
 * ③ L2 队列的启动回收真的在 apply 里跑了（U7 口径）；
 * ④ /memory status 的 systemOne 行取自配置态与运行态两个来源（U6/U12）。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { l2InboxQueue, enqueueInboxItem } from '../src/inbox/queue'
import { drainInboxBackgroundTasks, type InboxConsumerOptions } from '../src/inbox/consumer'
import { L2_PROMOTION_INTERVAL_MS } from '../src/distill/promotion'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

/** createInboxConsumer 的捕获点：按创建顺序留下每次 options（L1 先、L2 后）。 */
const captured = vi.hoisted(() => ({ all: [] as unknown[] }))

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      captured.all.push(options)
      return actual.createInboxConsumer(options)
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
    effect: (factory: () => () => unknown) => factory(),
    tools: { register: () => () => {} },
    on: () => () => {},
  } as unknown as Parameters<typeof plugin.apply>[0]
  return { ctx, registeredDefs, info }
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
    captured.all.length = 0
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
    captured.all.length = 0
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
})

describe('Story 2.5 / U6：status 的 systemOne 行', () => {
  it('配置开启且未降级 ⇒ systemOne: enabled', async () => {
    captured.all.length = 0
    const { store, dir } = await openStore('omw-l2-status-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)

    const result = await harness.registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('systemOne: enabled')

    await drainInboxBackgroundTasks()
    await store.close()
  })

  it('配置关闭（systemOne.enabled=false）⇒ systemOne: disabled-by-config（降级回 ctx.llm）', async () => {
    captured.all.length = 0
    const { store, dir } = await openStore('omw-l2-status-off-')
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, { ...EMBEDDING_CONFIG, systemOne: { enabled: false } })

    const result = await harness.registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('systemOne: disabled-by-config（已降级回 ctx.llm）')

    await drainInboxBackgroundTasks()
    await store.close()
  })
})

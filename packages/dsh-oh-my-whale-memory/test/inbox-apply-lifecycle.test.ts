/**
 * apply 级接线测试（Story 2.2 评审补丁 P7 / P9-①③）。
 *
 * 两条只有在这一层才看得见的路径：
 * - P7：写者 apply 启动回收**全部** processing（不论 lease 是否过期，U7）——回收原语的
 *   单测证明不了 apply 真的调了它，这里预置 processing 行再跑真 apply；
 * - ③（V3）：apply 交给消费者的 gate 与 session/event 监听器驱动的是**同一实例**。把监听器
 *   接到另一个 createIdleGate() 上，消费者就永远不会被闸门挡住（宿主级测试看不出来），
 *   所以这里拦下 createInboxConsumer 的 options，回放 turn/start / turn/end 直接看那个 gate。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { INBOX_LEASE_MS, claimNextInboxItem, enqueueInboxItem } from '../src/inbox/queue'
import { drainInboxBackgroundTasks, type InboxConsumerOptions } from '../src/inbox/consumer'
import { captureStableKey, l0InboxId, l0RawId } from '../src/db/l0'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

/** createInboxConsumer 的捕获点：证明 apply 把哪个 gate 交给了消费者（V3）。 */
const captured = vi.hoisted(() => ({
  options: undefined as InboxConsumerOptions | undefined,
  consumer: undefined as unknown,
}))

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      captured.options = options
      const consumer = actual.createInboxConsumer(options)
      captured.consumer = consumer
      return consumer
    },
  }
})

afterAll(cleanupTempDirs)

interface Harness {
  readonly ctx: Parameters<typeof plugin.apply>[0]
  readonly listeners: Array<(session: unknown, event: unknown) => void>
  readonly registeredDefs: MemoryCommandDefinition[]
  readonly disposers: Array<{ readonly name: string | undefined; readonly dispose: () => unknown }>
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

/** apply 级最小 ctx：profileContext + commands + effect + tools.register + session/event 捕获。 */
function makeCtx(profileDir: string, options: { readonly flush?: () => Promise<unknown> } = {}): Harness {
  const listeners: Array<(session: unknown, event: unknown) => void> = []
  const registeredDefs: MemoryCommandDefinition[] = []
  const disposers: Array<{ name: string | undefined; dispose: () => unknown }> = []
  const info = vi.fn()
  const warn = vi.fn()
  const ctx = {
    logger: { warn, info },
    // P6：index.ts 用 ctx.sessions.flush 做 turn/end 的持久化屏障（真宿主由 inject 'sessions' 提供）。
    sessions: options.flush ? { flush: options.flush } : undefined,
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
    effect: (factory: () => () => unknown, name?: string) => {
      const dispose = factory()
      disposers.push({ name, dispose })
      return dispose
    },
    tools: { register: () => () => {} },
    on: (event: string, listener: (session: unknown, event: unknown) => void) => {
      if (event === 'session/event') listeners.push(listener)
      return () => {}
    },
  } as unknown as Parameters<typeof plugin.apply>[0]
  return { ctx, listeners, registeredDefs, disposers, info, warn }
}

async function readInboxRow(
  connection: MemoryDatabase['connection'],
  id: string,
): Promise<Record<string, unknown>> {
  const rows = await queryAll(
    connection,
    'MATCH (q:l1_inbox) WHERE q.id = \'' + id + '\'' +
    ' RETURN q.status AS status, q.lease_owner AS lease_owner, q.lease_until AS lease_until, q.attempts AS attempts',
  )
  return rows[0] as Record<string, unknown>
}

describe('P7/AC3：写者 apply 启动回收「全部 processing」', () => {
  it('lease 已过期与未过期的 processing 都回 pending，并打出启动回收日志', async () => {
    const dir = await makeTempDir('omw-inbox-apply-')
    const dbPath = resolveMemoryDbPath(dir)
    await ensureMemoryDbDirectory(dbPath)
    const store: MemoryDatabase = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })

    const expired = 'apply-reclaim-expired'
    const fresh = 'apply-reclaim-fresh'
    await enqueueInboxItem(store.connection, { id: expired, payload: '过期条目', now: at(1) })
    await enqueueInboxItem(store.connection, { id: fresh, payload: '未过期条目', now: at(2) })
    await claimNextInboxItem(store.connection, { owner: 'dead-process', now: at(3) })
    // fresh 的 lease 刻意放到真实时钟的远未来（约 69 天）：「只回收过期」的原语必然放过它。
    await claimNextInboxItem(store.connection, {
      owner: 'dead-process',
      now: at(4),
      leaseMs: 1_000_000 * INBOX_LEASE_MS,
    })
    const freshBefore = await readInboxRow(store.connection, fresh)
    expect(freshBefore.status).toBe('processing')
    expect(Date.parse(String(freshBefore.lease_until))).toBeGreaterThan(Date.now())

    const { ctx, info } = makeCtx(dir)
    await plugin.apply(ctx, EMBEDDING_CONFIG)

    const expiredAfter = await readInboxRow(store.connection, expired)
    expect(expiredAfter.status).toBe('pending')
    expect(expiredAfter.lease_owner).toBeNull()
    expect(expiredAfter.lease_until).toBeNull()
    const freshAfter = await readInboxRow(store.connection, fresh)
    expect(freshAfter.status).toBe('pending')
    expect(freshAfter.lease_owner).toBeNull()
    expect(freshAfter.lease_until).toBeNull()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('INBOX 启动回收：2 条'))
  }, 60_000)
})

describe('③：消费者与 session/event 监听器共享同一 gate 实例（V3）', () => {
  it('回放 turn/start 后 apply 交给消费者的 gate 立刻变忙；turn/end 后恢复空闲', async () => {
    const dir = await makeTempDir('omw-inbox-gate-')
    captured.options = undefined
    const { ctx, listeners, registeredDefs, info } = makeCtx(dir)
    await plugin.apply(ctx, EMBEDDING_CONFIG)

    expect(registeredDefs).toHaveLength(1)
    expect(listeners).toHaveLength(1)
    expect(info.mock.calls.flat().join('\n')).toContain('记忆库就绪')

    const gate = captured.options?.gate
    expect(gate).toBeDefined()
    expect(gate!.isIdle()).toBe(true)

    listeners[0]({ id: 'sess-gate' }, { type: 'turn/start' })
    // 若 index.ts 把监听器接到**另一个** gate 实例，这里仍是 true——消费者永远不会被挡住。
    expect(gate!.isIdle()).toBe(false)
    expect(gate!.depthFor('sess-gate')).toBe(1)

    listeners[0]({ id: 'sess-gate' }, { type: 'turn/end' })
    expect(gate!.isIdle()).toBe(true)
  }, 60_000)
})

describe('P3/VG-V4：db effect 的 disposer 先停消费者、等在飞轮次、再关库', () => {
  it('跑完 "omw-memory-db" 的 disposer 后消费者已停（dispose 不再依赖进程退出）', async () => {
    const dir = await makeTempDir('omw-inbox-dispose-')
    captured.options = undefined
    captured.consumer = undefined
    const { ctx, disposers } = makeCtx(dir)
    await plugin.apply(ctx, EMBEDDING_CONFIG)

    const consumer = captured.consumer as { isRunning(): boolean } | undefined
    expect(consumer).toBeDefined()
    expect(consumer!.isRunning()).toBe(true)

    // 只跑 db effect 的 disposer（命令/写者锁的与消费者无关）：
    // stop() → await drainInboxBackgroundTasks() → db.close()。
    const dbEffect = disposers.find((entry) => entry.name === 'omw-memory-db')
    expect(dbEffect).toBeDefined()
    await dbEffect!.dispose()

    expect(consumer!.isRunning()).toBe(false)
  }, 60_000)
})

describe('Story 2.1：apply 把三钩子采集器接进 session/event（AC①③）', () => {
  it('inject 含 sessions；回放 turn/end 后 l0_raw 与 l1_inbox 各落 1 行，且重复回放不增行', async () => {
    const dir = await makeTempDir('omw-inbox-capture-')
    const dbPath = resolveMemoryDbPath(dir)
    await ensureMemoryDbDirectory(dbPath)
    const store: MemoryDatabase = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })

    captured.options = undefined
    const { ctx, listeners } = makeCtx(dir)
    await plugin.apply(ctx, EMBEDDING_CONFIG)

    expect(plugin.inject).toContain('sessions')
    expect(listeners).toHaveLength(1)

    const session = { id: 'apply-capture', deriveMessages: () => [{ role: 'user', content: '轮末原文' }] }
    listeners[0](session, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const stableKey = captureStableKey('turn', 'apply-capture', '1')
    const l0 = (await queryAll(
      store.connection,
      "MATCH (l:l0_raw) WHERE l.id = '" + l0RawId(stableKey) + "' RETURN l.raw_text AS raw_text, l.actor AS actor",
    ))[0]
    expect(l0?.raw_text).toBe('user: 轮末原文')
    expect(l0?.actor).toBe('apply-capture')

    const inbox = await readInboxRow(store.connection, l0InboxId(stableKey))
    expect(inbox.status).toBe('pending')

    // 确定性 id + 每轮至多一次：同一 (session, turn) 再回放不新增第二行队列条目。
    listeners[0](session, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    const rows = await queryAll(
      store.connection,
      "MATCH (q:l1_inbox) WHERE q.id = '" + l0InboxId(stableKey) + "' RETURN q.id AS id",
    )
    expect(rows).toHaveLength(1)
  }, 60_000)
})

  it('P6：turn/end 的采集在 flush 未结算前不落库，结算后才落库（屏障真的接在 collect 前）', async () => {
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const flush = vi.fn(() => barrier)
    const dir = await makeTempDir('omw-inbox-flush-')
    const dbPath = resolveMemoryDbPath(dir)
    await ensureMemoryDbDirectory(dbPath)
    const store: MemoryDatabase = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })

    // 注意：这里必须真的把 sessions.flush 接进 ctx —— 若 index.ts 查错服务名（例如只查 ctx.get('sessions')），
    // 闭包会静默退化成 no-op，本用例就会在“结算后才有行”这一步之外失败。
    const { ctx, listeners } = makeCtx(dir, { flush })
    await plugin.apply(ctx, EMBEDDING_CONFIG)

    const session = { id: 'apply-flush', deriveMessages: () => [{ role: 'user', content: '轮末原文' }] }
    listeners[0](session, { type: 'turn/end', seq: 70, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).toHaveBeenCalledTimes(1)
    const before = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'apply-flush' RETURN l.id AS id")
    expect(before).toHaveLength(0)

    release()
    await drainInboxBackgroundTasks()
    const after = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'apply-flush' RETURN l.id AS id")
    expect(after).toHaveLength(1)
  }, 60_000)

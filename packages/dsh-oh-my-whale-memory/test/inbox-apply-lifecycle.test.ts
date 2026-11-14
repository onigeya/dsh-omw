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
import { captureStableKey, l0RawId } from '../src/db/l0'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
/** P11（T12/VG-3）：enabled 需要 endpoint（config.ts:139-148 起 endpoint 是必要项）。 */
const EMBEDDING_CONFIG_ENABLED = {
  embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL_ID, dim: DIM },
}
const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds))

/**
 * createInboxConsumer 的捕获点：证明 apply 把哪个 gate 交给了消费者（V3）。
 *
 * Story 2.5 起 apply 会建**两条**消费链（L1 主路径 + L2 提升慢路径），故这里持续累积；
 * `options`/`consumer` 只跟随**不传 queue 的那一条**（即 L1 主路径）——本文件所有断言
 * 说的都是它；L2 慢路径的接线由 test/l2-promotion-apply.test.ts 单独钉。
 */
const captured = vi.hoisted(() => ({
  options: undefined as InboxConsumerOptions | undefined,
  consumer: undefined as unknown,
  all: [] as InboxConsumerOptions[],
}))

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      captured.all.push(options)
      const consumer = actual.createInboxConsumer(options)
      if (options.queue === undefined) {
        captured.options = options
        captured.consumer = consumer
      }
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

/**
 * 回放一个 `session/event`：Story 3.1 起 apply 在写者模式注册**两个**监听器
 * （召回配额重置 + 闸门/L1 提升/三钩子采集）。事件应派发给全部监听器——按数组下标
 * 取单个会把断言绑死在注册顺序上。
 */
function replay(harn: Pick<Harness, 'listeners'>, session: unknown, event: unknown): void {
  for (const listener of harn.listeners) listener(session, event)
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
    // Story 3.1：召回配额重置 + 闸门/采集 两个监听器（事件派发见 replay helper）。
    // Story 3.3 / F-05：注入面的 `session/disposed` 清理监听（第三个 session/event 监听器）。
    expect(listeners).toHaveLength(3)
    expect(info.mock.calls.flat().join('\n')).toContain('记忆库就绪')

    const gate = captured.options?.gate
    expect(gate).toBeDefined()
    expect(gate!.isIdle()).toBe(true)

    replay({ listeners }, { id: 'sess-gate' }, { type: 'turn/start' })
    // 若 index.ts 把监听器接到**另一个** gate 实例，这里仍是 true——消费者永远不会被挡住。
    expect(gate!.isIdle()).toBe(false)
    expect(gate!.depthFor('sess-gate')).toBe(1)

    replay({ listeners }, { id: 'sess-gate' }, { type: 'turn/end' })
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
    // Story 3.1：召回配额重置 + 三钩子采集 两个监听器。
    // Story 3.3 / F-05：注入面的 `session/disposed` 清理监听（第三个 session/event 监听器）。
    expect(listeners).toHaveLength(3)

    const session = { id: 'apply-capture', deriveMessages: () => [{ role: 'user', content: '轮末原文' }] }
    replay({ listeners }, session, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const stableKey = captureStableKey('turn', 'apply-capture', '1')
    const l0 = (await queryAll(
      store.connection,
      "MATCH (l:l0_raw) WHERE l.id = '" + l0RawId(stableKey) + "' RETURN l.raw_text AS raw_text, l.actor AS actor",
    ))[0]
    expect(l0?.raw_text).toBe('user: 轮末原文')
    expect(l0?.actor).toBe('apply-capture')

    const inbox = await readInboxRow(store.connection, l0RawId(stableKey))
    expect(inbox.status).toBe('pending')

    // 确定性 id + 每轮至多一次：同一 (session, turn) 再回放不新增第二行队列条目。
    replay({ listeners }, session, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    const rows = await queryAll(
      store.connection,
      "MATCH (q:l1_inbox) WHERE q.id = '" + l0RawId(stableKey) + "' RETURN q.id AS id",
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
    replay({ listeners }, session, { type: 'turn/end', seq: 70, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flush).toHaveBeenCalledTimes(1)
    const before = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'apply-flush' RETURN l.id AS id")
    expect(before).toHaveLength(0)

    release()
    await drainInboxBackgroundTasks()
    const after = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'apply-flush' RETURN l.id AS id")
    expect(after).toHaveLength(1)
  }, 60_000)

/**
 * Story 2.6 契约演进（Lead F1）：maintenance 从「embedding 回填（可选）」变成**恒存在的组合
 * 函数**——`embedding 回填（有客户端才跑）+ EVIDENCE 回填（不依赖任何配置，X1 义务）`。
 * 故 embedding disabled 时不再是 undefined；更强的新断言保证 disabled 下只跑 EVIDENCE 回填：
 * 真跑一轮 maintenance，必须写下游标哨兵且**不产生任何 backfill_embedding 审计行**。
 */
describe('P11/VG-3 + Story 2.6：组合 maintenance 的 apply 级接线', () => {
  /**
   * 评审 P12（T13）：光断言 `maintenance` 是函数，把 index.ts 里的向量回填整段删掉也全绿——
   * Story 2.4 的 U5 义务会静默停摆。这里在 **enabled** 分支真跑一轮：种一条无向量的存量节点，
   * 跑 maintenance，必须落一条 `backfill_embedding` 审计行（本夹具的 endpoint 指向死端口，
   * 故落的是聚合 **失败** 行——正好也钉住「失败要可见、不静默」）。
   */
  it('enabled ⇒ maintenance 真跑向量回填并落 backfill_embedding 审计行', async () => {
    const enabledDir = await makeTempDir('omw-bf-wire-on-')
    captured.options = undefined
    const on = makeCtx(enabledDir)
    await plugin.apply(on.ctx, EMBEDDING_CONFIG_ENABLED)
    // 先停消费者并等在飞轮次结算：否则它的定时轮自身就会跑 maintenance，断言会变成假阳性。
    ;(captured.consumer as { stop(): void } | undefined)?.stop()
    await drainInboxBackgroundTasks()

    const connection = captured.options?.connection() ?? null
    expect(connection).not.toBeNull()
    const conn = connection as Parameters<typeof queryAll>[0]
    await queryAll(
      conn,
      "CREATE (m:memory {id: 'wire-unembedded', layer: 'L1', kind: '', priority: 0, text: '待嵌入的存量节点', " +
        "valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-02T00:00:00.000Z', source_refs: []})",
    )
    const maintenance = captured.options?.maintenance
    if (maintenance) await maintenance()

    const rows = await queryAll(
      conn,
      "MATCH (g:generation_log) WHERE g.action = 'backfill_embedding' RETURN g.outcome AS outcome, g.reason AS reason",
    )
    // 删掉 index.ts 的 embeddingBackfill 接线，这里立刻变红。
    expect(rows.length).toBeGreaterThan(0)
    expect(String(rows[0]?.reason ?? '')).toContain('failed=')
    // 端点不可达 ⇒ 一条向量都没写进去，节点仍在待回填集里（幂等、不伪造成功）。
    const still = await queryAll(
      conn,
      "MATCH (m:memory {id: 'wire-unembedded'}) WHERE m.embedding IS NULL RETURN count(*) AS c",
    )
    expect(Number(still[0]?.c ?? 0)).toBe(1)
  }, 60_000)

  it('disabled ⇒ 仍为函数且只跑 EVIDENCE 回填', async () => {
    const disabledDir = await makeTempDir('omw-bf-wire-off-')
    captured.options = undefined
    const off = makeCtx(disabledDir)
    await plugin.apply(off.ctx, EMBEDDING_CONFIG)
    const maintenance = captured.options?.maintenance
    expect(typeof maintenance).toBe('function')
    const connection = captured.options?.connection() ?? null
    expect(connection).not.toBeNull()
    const conn = connection as Parameters<typeof queryAll>[0]
    // 评审 P15（T17）改了空库语义：游标为空 + 页为空 ⇒ 直接 return 0、**不写 done 哨兵**
    //（done 是「扫完了」的断言，空库给不出这个结论；先写 done 会让后续新增的存量节点永远
    // 不被回填）。所以这里先造一条**建表前就存在、source_refs 指向真 L0 行**的节点，
    // 让回填真的扫到一页并写边，才能断言扫描跑完。
    await queryAll(conn, "CREATE (l:l0_raw {id: 'wire-l0', raw_text: '原文', recorded_at: '2026-01-01T00:00:00.000Z', actor: 'system'})")
    await queryAll(
      conn,
      "CREATE (m:memory {id: 'wire-m1', layer: 'L1', kind: '', priority: 0, text: '存量节点', " +
        "valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-02T00:00:00.000Z', source_refs: ['wire-l0']})",
    )
    await maintenance?.()
    // EVIDENCE 回填跑到了：写了边 + 游标推进到 done（纯逻辑水位，不新增存储）。
    const edges = await queryAll(conn, "MATCH (:l0_raw {id: 'wire-l0'})-[e:EVIDENCE]->(:memory {id: 'wire-m1'}) RETURN count(e) AS c")
    expect(Number(edges[0]?.c ?? 0)).toBe(1)
    const cursor = await queryAll(conn, "MATCH (m:omw_meta {key: 'evidence_backfill_cursor'}) RETURN m.value AS v")
    expect(cursor[0]?.v).toBe('done')
    // 且**没有**任何 embedding 回填副作用（disabled ⇒ 不接 embeddingBackfill）。
    const embeddingRuns = await queryAll(
      connection as Parameters<typeof queryAll>[0],
      "MATCH (g:generation_log) WHERE g.action = 'backfill_embedding' RETURN count(*) AS c",
    )
    expect(Number(embeddingRuns[0]?.c ?? -1)).toBe(0)
    ;(captured.consumer as { stop(): void } | undefined)?.stop()
  }, 60_000)
})

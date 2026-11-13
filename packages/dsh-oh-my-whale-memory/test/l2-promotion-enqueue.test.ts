/**
 * 评审 P2（T2）：apply 级「触发信号 → 提升入队」的驱动测试。
 *
 * 为什么必须在这一层：`enqueuePromotion` 是闭包内部函数，除了 apply 没有别的入口；
 * 而它是**唯一**的 L1→L2 通路（grep `enqueuePromotion` 在生产只命中 index.ts）。
 * 测试手法：mock `inbox/promotion-trigger.js` 的 `createPromotionTracker` 捕获 options，
 * 但仍旧调用真实实现（不是替身），这样 `recordL1` 的真实阈值判定也一并覆盖。
 *
 * 变异敏感度：删掉 index.ts 里 `onTrigger` 的入队接线 ⇒ 本文件用例变红。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { upsertMemory, queryAll } from '../src/db/memory'
import { drainInboxBackgroundTasks, type InboxConsumerOptions } from '../src/inbox/consumer'
import { buildL2PromotionItemId } from '../src/distill/promotion'
import { memoryNodeId } from '../src/db/id'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const at = (seconds: number): string => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds)).toISOString()

/** 捕获 promotionTracker 的 options（真实实现仍在跑）。 */
const tracker = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }))

vi.mock('../src/inbox/promotion-trigger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/promotion-trigger')>()
  return {
    ...actual,
    createPromotionTracker: (options: Parameters<typeof actual.createPromotionTracker>[0]) => {
      tracker.options.push(options as unknown as Record<string, unknown>)
      return actual.createPromotionTracker(options)
    },
  }
})

vi.mock('../src/inbox/consumer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/consumer')>()
  return {
    ...actual,
    // L1/L2 消费者都不真正启动：本用例只验「触发 → 入队」，消费由别的文件覆盖。
    createInboxConsumer: (options: Parameters<typeof actual.createInboxConsumer>[0]) => {
      const consumer = actual.createInboxConsumer(options)
      return { ...consumer, start: () => {}, stop: () => {} }
    },
  }
})

afterAll(cleanupTempDirs)

function makeCtx(profileDir: string): { ctx: Parameters<typeof plugin.apply>[0], registered: MemoryCommandDefinition[] } {
  const registered: MemoryCommandDefinition[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    sessions: { flush: async () => undefined },
    get: (key: string) => {
      if (key === 'profileContext') return { dir: profileDir }
      if (key === 'commands') return { register: (d: MemoryCommandDefinition) => { registered.push(d); return () => {} } }
      return undefined
    },
    effect: (factory: () => () => unknown) => factory(),
    tools: { register: () => () => {} },
    on: () => () => {},
  } as unknown as Parameters<typeof plugin.apply>[0]
  return { ctx, registered }
}

async function openStore(prefix: string): Promise<{ store: MemoryDatabase, dir: string }> {
  const dir = await makeTempDir(prefix)
  const dbPath = resolveMemoryDbPath(dir)
  await ensureMemoryDbDirectory(dbPath)
  const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })
  return { store, dir }
}

describe('Story 2.5 / 评审 P2：apply 级触发信号真的把 L1 入 l2_inbox', () => {
  it('onTrigger ⇒ l2_inbox 出现确定性 id 的条目（payload 单元素），二次触发不新增', async () => {
    tracker.options.length = 0
    const { store, dir } = await openStore('omw-l2-enqueue-')
    // 先写两条有效 L1（真实表路径，供 enqueuePromotion 的游标分页取到）。
    const l1a = memoryNodeId('L1', '提升候选甲')
    const l1b = memoryNodeId('L1', '提升候选乙')
    await upsertMemory(store.connection, { layer: 'L1', text: '提升候选甲', kind: 'work_fact', priority: 1, recordedAt: at(1) })
    await upsertMemory(store.connection, { layer: 'L1', text: '提升候选乙', kind: 'work_fact', priority: 1, recordedAt: at(2) })

    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)

    // apply 里注册了 promotionTracker（真实实现）：取出它交出的 onTrigger。
    expect(tracker.options).toHaveLength(1)
    const onTrigger = tracker.options[0]!.onTrigger as (t: unknown) => void
    expect(typeof onTrigger).toBe('function')

    onTrigger({ reason: 'l1-total', totalL1: 20, sessionId: 'sess-1', kind: 'work_fact', sessionKindCount: 0 })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, 'MATCH (q:l2_inbox) RETURN q.id AS id, q.kind AS kind, q.payload AS payload ORDER BY q.id')
    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => String(r.id))
    expect(ids).toContain(buildL2PromotionItemId(l1a))
    expect(ids).toContain(buildL2PromotionItemId(l1b))
    for (const row of rows) {
      expect(String(row.kind)).toBe('l2-promotion')
      const payload = JSON.parse(String(row.payload)) as { l1Ids: string[] }
      expect(payload.l1Ids).toHaveLength(1)
    }

    // 二次触发：同批 L1 已有条目 ⇒ readStatus 非空 ⇒ 一条都不新增。
    onTrigger({ reason: 'session-end-same-kind', totalL1: 20, sessionId: 'sess-2', kind: 'work_fact', sessionKindCount: 5 })
    await drainInboxBackgroundTasks()
    const after = await queryAll(store.connection, 'MATCH (q:l2_inbox) RETURN count(q) AS total')
    expect(Number(after[0]!.total)).toBe(2)

    await store.close()
  })

  it('游标推进与入队同事务：页不足一页 ⇒ 游标回绕到空串（下一批从头再扫，靠 id 幂等去重）', async () => {
    tracker.options.length = 0
    const { store, dir } = await openStore('omw-l2-cursor-')
    await upsertMemory(store.connection, { layer: 'L1', text: '游标候选', kind: 'work_fact', priority: 1, recordedAt: at(3) })
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)
    const onTrigger = tracker.options[0]!.onTrigger as (t: unknown) => void
    onTrigger({ reason: 'l1-total', totalL1: 20, sessionId: 'sess-1', kind: 'work_fact', sessionKindCount: 0 })
    await drainInboxBackgroundTasks()

    const meta = await queryAll(store.connection, "MATCH (m:omw_meta {key: 'l2_promotion_cursor'}) RETURN m.value AS value")
    expect(String(meta[0]?.value ?? '')).toBe('')
    await store.close()
  })
  /**
   * 评审 P24（变异审计 M1）：提升候选必须**按游标分页取全部有效 L1**，不是取最新一窗。
   *
   * 变异敏感度：把 LIST_EFFECTIVE_IDS_BY_LAYER_STATEMENT 换成旧的「无游标 + ORDER BY
   * recorded_at DESC + LIMIT 20」，本条变红（25 条里最旧 5 条永远进不了 l2_inbox）。
   * 断言必须落在**具体 id 集合**上——只断言行数会在两条 L1 的旧用例上就已经漏掉这个缺口。
   */
  it('候选超过旧窗口（25 条 > LIMIT 20）⇒ 25 条全部入队，最旧的也在（变异审计 M1）', async () => {
    tracker.options.length = 0
    const { store, dir } = await openStore('omw-l2-window-')
    const expected = new Set<string>()
    for (let index = 0; index < 25; index += 1) {
      const text = '窗口候选' + String(index).padStart(2, '0')
      await upsertMemory(store.connection, {
        layer: 'L1',
        text,
        kind: 'work_fact',
        priority: 1,
        recordedAt: at(index + 1),
      })
      expected.add(buildL2PromotionItemId(memoryNodeId('L1', text)))
    }
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)
    const onTrigger = tracker.options[0]!.onTrigger as (t: unknown) => void
    onTrigger({ reason: 'l1-total', totalL1: 20, sessionId: 'sess-window', kind: 'work_fact', sessionKindCount: 0 })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, 'MATCH (q:l2_inbox) RETURN q.id AS id')
    const ids = new Set(rows.map((row) => String(row.id)))
    expect(rows).toHaveLength(25)
    for (const id of expected) expect(ids.has(id)).toBe(true)
    await store.close()
  })

  /**
   * 评审 P24（变异审计 M17）：`valid_at` 在将来的 L1 还没生效，不得进提升候选。
   * 变异敏感度：删掉 LIST_EFFECTIVE_IDS_BY_LAYER_STATEMENT 的 `AND m.valid_at <= $now` ⇒ 本条变红。
   */
  it('valid_at 在将来的 L1 不进候选（变异审计 M17）', async () => {
    tracker.options.length = 0
    const { store, dir } = await openStore('omw-l2-future-')
    await upsertMemory(store.connection, {
      layer: 'L1', text: '已生效的候选', kind: 'work_fact', priority: 1, recordedAt: at(1),
    })
    await upsertMemory(store.connection, {
      layer: 'L1', text: '将来才生效的候选', kind: 'work_fact', priority: 1, recordedAt: at(2),
      validAt: new Date(Date.UTC(2099, 0, 1)).toISOString(),
    })
    const harness = makeCtx(dir)
    await plugin.apply(harness.ctx, EMBEDDING_CONFIG)
    const onTrigger = tracker.options[0]!.onTrigger as (t: unknown) => void
    onTrigger({ reason: 'l1-total', totalL1: 20, sessionId: 'sess-future', kind: 'work_fact', sessionKindCount: 0 })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, 'MATCH (q:l2_inbox) RETURN q.id AS id')
    const ids = rows.map((row) => String(row.id))
    expect(ids).toContain(buildL2PromotionItemId(memoryNodeId('L1', '已生效的候选')))
    expect(ids).not.toContain(buildL2PromotionItemId(memoryNodeId('L1', '将来才生效的候选')))
    await store.close()
  })
})

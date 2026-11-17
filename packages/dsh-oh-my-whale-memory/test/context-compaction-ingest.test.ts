/**
 * 压缩入图与孤儿检测（Story 8.1 第 2 轮）。
 *
 * 覆盖：幂等（同 payload 两次 ⇒ 同 inboxId、一条 INBOX 行、`compaction_run` 只记一次）+
 * 孤儿检测（配对则不复位、未配对 60s 只回调一次、重复 start 替换、stop 清理）+ payload 解析。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import {
  COMPACTION_DELEGATE_COLUMN,
  COMPACTION_PLAN_JSON_COLUMN,
  COMPACTION_TIER_COLUMN,
} from '../src/db/schema'
import {
  compactionRunId,
  ingestCompactionSummary,
  recordCompactionRun,
} from '../src/context/compaction-ingest'
import {
  clearCompactionPlan,
  getCompactionCriteria,
  readCompactionPlan,
  registerCompactionCriteria,
  registerCompactionPlan,
  resetCompactionPlans,
} from '../src/context/compaction-plan-registry'
import {
  COMPACTION_ORPHAN_TIMEOUT_MS,
  createOrphanTracker,
  parseCompactionStart,
  type OrphanInfo,
} from '../src/context/compaction-orphan'
import { cleanupTempDirs, makeTempDir } from './tmp'
import { createCompactionWiring } from '../src/context/compaction-wiring'

const T0 = '2026-06-01T00:00:00.000Z'
const SNAPSHOT = { ratio: 0.8, headroom: 65536 }

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-compaction-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

function payload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's-1',
    compactionId: 'c-1',
    summary: '压缩摘要正文',
    shadowedSeqs: [1, 2, 3],
    shadowedRange: { start: 1, end: 3 },
    turn: 2,
    ...overrides,
  }
}

describe('压缩产物入图（AC:1528-1539）', () => {
  it('首次：INBOX 入图 + compaction_run 落账 + 返回 notes', async () => {
    const result = await ingestCompactionSummary(store.connection, {
      payload: payload(),
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      nowIso: T0,
    })
    expect(result.inboxId).toBe('compaction:s-1#c-1')
    expect(result.runRecorded).toBe(true)
    expect(result.notes).toEqual([])
    const runs = await queryRows(
      store.connection,
      "MATCH (r:compaction_run) RETURN r.id AS id, r.config_snapshot_json AS snapshot",
    )
    expect(runs.map((row) => String(row.id))).toContain(compactionRunId('s-1', 'c-1'))
    expect(String(runs[0]?.snapshot)).toContain('65536')
  })

  it('同 (sessionId, compactionId) 二次 ⇒ 幂等：同 inboxId、不新增 INBOX 行、run 不重复记', async () => {
    const before = await queryRows(store.connection, "MATCH (i:l1_inbox) RETURN count(i) AS c")
    const second = await ingestCompactionSummary(store.connection, {
      payload: payload({ summary: '正文可以不同，但键相同' }),
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      nowIso: T0,
    })
    expect(second.inboxId).toBe('compaction:s-1#c-1')
    expect(second.runRecorded).toBe(false)
    const after = await queryRows(store.connection, "MATCH (i:l1_inbox) RETURN count(i) AS c")
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c))
  })

  it('缺 compactionId ⇒ compaction_summary_invalid（不入图）', async () => {
    await expect(ingestCompactionSummary(store.connection, {
      payload: { sessionId: 's-1', summary: 'x' },
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      nowIso: T0,
    })).rejects.toMatchObject({ code: 'compaction_summary_invalid' })
  })

  it('recordCompactionRun 幂等：同键两次只记一次', async () => {
    expect(await recordCompactionRun(store.connection, {
      sessionId: 's-2',
      compactionId: 'c-2',
      configSnapshot: SNAPSHOT,
      startedAt: T0,
    })).toBe(true)
    expect(await recordCompactionRun(store.connection, {
      sessionId: 's-2',
      compactionId: 'c-2',
      configSnapshot: { other: true },
      startedAt: T0,
    })).toBe(false)
  })
})

describe('档位落账（Story 8.4 / T4、矩阵行 6）', () => {
  const readRun = async (sessionId: string, compactionId: string) => {
    const rows = await queryRows(
      store.connection,
      `MATCH (r:compaction_run {id: $id}) RETURN r.${COMPACTION_TIER_COLUMN} AS tier, ` +
      `r.${COMPACTION_PLAN_JSON_COLUMN} AS plan_json, r.${COMPACTION_DELEGATE_COLUMN} AS delegate`,
      { id: compactionRunId(sessionId, compactionId) },
    )
    return rows[0]
  }

  it('有 plan：tier / plan_json / delegate 三列都落库', async () => {
    const plan = { tier: 'T2' as const, reason: 'mid-band', tokens: 2500, delegate: 'stock' as const }
    await ingestCompactionSummary(store.connection, {
      payload: payload({ sessionId: 's-plan', compactionId: 'c-plan' }),
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      nowIso: T0,
      plan,
    })
    const row = await readRun('s-plan', 'c-plan')
    expect(row?.tier).toBe('T2')
    expect(row?.delegate).toBe('stock')
    expect(JSON.parse(String(row?.plan_json))).toEqual(plan)
  })

  it('无 plan（矩阵行 6）：三列均为 NULL，不编造档位', async () => {
    await ingestCompactionSummary(store.connection, {
      payload: payload({ sessionId: 's-noplan', compactionId: 'c-noplan' }),
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      nowIso: T0,
    })
    const row = await readRun('s-noplan', 'c-noplan')
    expect(row?.tier).toBeNull()
    expect(row?.plan_json).toBeNull()
    expect(row?.delegate).toBeNull()
  })

  it('recordCompactionRun 显式 plan=null 与省略等价（都是 NULL）', async () => {
    await recordCompactionRun(store.connection, {
      sessionId: 's-null',
      compactionId: 'c-null',
      configSnapshot: SNAPSHOT,
      startedAt: T0,
      plan: null,
    })
    const row = await readRun('s-null', 'c-null')
    expect(row?.tier).toBeNull()
    expect(row?.plan_json).toBeNull()
    expect(row?.delegate).toBeNull()
  })
})

describe('档位注册表（Story 8.4 / T4：按 sessionId 交接、teardown 复位）', () => {
  it('注册 / 读取 / 覆盖 / 清理 / 整体复位', () => {
    resetCompactionPlans()
    const sessionId = 's-reg'
    expect(readCompactionPlan(sessionId)).toBeNull()

    const plan = { tier: 'T1' as const, reason: 'protected-content', tokens: 10, delegate: 'omw-t1-fold' as const }
    registerCompactionPlan(sessionId, plan)
    expect(readCompactionPlan(sessionId)).toEqual(plan)

    // 同会话新一轮覆盖旧记录（不等同于历史账本：历史在 compaction_run 里）。
    const next = { tier: 'T3' as const, reason: 't3-candidate', tokens: 9000, delegate: 'stock' as const }
    registerCompactionPlan(sessionId, next)
    expect(readCompactionPlan(sessionId)).toEqual(next)

    clearCompactionPlan(sessionId)
    expect(readCompactionPlan(sessionId)).toBeNull()

    // 空会话 id 不可归属：写入被忽略、读取为 null。
    registerCompactionPlan('', next)
    expect(readCompactionPlan('')).toBeNull()
  })

  it('判据注册：未注册 = null（引擎 fail-closed 到 T1），注册后可读，复位后清空', () => {
    resetCompactionPlans()
    expect(getCompactionCriteria()).toBeNull()
    registerCompactionCriteria({ lengthMin: 1200, t3Threshold: 8000 })
    expect(getCompactionCriteria()).toEqual({ lengthMin: 1200, t3Threshold: 8000 })
    resetCompactionPlans()
    expect(getCompactionCriteria()).toBeNull()
    // 防御式拷贝：注册后再改入参对象不影响已注册值。
    const source = { lengthMin: 500, t3Threshold: 4000 }
    registerCompactionCriteria(source)
    source.lengthMin = 999
    expect(getCompactionCriteria()?.lengthMin).toBe(500)
    resetCompactionPlans()
  })

  it('接线端到端：start 清旧档位 → summarize 登记 → summary 落进 compaction_run', async () => {
    resetCompactionPlans()
    const sessionId = 's-wire-plan'
    registerCompactionPlan(sessionId, { tier: 'T3', reason: 'stale', tokens: 1, delegate: 'stock' })
    const wiring = createCompactionWiring({
      getConnection: () => store.connection,
      configSnapshot: () => SNAPSHOT,
      orphanTimeoutMs: 60_000,
      onOrphan: () => {},
      now: () => new Date(T0),
    })
    // compaction/start：同一会话的新一轮不得复用上一轮的档位。
    await wiring.handleEvent({ id: sessionId }, { type: 'compaction/start', payload: { turn: 1 } })
    expect(readCompactionPlan(sessionId)).toBeNull()

    // 本轮 `summarize()` 登记 T1；summary 事件按它落账。
    registerCompactionPlan(sessionId, { tier: 'T1', reason: 'protected-content', tokens: 42, delegate: 'omw-t1-fold' })
    await wiring.handleEvent({ id: sessionId }, {
      type: 'compaction/summary',
      payload: { compactionId: 'c-wire', summary: '折叠正文', shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 } },
    })
    const row = await queryRows(
      store.connection,
      `MATCH (r:compaction_run {id: $id}) RETURN r.${COMPACTION_TIER_COLUMN} AS tier, ` +
      `r.${COMPACTION_DELEGATE_COLUMN} AS delegate, r.${COMPACTION_PLAN_JSON_COLUMN} AS plan_json`,
      { id: compactionRunId(sessionId, 'c-wire') },
    )
    expect(row[0]?.tier).toBe('T1')
    expect(row[0]?.delegate).toBe('omw-t1-fold')
    expect(row[0]?.plan_json).toContain('protected-content')
    wiring.stop()
    resetCompactionPlans()
  })
})

describe('compaction/start 孤儿检测（AC:1541-1544、INV-6）', () => {
  it('配对（end）⇒ 超时回调不触发', () => {
    const orphans: OrphanInfo[] = []
    let timerCallback: (() => void) | null = null
    const tracker = createOrphanTracker({
      onOrphan: (info) => orphans.push(info),
      setTimer: (callback) => { timerCallback = callback; return 1 },
      clearTimer: () => { timerCallback = null },
    })
    tracker.noteStart('s-1', { turn: 2 })
    expect(tracker.isPending('s-1')).toBe(true)
    tracker.noteEnd('s-1')
    expect(tracker.isPending('s-1')).toBe(false)
    expect(timerCallback).toBeNull()
    expect(orphans).toEqual([])
  })

  it('未配对 ⇒ 到点回调一次，且回调后不再 pending', () => {
    const orphans: OrphanInfo[] = []
    let timerCallback: (() => void) | null = null
    const tracker = createOrphanTracker({
      onOrphan: (info) => orphans.push(info),
      now: () => 1_000,
      setTimer: (callback) => { timerCallback = callback; return 1 },
      clearTimer: () => { timerCallback = null },
    })
    tracker.noteStart('s-1', { turn: null })
    expect(timerCallback).not.toBeNull()
    const fire = timerCallback as unknown as () => void
    fire()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]?.sessionId).toBe('s-1')
    expect(orphans[0]?.turn).toBeNull()
    expect(tracker.pendingCount()).toBe(0)
    // 再触发一次不会重复回调（已 delete）
    fire()
    expect(orphans).toHaveLength(1)
  })

  it('重复 start 同会话 ⇒ 替换并取消旧定时器（不会双报）', () => {
    const cleared: unknown[] = []
    const tracker = createOrphanTracker({
      onOrphan: () => {},
      setTimer: () => ({ id: Symbol('t') }),
      clearTimer: (handle) => { cleared.push(handle) },
    })
    tracker.noteStart('s-1', { turn: 1 })
    tracker.noteStart('s-1', { turn: 2 })
    expect(cleared).toHaveLength(1)
    expect(tracker.pendingCount()).toBe(1)
  })

  it('默认超时 = 60s（与 AD-6 lease 同量级）', () => {
    expect(COMPACTION_ORPHAN_TIMEOUT_MS).toBe(60_000)
  })

  it('stop() 清掉全部定时器', () => {
    const tracker = createOrphanTracker({
      onOrphan: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    })
    tracker.noteStart('a', { turn: 1 })
    tracker.noteStart('b', { turn: 2 })
    expect(tracker.pendingCount()).toBe(2)
    tracker.stop()
    expect(tracker.pendingCount()).toBe(0)
  })

  it('parseCompactionStart：number/null/undefined/非整数/非对象', () => {
    expect(parseCompactionStart({ turn: 3 })).toEqual({ turn: 3, note: null })
    expect(parseCompactionStart({ turn: null })).toEqual({ turn: null, note: null })
    expect(parseCompactionStart({})).toEqual({ turn: null, note: null })
    expect(parseCompactionStart({ turn: 1.5 })).toEqual({ turn: null, note: 'turn-not-integer' })
    expect(parseCompactionStart('nope')).toEqual({ turn: null, note: 'payload-not-object' })
  })
})

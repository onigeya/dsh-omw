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
  compactionRunId,
  ingestCompactionSummary,
  recordCompactionRun,
} from '../src/context/compaction-ingest'
import {
  COMPACTION_ORPHAN_TIMEOUT_MS,
  createOrphanTracker,
  parseCompactionStart,
  type OrphanInfo,
} from '../src/context/compaction-orphan'
import { cleanupTempDirs, makeTempDir } from './tmp'

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

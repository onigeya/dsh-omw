/**
 * 三钩子采集器真库测试（Story 2.1 / AC①-③⑤、FR-2）。
 *
 * 覆盖 spec intent-contract 的 I/O & Edge-Case Matrix：step 阈值达成、step 期间已采集、
 * compaction/start 同步快照、turn/end 正常/合成 closer/重复、库未就绪。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-inbox-queue.test.ts。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCaptureRecorder, type CaptureRecorder } from '../src/capture/recorder'
import { listSnapshots } from '../src/capture/snapshot-store'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { captureStableKey, l0RawId, writeL0Raw } from '../src/db/l0'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { runInTransaction } from '../src/db/transaction'
import { drainInboxBackgroundTasks } from '../src/inbox/consumer'
import { writeInboxItem } from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let snapshotDir: string
let store: MemoryDatabase

beforeAll(async () => {
  dir = await makeTempDir('omw-capture-')
  snapshotDir = join(dir, 'memory', 'capture')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

type RecorderOptions = Parameters<typeof createCaptureRecorder>[0]

function makeRecorder(overrides: Partial<RecorderOptions> = {}): CaptureRecorder {
  return createCaptureRecorder({
    connection: () => store.connection,
    captureSteps: 2,
    snapshotDir,
    logger: { warn: () => {}, info: () => {} },
    ...overrides,
  })
}

async function l0Row(kind: string, sessionId: string, ref: string): Promise<Record<string, unknown> | undefined> {
  const id = l0RawId(captureStableKey(kind, sessionId, ref))
  const rows = await queryAll(
    store.connection,
    "MATCH (l:l0_raw) WHERE l.id = '" + id + "' " +
    'RETURN l.id AS id, l.raw_text AS raw_text, l.recorded_at AS recorded_at, l.actor AS actor',
  )
  return rows[0]
}

async function inboxRow(sessionId: string, ref: string): Promise<Record<string, unknown> | undefined> {
  const id = l0RawId(captureStableKey('compaction', sessionId, ref))
  const rows = await queryAll(
    store.connection,
    "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' " +
    'RETURN q.id AS id, q.payload AS payload, q.status AS status, q.session_id AS session_id, q.kind AS kind',
  )
  return rows[0]
}

describe('AC①：step/end 步数阈值', () => {
  it('满 N：同事务写 1 行 L0 + 1 行 INBOX，且计数器清零', async () => {
    const recorder = makeRecorder({ captureSteps: 2 })
    const session = { id: 'cap-step', deriveMessages: () => [{ role: 'user', content: '第一轮' }] }
    recorder.recordStepEnd(session, { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } })
    recorder.recordStepEnd(session, { type: 'step/end', seq: 2, time: 0, data: { turn: 1, step: 2 } })
    await drainInboxBackgroundTasks()

    const l0 = await l0Row('step', 'cap-step', '1:2')
    expect(l0?.raw_text).toBe('user: 第一轮')
    expect(l0?.actor).toBe('cap-step')
    expect(typeof l0?.recorded_at).toBe('string')
    expect(String(l0?.recorded_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const inboxId = l0RawId(captureStableKey('step', 'cap-step', '1:2'))
    const inbox = (await queryAll(
      store.connection,
      "MATCH (q:l1_inbox) WHERE q.id = '" + inboxId + "' RETURN q.status AS status, q.payload AS payload, q.session_id AS session_id, q.kind AS kind",
    ))[0]
    expect(inbox?.status).toBe('pending')
    expect(inbox?.payload).toBe('user: 第一轮')
    expect(inbox?.session_id).toBe('cap-step')
    expect(inbox?.kind).toBe('step')

    // 未达阈值的 step 1 不写；清零后单次 step 也不写。
    expect(await l0Row('step', 'cap-step', '1:1')).toBeUndefined()
    recorder.recordStepEnd(session, { type: 'step/end', seq: 3, time: 0, data: { turn: 1, step: 3 } })
    await drainInboxBackgroundTasks()
    expect(await l0Row('step', 'cap-step', '1:3')).toBeUndefined()
  })

  it('计数期间发生 turn/end 采集 → 计数器清零，不写 step 行（AC①「期间无其他采集」）', async () => {
    const recorder = makeRecorder({ captureSteps: 2 })
    const session = { id: 'cap-reset', deriveMessages: () => [{ role: 'user', content: 'x' }] }
    recorder.recordStepEnd(session, { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } })
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 5, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    recorder.recordStepEnd(session, { type: 'step/end', seq: 4, time: 0, data: { turn: 2, step: 1 } })
    await drainInboxBackgroundTasks()

    expect(await l0Row('step', 'cap-reset', '1:1')).toBeUndefined()
    expect(await l0Row('step', 'cap-reset', '2:1')).toBeUndefined()
    expect(await l0Row('turn', 'cap-reset', '1')).toBeDefined()
  })
})

describe('AC③：turn/end 采集', () => {
  it('正常 turn/end：先 await flush 再写；reason 为字符串也接受', async () => {
    const flush = vi.fn(async () => undefined)
    const recorder = makeRecorder({ flush })
    const session = { id: 'cap-flush', deriveMessages: () => [{ role: 'user', content: '轮末' }] }
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 6, time: 0, data: { turn: 1, reason: 'stop' } })
    await drainInboxBackgroundTasks()

    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]?.[0]).toBe(session)
    expect((await l0Row('turn', 'cap-flush', '1'))?.raw_text).toBe('user: 轮末')
  })

  it('同 (sessionId, turn) 重复 / 更小 turn → 不重复采集（每轮至多一次）', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-dedupe', deriveMessages: () => [{ role: 'user', content: 'once' }] }
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 7, time: 0, data: { turn: 5, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 7, time: 0, data: { turn: 5, reason: { kind: 'completed' } } })
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 8, time: 0, data: { turn: 4, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'cap-dedupe' RETURN l.id AS id")
    expect(rows).toHaveLength(1)
  })

  it('合成 closer（interrupted / forked）跳过', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-synth', deriveMessages: () => [{ role: 'user', content: 'nope' }] }
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 9, time: 0, data: { turn: 1, reason: { kind: 'interrupted' } } })
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 10, time: 0, data: { turn: 2, reason: { kind: 'forked' } } })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'cap-synth' RETURN l.id AS id")
    expect(rows).toHaveLength(0)
  })
})

describe('AC②：compaction/start 同步快照', () => {
  it('监听器返回时快照已 rename 落盘；落库成功后快照删除，L0+INBOX 同一事务可见', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-compact', deriveMessages: () => [{ role: 'assistant', content: '压缩前' }] }
    recorder.recordCompactionStart(session, { type: 'compaction/start', seq: 11, time: 0, data: { compactionId: 'c-1', turn: 3 } })

    // 同步路径：不 await 任何东西，快照文件必须已经在。
    const stableKey = captureStableKey('compaction', 'cap-compact', 'c-1')
    expect(listSnapshots(snapshotDir).some((record) => record.stableKey === stableKey)).toBe(true)
    expect(await l0Row('compaction', 'cap-compact', 'c-1')).toBeUndefined()

    await drainInboxBackgroundTasks()
    expect(listSnapshots(snapshotDir).some((record) => record.stableKey === stableKey)).toBe(false)
    expect((await l0Row('compaction', 'cap-compact', 'c-1'))?.raw_text).toBe('assistant: 压缩前')
    expect((await inboxRow('cap-compact', 'c-1'))?.kind).toBe('compaction')
  })

  it('compactionId 缺失时用 turn 兜底身份', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-manual', deriveMessages: () => [{ role: 'user', content: 'm' }] }
    recorder.recordCompactionStart(session, { type: 'compaction/start', seq: 12, time: 0, data: { turn: null } })
    await drainInboxBackgroundTasks()
    expect(await l0Row('compaction', 'cap-manual', 'turn-manual')).toBeDefined()
  })
})

describe('失败兜底：绝不抛给宿主', () => {
  it('快照写入失败只 warn，不抛（压缩主路径放行）', () => {
    const warn = vi.fn()
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    const recorder = makeRecorder({ snapshotDir: blocker, logger: { warn, info: () => {} } })
    const session = { id: 'cap-boom', deriveMessages: () => [{ role: 'user', content: 'x' }] }
    expect(() => recorder.recordCompactionStart(session, { type: 'compaction/start', seq: 13, time: 0, data: { compactionId: 'c-boom' } })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('库未就绪（connection 为 null）：采集放弃、不抛、记 warn', async () => {
    const warn = vi.fn()
    const recorder = makeRecorder({ connection: () => null, captureSteps: 1, logger: { warn, info: () => {} } })
    const session = { id: 'cap-nodb', deriveMessages: () => [{ role: 'user', content: 'x' }] }
    expect(() => recorder.recordStepEnd(session, { type: 'step/end', seq: 1, time: 0, data: { turn: 1, step: 1 } })).not.toThrow()
    await drainInboxBackgroundTasks()
    expect(warn).toHaveBeenCalled()
    expect(await l0Row('step', 'cap-nodb', '1:1')).toBeUndefined()
  })
})

describe('评审补丁回归钉（T1/T2 事件信封、P4 去重时序、P9 失败注入）', () => {
  it('P2：同一 session 连续两次采集（真信封 type/seq/time/data）→ L0 与 INBOX 各 2 行，ref 来自 data', async () => {
    const recorder = makeRecorder({ captureSteps: 1 })
    const session = { id: 'cap-envelope', deriveMessages: () => [{ role: 'user', content: '信封' }] }
    recorder.recordStepEnd(session, { type: 'step/end', seq: 21, time: 0, data: { turn: 1, step: 1 } })
    recorder.recordStepEnd(session, { type: 'step/end', seq: 22, time: 0, data: { turn: 2, step: 1 } })
    await drainInboxBackgroundTasks()

    // 顶层读法会得到 '?:?'，两次采集会撞成同一 id（MERGE 变 no-op）——这里两行都必须真落库。
    expect(await l0Row('step', 'cap-envelope', '1:1')).toBeDefined()
    expect(await l0Row('step', 'cap-envelope', '2:1')).toBeDefined()
    expect(await l0Row('step', 'cap-envelope', '?:?')).toBeUndefined()
    const l0Rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'cap-envelope' RETURN l.id AS id")
    expect(l0Rows).toHaveLength(2)
    const inboxRows = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.session_id = 'cap-envelope' RETURN q.id AS id")
    expect(inboxRows).toHaveLength(2)
  })

  it('P3：turn/end 的文本在 flush 之前取（flush 之后会话推进也不影响本次快照内容）', async () => {
    let messages = [{ role: 'user', content: '本轮原文' }]
    const flush = vi.fn(async () => { messages = [{ role: 'user', content: '下一轮污染' }] })
    const recorder = makeRecorder({ flush })
    const session = { id: 'cap-p3', deriveMessages: () => messages }
    recorder.recordTurnEnd(session, { type: 'turn/end', seq: 30, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    expect((await l0Row('turn', 'cap-p3', '1'))?.raw_text).toBe('user: 本轮原文')
  })

  it('P4：落库失败不推进 lastTurn —— 同一 (sessionId, turn) 再到达会重试采集', async () => {
    const warn = vi.fn()
    let connection: MemoryDatabase['connection'] | null = null
    const recorder = makeRecorder({ connection: () => connection, logger: { warn, info: () => {} } })
    const session = { id: 'cap-retry', deriveMessages: () => [{ role: 'user', content: '重试' }] }
    const event = { type: 'turn/end', seq: 40, time: 0, data: { turn: 7, reason: { kind: 'completed' } } }
    recorder.recordTurnEnd(session, event)
    await drainInboxBackgroundTasks()
    expect(warn).toHaveBeenCalled()
    expect(await l0Row('turn', 'cap-retry', '7')).toBeUndefined()

    connection = store.connection
    recorder.recordTurnEnd(session, event)
    await drainInboxBackgroundTasks()
    expect((await l0Row('turn', 'cap-retry', '7'))?.raw_text).toBe('user: 重试')
  })

  it('P5：空文本（trim 后）不写 L0、不落快照，只记 warn', async () => {
    const warn = vi.fn()
    const emptyDir = join(dir, 'memory', 'capture-empty')
    const recorder = makeRecorder({ captureSteps: 1, snapshotDir: emptyDir, logger: { warn, info: () => {} } })
    const session = { id: 'cap-empty', deriveMessages: () => [] }
    recorder.recordStepEnd(session, { type: 'step/end', seq: 50, time: 0, data: { turn: 1, step: 1 } })
    recorder.recordCompactionStart(session, { type: 'compaction/start', seq: 51, time: 0, data: { compactionId: 'c-empty' } })
    await drainInboxBackgroundTasks()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(await l0Row('step', 'cap-empty', '1:1')).toBeUndefined()
    expect(listSnapshots(emptyDir)).toHaveLength(0)
  })

  it('P9②：compaction 落库失败 → 快照文件保留（标记未删）且记 warn', async () => {
    const warn = vi.fn()
    const recorder = makeRecorder({ connection: () => null, logger: { warn, info: () => {} } })
    const session = { id: 'cap-snapkeep', deriveMessages: () => [{ role: 'user', content: '保住' }] }
    recorder.recordCompactionStart(session, { type: 'compaction/start', seq: 60, time: 0, data: { compactionId: 'c-keep', turn: 4 } })
    await drainInboxBackgroundTasks()
    const stableKey = captureStableKey('compaction', 'cap-snapkeep', 'c-keep')
    expect(listSnapshots(snapshotDir).some((record) => record.stableKey === stableKey)).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  it('P9①：L0 与 INBOX 同事务 —— 两条语句都执行后失败 ⇒ 两行都不存在（FR-2 原子性）', async () => {
    const stableKey = captureStableKey('turn', 'cap-atomic', '1')
    await expect(runInTransaction(store.connection, async () => {
      await writeL0Raw(store.connection, { id: l0RawId(stableKey), text: '不该留下', actor: 'cap-atomic' })
      await writeInboxItem(store.connection, { id: l0RawId(stableKey), payload: '不该留下', sessionId: 'cap-atomic', kind: 'turn' })
      throw new Error('注入失败：两条语句之间')
    })).rejects.toThrow('注入失败')
    expect(await l0Row('turn', 'cap-atomic', '1')).toBeUndefined()
    const inbox = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + l0RawId(stableKey) + "' RETURN q.id AS id")
    expect(inbox).toHaveLength(0)
  })

  it('评审 T1：同一次采集在 L0 与 INBOX 用同一个 id，该 id 能在 l0_raw 命中', async () => {
    const recorder = makeRecorder({ captureSteps: 1 })
    const session = { id: 'cap-unify', deriveMessages: () => [{ role: 'user', content: '统一身份' }] }
    recorder.recordStepEnd(session, { type: 'step/end', seq: 90, time: 0, data: { turn: 9, step: 1 } })
    await drainInboxBackgroundTasks()

    const id = l0RawId(captureStableKey('step', 'cap-unify', '9:1'))
    const l0 = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.id = '" + id + "' RETURN l.id AS id")
    const inbox = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' RETURN q.id AS id")
    expect(l0).toHaveLength(1)
    expect(inbox).toHaveLength(1)
    expect(String(l0[0]?.id)).toBe(String(inbox[0]?.id))
  })
})

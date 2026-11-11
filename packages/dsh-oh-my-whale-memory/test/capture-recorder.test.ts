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
import { captureStableKey, l0InboxId, l0RawId } from '../src/db/l0'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { drainInboxBackgroundTasks } from '../src/inbox/consumer'
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
  const id = l0InboxId(captureStableKey('compaction', sessionId, ref))
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
    recorder.recordStepEnd(session, { type: 'step/end', turn: 1, step: 1 })
    recorder.recordStepEnd(session, { type: 'step/end', turn: 1, step: 2 })
    await drainInboxBackgroundTasks()

    const l0 = await l0Row('step', 'cap-step', '1:2')
    expect(l0?.raw_text).toBe('user: 第一轮')
    expect(l0?.actor).toBe('cap-step')
    expect(typeof l0?.recorded_at).toBe('string')
    expect(String(l0?.recorded_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const inboxId = l0InboxId(captureStableKey('step', 'cap-step', '1:2'))
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
    recorder.recordStepEnd(session, { type: 'step/end', turn: 1, step: 3 })
    await drainInboxBackgroundTasks()
    expect(await l0Row('step', 'cap-step', '1:3')).toBeUndefined()
  })

  it('计数期间发生 turn/end 采集 → 计数器清零，不写 step 行（AC①「期间无其他采集」）', async () => {
    const recorder = makeRecorder({ captureSteps: 2 })
    const session = { id: 'cap-reset', deriveMessages: () => [{ role: 'user', content: 'x' }] }
    recorder.recordStepEnd(session, { type: 'step/end', turn: 1, step: 1 })
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
    recorder.recordStepEnd(session, { type: 'step/end', turn: 2, step: 1 })
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
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 1, reason: 'stop' })
    await drainInboxBackgroundTasks()

    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]?.[0]).toBe(session)
    expect((await l0Row('turn', 'cap-flush', '1'))?.raw_text).toBe('user: 轮末')
  })

  it('同 (sessionId, turn) 重复 / 更小 turn → 不重复采集（每轮至多一次）', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-dedupe', deriveMessages: () => [{ role: 'user', content: 'once' }] }
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })
    await drainInboxBackgroundTasks()
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 4, reason: { kind: 'completed' } })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'cap-dedupe' RETURN l.id AS id")
    expect(rows).toHaveLength(1)
  })

  it('合成 closer（interrupted / forked）跳过', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-synth', deriveMessages: () => [{ role: 'user', content: 'nope' }] }
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 1, reason: { kind: 'interrupted' } })
    recorder.recordTurnEnd(session, { type: 'turn/end', turn: 2, reason: { kind: 'forked' } })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = 'cap-synth' RETURN l.id AS id")
    expect(rows).toHaveLength(0)
  })
})

describe('AC②：compaction/start 同步快照', () => {
  it('监听器返回时快照已 rename 落盘；落库成功后快照删除，L0+INBOX 同一事务可见', async () => {
    const recorder = makeRecorder()
    const session = { id: 'cap-compact', deriveMessages: () => [{ role: 'assistant', content: '压缩前' }] }
    recorder.recordCompactionStart(session, { type: 'compaction/start', compactionId: 'c-1', turn: 3 })

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
    recorder.recordCompactionStart(session, { type: 'compaction/start', turn: null })
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
    expect(() => recorder.recordCompactionStart(session, { type: 'compaction/start', compactionId: 'c-boom' })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('库未就绪（connection 为 null）：采集放弃、不抛、记 warn', async () => {
    const warn = vi.fn()
    const recorder = makeRecorder({ connection: () => null, captureSteps: 1, logger: { warn, info: () => {} } })
    const session = { id: 'cap-nodb', deriveMessages: () => [{ role: 'user', content: 'x' }] }
    expect(() => recorder.recordStepEnd(session, { type: 'step/end', turn: 1, step: 1 })).not.toThrow()
    await drainInboxBackgroundTasks()
    expect(warn).toHaveBeenCalled()
    expect(await l0Row('step', 'cap-nodb', '1:1')).toBeUndefined()
  })
})

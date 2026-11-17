/**
 * L0 指针化采集 + token 触发（Story 10.1 / 矩阵行 1–6、9）。真库、1 次开库。
 *
 * 覆盖：pointer 行幂等与列形态、token 触发写 INBOX、重复边界不重复计、
 * 缺 tokenMeter 的 captureSteps 降级、缺 sessionPersistence 的 inline 回退、status 的采集模式。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCaptureRecorder, type CaptureRecorder } from '../src/capture/recorder'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { readMetaValue } from '../src/db/meta'
import { drainInboxBackgroundTasks } from '../src/inbox/consumer'
import { checkReachableToL0, checkRefReachableToL0 } from '../src/db/eii'
import { writeEvidenceEdges } from '../src/db/edges'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase
let captureDir = ''

beforeAll(async () => {
  const dir = await makeTempDir('omw-capture-pointer-')
  captureDir = dir
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

const SESSION_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '你好' }] },
  { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
]

function makeSession(id: string): { id: string, deriveMessages: () => readonly unknown[] } {
  return { id, deriveMessages: () => SESSION_MESSAGES }
}

function messageEvent(type: string, seq: number): unknown {
  return { type, seq, time: 0, data: { message: { content: [{ type: 'text', text: 'x' }] } } }
}

type RecorderOptions = Parameters<typeof createCaptureRecorder>[0]

function makeRecorder(overrides: Partial<RecorderOptions> = {}): CaptureRecorder {
  return createCaptureRecorder({
    connection: () => store.connection,
    captureSteps: 2,
    snapshotDir: captureDir,
    logger: { warn: () => {} },
    pointer: {
      available: true,
      tokenMeter: {
        measure: () => ({ nodes: [{ seq: 0, tokens: 9000 }] }),
      },
      thresholds: { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 },
    },
    ...overrides,
  })
}

async function count(statement: string): Promise<number> {
  const rows = await queryAll(store.connection, statement)
  return Number(rows[0]?.total ?? 0)
}

describe('指针行（矩阵行 1–3）', () => {
  it('消息事件在下一边界写成 pointer 行：raw_text NULL、seq/event_type/actor 齐全；同 seq 重放不新增', async () => {
    const recorder = makeRecorder()
    const session = makeSession('s-pointer')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordMessage(session, messageEvent('assistant/message', 1))
    // 非 text part 不进 L0。
    recorder.recordMessage(session, { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'image', url: 'x' }] } } })
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const rows = await queryAll(
      store.connection,
      "MATCH (l:l0_raw) WHERE l.actor = 's-pointer' RETURN l.id AS id, l.raw_text AS raw_text, l.seq AS seq, l.event_type AS event_type ORDER BY l.seq",
    )
    expect(rows.map((row) => ({ seq: Number(row.seq), type: String(row.event_type), raw: row.raw_text }))).toEqual([
      { seq: 0, type: 'user/message', raw: null },
      { seq: 1, type: 'assistant/message', raw: null },
    ])

    // 同 seq 重放（直接再走一次边界）不新增行。
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordStepEnd(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    await drainInboxBackgroundTasks()
    expect(await count("MATCH (l:l0_raw) WHERE l.actor = 's-pointer' RETURN count(l) AS total")).toBe(2)
  })
})

describe('token 触发（矩阵行 4–6）', () => {
  it('累计 ≥ captureTokens ⇒ 写 INBOX；同一批 nodes 再来一次不重复触发', async () => {
    const recorder = makeRecorder()
    const session = makeSession('s-token')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    expect(await count("MATCH (i:l1_inbox {session_id: 's-token'}) RETURN count(i) AS total")).toBe(1)

    // 同批 nodes 再触发：lastSeq 已推进 ⇒ 无新 token，不写第二条。
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    expect(await count("MATCH (i:l1_inbox {session_id: 's-token'}) RETURN count(i) AS total")).toBe(1)
    const state = await readMetaValue(store.connection, 'capture_token_ledger:s-token')
    expect(state).toBe('0:0')
  })

  it('captureTokens 以下只累计；第二边界凑够再触发', async () => {
    let tokens = 0
    const recorder = makeRecorder({
      pointer: {
        available: true,
        tokenMeter: { measure: () => ({ nodes: [{ seq: tokens === 0 ? 0 : 1, tokens: 4000 }] }) },
        thresholds: { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 },
      },
    })
    const session = makeSession('s-acc')
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    expect(await count("MATCH (i:l1_inbox {session_id: 's-acc'}) RETURN count(i) AS total")).toBe(0)
    tokens = 1
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()
    expect(await count("MATCH (i:l1_inbox {session_id: 's-acc'}) RETURN count(i) AS total")).toBe(1)
  })
})

describe('降级路径（矩阵行 7–8）', () => {
  it('tokenMeter 缺失 ⇒ captureSteps 连续步数触发；captureMode=steps(degraded)', async () => {
    const recorder = makeRecorder({
      captureSteps: 1,
      pointer: {
        available: true,
        tokenMeter: null,
        thresholds: { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 },
      },
    })
    expect(recorder.captureMode()).toEqual({ trigger: 'steps(degraded)', persistence: 'available' })
    const session = makeSession('s-steps')
    recorder.recordStepEnd(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    await drainInboxBackgroundTasks()
    const rows = await queryAll(store.connection, "MATCH (i:l1_inbox {session_id: 's-steps'}) RETURN i.id AS id")
    expect(rows.length).toBe(1)
  })

  it('sessionPersistence 缺失 ⇒ inline 快照回退（raw_text 非空）；captureMode 标 unavailable', async () => {
    const recorder = makeRecorder({
      captureSteps: 1,
      pointer: {
        available: false,
        tokenMeter: null,
        thresholds: { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 },
      },
    })
    expect(recorder.captureMode()).toEqual({ trigger: 'steps(degraded)', persistence: 'unavailable' })
    const session = makeSession('s-inline')
    recorder.recordStepEnd(session, { type: 'step/end', data: { turn: 1, step: 1 } })
    await drainInboxBackgroundTasks()
    const rows = await queryAll(
      store.connection,
      "MATCH (l:l0_raw) WHERE l.actor = 's-inline' RETURN l.raw_text AS raw_text, l.seq AS seq",
    )
    expect(rows.length).toBe(1)
    expect(String(rows[0]?.raw_text)).toContain('user: 你好')
    expect(rows[0]?.seq).toBe(null)
  })
})



describe('EII（矩阵行 5）：pointer 行参与可达性', () => {
  it('pointer 行 → EVIDENCE → L1 可达；墓碑（两者皆空）不可达', async () => {
    const recorder = makeRecorder()
    const session = makeSession('s-eii')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const pointer = await queryAll(
      store.connection,
      "MATCH (l:l0_raw) WHERE l.actor = 's-eii' RETURN l.id AS id",
    )
    const pointerId = String(pointer[0]?.id)
    const memory = await store.upsertMemory({ layer: 'L1', text: 'pointer 可达性事实' })
    await writeEvidenceEdges(store.connection, [
      { fromId: pointerId, fromLayer: 'L0', toId: memory.id, toLayer: 'L1', reason: 'ev-pointer' },
    ])
    const reachable = await checkReachableToL0(store.connection, memory.id, new Date().toISOString())
    expect(reachable.pass).toBe(true)

    // 墓碑：raw_text 与 seq 都为空。
    await store.connection.query(
      "CREATE (l:l0_raw {id: 'tomb-10-1', recorded_at: '2026-11-17T00:00:00.000Z', actor: 'system'})",
    )
    const tomb = await checkRefReachableToL0(store.connection, 'tomb-10-1', new Date().toISOString())
    expect(tomb.pass).toBe(false)
  })
})

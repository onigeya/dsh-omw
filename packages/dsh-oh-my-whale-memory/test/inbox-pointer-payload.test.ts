/**
 * INBOX 指针 payload（Story 10.2 / AC：payload 为 JSON 指针、长度 O(1)；旧文本兼容读；
 * 超 `captureMaxTokens` 按事件边界切片、单事件超限独立成单标 oversize）。
 *
 * 真库（dim=4，1 次开库）+ 脚本化 tokenMeter。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCaptureRecorder } from '../src/capture/recorder'
import { slicePointerEvents, type PendingPointerEvent } from '../src/capture/token-ledger'
import { countPointerAudits } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { l0PointerId } from '../src/db/l0'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { drainInboxBackgroundTasks } from '../src/inbox/consumer'
import {
  formatInboxPointerPayload,
  parseInboxPointerPayload,
  type InboxPointerPayload,
} from '../src/inbox/queue'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase
let captureDir = ''

beforeAll(async () => {
  const dir = await makeTempDir('omw-inbox-pointer-')
  captureDir = dir
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

const SESSION_MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '机密正文-甲' }] },
  { role: 'assistant', content: [{ type: 'text', text: '机密正文-乙' }] },
]

function makeSession(id: string): { id: string, deriveMessages: () => readonly unknown[] } {
  return { id, deriveMessages: () => SESSION_MESSAGES }
}

function messageEvent(type: string, seq: number): unknown {
  return { type, seq, time: 0, data: { message: { content: [{ type: 'text', text: 'x' }] } } }
}

type RecorderOptions = Parameters<typeof createCaptureRecorder>[0]

function makeRecorder(
  nodes: readonly { seq: number, tokens?: number, heuristicTokens?: number }[],
  thresholds = { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 },
): ReturnType<typeof createCaptureRecorder> {
  const options: RecorderOptions = {
    connection: () => store.connection,
    captureSteps: 2,
    snapshotDir: captureDir,
    logger: { warn: () => {} },
    pointer: {
      available: true,
      tokenMeter: { measure: () => ({ nodes }) },
      thresholds,
    },
  }
  return createCaptureRecorder(options)
}

async function inboxRows(sessionId: string): Promise<Array<{ id: string, payload: string }>> {
  const rows = await queryAll(
    store.connection,
    "MATCH (q:l1_inbox) WHERE q.session_id = '" + sessionId + "' RETURN q.id AS id, q.payload AS payload ORDER BY q.id",
  )
  return rows.map((row) => ({ id: String(row.id), payload: String(row.payload ?? '') }))
}

describe('payload 形态与兼容读', () => {
  it('format/parse 往返；payload 只含指针，不含正文字段', () => {
    const payload = formatInboxPointerPayload({
      sessionId: 's-1',
      seqs: [0, 2, 3],
      eventTypes: ['user/message', 'assistant/message', 'tool/result'],
    })
    expect(payload).not.toContain('机密正文')
    const parsed = parseInboxPointerPayload(payload)
    expect(parsed).toEqual<InboxPointerPayload>({
      sessionId: 's-1',
      seqs: [0, 2, 3],
      eventTypes: ['user/message', 'assistant/message', 'tool/result'],
    })
  })

  it('旧文本 payload / 畸形 JSON / 形状不符一律返回 null（兼容读，不判坏条目）', () => {
    expect(parseInboxPointerPayload('用户: 旧文本正文')).toBeNull()
    expect(parseInboxPointerPayload('{ not json')).toBeNull()
    expect(parseInboxPointerPayload('"just a string"')).toBeNull()
    expect(parseInboxPointerPayload(JSON.stringify({ sessionId: '', seqs: [], eventTypes: [] }))).toBeNull()
    expect(parseInboxPointerPayload(JSON.stringify({ sessionId: 's', seqs: [0], eventTypes: [] }))).toBeNull()
    expect(parseInboxPointerPayload(JSON.stringify({ sessionId: 's', seqs: [-1], eventTypes: ['user/message'] }))).toBeNull()
  })
})

describe('采集写指针 payload（真库）', () => {
  it('token 触发 ⇒ payload = {sessionId, seqs[], eventTypes[]}，id 指向首个 pointer L0；不含正文', async () => {
    const recorder = makeRecorder([{ seq: 0, tokens: 9000 }, { seq: 1, tokens: 100 }])
    const session = makeSession('s-payload')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordMessage(session, messageEvent('assistant/message', 1))
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const rows = await inboxRows('s-payload')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(l0PointerId('s-payload', 0))
    expect(rows[0]!.payload).not.toContain('机密正文')
    expect(parseInboxPointerPayload(rows[0]!.payload)).toEqual<InboxPointerPayload>({
      sessionId: 's-payload',
      seqs: [0, 1],
      eventTypes: ['user/message', 'assistant/message'],
    })
    // payload 长度与正文无关：换一段更长的会话，指针仍是同一形状。
    expect(rows[0]!.payload.length).toBeLessThan(200)
  })
})

describe('按事件边界切片（AC：> captureMaxTokens 在事件边界切；单事件超限独立成单）', () => {
  it('两段各 20K（合计 40K > 32K）⇒ 两条条目，各自 [0] / [1]，都不标 oversize', async () => {
    const recorder = makeRecorder([{ seq: 0, tokens: 20000 }, { seq: 1, tokens: 20000 }])
    const session = makeSession('s-slice')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordMessage(session, messageEvent('assistant/message', 1))
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const rows = await inboxRows('s-slice')
    expect(rows).toHaveLength(2)
    const parsed = rows.map((row) => parseInboxPointerPayload(row.payload)!).sort((a, b) => a.seqs[0]! - b.seqs[0]!)
    expect(parsed.map((item) => [...item.seqs])).toEqual([[0], [1]])
    expect(parsed.map((item) => [...item.eventTypes])).toEqual([['user/message'], ['assistant/message']])
    expect(await countPointerAudits(store.connection)).toEqual({ unresolvablePointers: 0, oversizeItems: 0 })
  })

  it('单事件自身超限 ⇒ 独立成单、不吸收后续事件，并写 oversize 审计（status 可见）', async () => {
    const recorder = makeRecorder([{ seq: 0, tokens: 40000 }, { seq: 1, tokens: 1000 }])
    const session = makeSession('s-oversize')
    recorder.recordMessage(session, messageEvent('user/message', 0))
    recorder.recordMessage(session, messageEvent('assistant/message', 1))
    recorder.recordTurnEnd(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drainInboxBackgroundTasks()

    const rows = await inboxRows('s-oversize')
    expect(rows).toHaveLength(2)
    const parsed = rows
      .map((row) => parseInboxPointerPayload(row.payload)!)
      .sort((a, b) => a.seqs[0]! - b.seqs[0]!)
    expect([...parsed[0]!.seqs]).toEqual([0])
    expect([...parsed[1]!.seqs]).toEqual([1])
    expect(await countPointerAudits(store.connection)).toEqual({ unresolvablePointers: 0, oversizeItems: 1 })
    const oversize = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'capture_oversize' RETURN g.reason AS reason",
    )
    expect(oversize).toHaveLength(1)
    expect(String(oversize[0]!.reason)).toContain('s-oversize')
  })

  it('slicePointerEvents：贪心按上限收束，单事件超限自带 oversize 标记', () => {
    const events: PendingPointerEvent[] = [
      { seq: 0, eventType: 'user/message', tokens: 10 },
      { seq: 1, eventType: 'assistant/message', tokens: 10 },
      { seq: 2, eventType: 'tool/result', tokens: 50 },
      { seq: 3, eventType: 'user/message', tokens: 10 },
    ]
    const slices = slicePointerEvents(events, 20)
    expect(slices.map((slice) => ({ seqs: slice.events.map((event) => event.seq), oversize: slice.oversize }))).toEqual([
      { seqs: [0, 1], oversize: false },
      { seqs: [2], oversize: true },
      { seqs: [3], oversize: false },
    ])
    // 无权重（0）时整批成一段：不做无法证明的切分。
    expect(slicePointerEvents(events.map((event) => ({ ...event, tokens: 0 })), 20)).toHaveLength(1)
  })
})

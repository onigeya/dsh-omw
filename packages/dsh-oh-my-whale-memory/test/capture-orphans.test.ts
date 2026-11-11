/**
 * 孤儿快照重放真库测试（Story 2.1 / AC⑤、AD-7）。
 *
 * 关键前提（Lead 裁决）：同一快照必须算出同一 id，否则重放会造出第二条队列条目，
 * 同一段对话被精炼两次——本文件第二条用例把这一点钉死。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCaptureRecorder } from '../src/capture/recorder'
import { listSnapshots, writeSnapshot, type SnapshotRecord } from '../src/capture/snapshot-store'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { captureStableKey, l0InboxId, l0RawId } from '../src/db/l0'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let snapshotDir: string
let store: MemoryDatabase

beforeAll(async () => {
  dir = await makeTempDir('omw-orphans-')
  snapshotDir = join(dir, 'memory', 'capture')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

function makeRecorder(overrides: Partial<Parameters<typeof createCaptureRecorder>[0]> = {}) {
  return createCaptureRecorder({
    connection: () => store.connection,
    captureSteps: 50,
    snapshotDir,
    logger: { warn: () => {}, info: () => {} },
    ...overrides,
  })
}

function recordFor(sessionId: string, ref: string, text: string): SnapshotRecord {
  return {
    stableKey: captureStableKey('compaction', sessionId, ref),
    kind: 'compaction',
    sessionId,
    ref,
    text,
    actor: sessionId,
    recordedAt: '2026-11-11T00:00:00.000Z',
  }
}

async function countL0(sessionId: string): Promise<number> {
  const rows = await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.actor = '" + sessionId + "' RETURN l.id AS id")
  return rows.length
}

describe('AC⑤：启动扫描孤儿快照并重放', () => {
  it('有 .snap 无对应行 → 重放 L0+INBOX（同一事务）并删除标记文件', async () => {
    const recorder = makeRecorder()
    writeSnapshot(snapshotDir, recordFor('orph-1', 'c-orph', 'assistant: 孤儿'))

    const replayed = await recorder.replayOrphanSnapshots()

    expect(replayed).toBe(1)
    const l0Id = l0RawId(captureStableKey('compaction', 'orph-1', 'c-orph'))
    const l0 = (await queryAll(store.connection, "MATCH (l:l0_raw) WHERE l.id = '" + l0Id + "' RETURN l.raw_text AS raw_text, l.recorded_at AS recorded_at"))[0]
    expect(l0?.raw_text).toBe('assistant: 孤儿')
    expect(l0?.recorded_at).toBe('2026-11-11T00:00:00.000Z')

    const inboxId = l0InboxId(captureStableKey('compaction', 'orph-1', 'c-orph'))
    const inbox = (await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + inboxId + "' RETURN q.status AS status, q.payload AS payload"))[0]
    expect(inbox?.status).toBe('pending')
    expect(inbox?.payload).toBe('assistant: 孤儿')

    expect(listSnapshots(snapshotDir).some((record) => record.sessionId === 'orph-1')).toBe(false)
  })

  it('同一快照重放两次：l1_inbox 仍只有一行，且 status/attempts 不被重置', async () => {
    const recorder = makeRecorder()
    const record = recordFor('orph-2', 'c-dup', 'assistant: 重复')
    writeSnapshot(snapshotDir, record)
    await recorder.replayOrphanSnapshots()

    // 模拟该条目已被取走并在重试中：重放不得把它打回 pending、不得清 attempts。
    const inboxId = l0InboxId(record.stableKey)
    await store.connection.query(
      "MATCH (q:l1_inbox) WHERE q.id = '" + inboxId + "' SET q.status = 'processing', q.attempts = 2",
    )

    writeSnapshot(snapshotDir, record)
    const replayed = await recorder.replayOrphanSnapshots()
    expect(replayed).toBe(1)

    const rows = await queryAll(
      store.connection,
      "MATCH (q:l1_inbox) WHERE q.id = '" + inboxId + "' RETURN q.status AS status, q.attempts AS attempts",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('processing')
    expect(Number(rows[0]?.attempts)).toBe(2)
    expect(await countL0('orph-2')).toBe(1)
    expect(listSnapshots(snapshotDir).some((entry) => entry.stableKey === record.stableKey)).toBe(false)
  })

  it('坏快照文件跳过（不影响其它文件、不抛）', async () => {
    const recorder = makeRecorder()
    writeFileSync(join(snapshotDir, 'broken.snap'), '{ not json', 'utf8')
    writeSnapshot(snapshotDir, recordFor('orph-3', 'c-ok', 'ok'))
    const replayed = await recorder.replayOrphanSnapshots()
    expect(replayed).toBe(1)
    expect(await countL0('orph-3')).toBe(1)
  })

  it('库未就绪：返回 0、保留文件、记 warn', async () => {
    const warn = vi.fn()
    const recorder = makeRecorder({ connection: () => null, logger: { warn, info: () => {} } })
    const record = recordFor('orph-4', 'c-nodb', 'x')
    writeSnapshot(snapshotDir, record)
    const replayed = await recorder.replayOrphanSnapshots()
    expect(replayed).toBe(0)
    expect(warn).toHaveBeenCalled()
    expect(await countL0('orph-4')).toBe(0)
  })
})

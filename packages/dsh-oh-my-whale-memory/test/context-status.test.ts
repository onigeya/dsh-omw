/**
 * 上下文 status 两行与 INV-7 判据（Story 8.1 第 3 轮）。
 *
 * - status 渲染：缺省不渲染 / null ⇒ n/a / 有值 ⇒ 逐字段可读 + 和恒等于 total；
 * - `readCompactionStatus`：0 行 ⇒ runs=0；有行 ⇒ 最近一条（按 started_at）。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderMemoryStatus, type MemoryStatusSnapshot } from '../src/command'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import {
  captureAttribution,
  readCompactionStatus,
  shouldWireCompaction,
} from '../src/context/status'
import { recordCompactionRun } from '../src/context/compaction-ingest'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-ctxstatus-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

const BASE: MemoryStatusSnapshot = {
  layers: { L1: 0, L2: 0 },
  inboxes: { L1: 0, L2: 0 },
  failed: 0,
  embeddingMode: 'enabled',
  systemOne: 'enabled',
  unembedded: 0,
  readonly: false,
  auditGap: 0,
  evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
  relatedSkipped: 0,
}

describe('status 的上下文两行（AC:1566-1568）', () => {
  it('缺省（undefined）⇒ 两行都不渲染（既有钉死块不变）', () => {
    const text = renderMemoryStatus(BASE)
    expect(text).not.toContain('context_ledger:')
    expect(text).not.toContain('compaction:')
  })

  it('contextLedger=null ⇒ n/a（尚未采集），不发明数字', () => {
    const text = renderMemoryStatus({ ...BASE, contextLedger: null })
    expect(text).toContain('context_ledger: n/a（本实例尚未采集）')
  })

  it('有归因 ⇒ 五类 + total + indexedSeqs + captured 全可读', () => {
    const text = renderMemoryStatus({
      ...BASE,
      contextLedger: {
        system: 10, user: 20, tool: 30, assistant: 40, unknown: 5, total: 105,
        capturedAt: '2026-06-01T00:00:00.000Z', indexedSeqs: 4,
      },
    })
    expect(text).toContain(
      'context_ledger: system=10 user=20 tool=30 assistant=40 unknown=5 total=105 indexedSeqs=4 captured=2026-06-01T00:00:00.000Z',
    )
  })

  it('compaction：runs=0 / 有最近一条 两种形态', () => {
    expect(renderMemoryStatus({ ...BASE, compaction: { runs: 0, lastCompactionId: null, lastStartedAt: null } }))
      .toContain('compaction: runs=0')
    expect(renderMemoryStatus({
      ...BASE,
      compaction: { runs: 2, lastCompactionId: 'c-2', lastStartedAt: '2026-06-01T00:00:00.000Z' },
    })).toContain('compaction: runs=2 last=c-2@2026-06-01T00:00:00.000Z')
  })

  it('两行追加在既有行之后（4.3 的五行顺序与前缀不变）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      health: {
        inboxBacklog: { status: 'none' },
        lastRefineAt: { status: 'none' },
      },
      contextLedger: null,
      compaction: { runs: 0, lastCompactionId: null, lastStartedAt: null },
    })
    const lines = text.split('\n')
    const ledgerAt = lines.findIndex((line) => line.startsWith('context_ledger:'))
    const compactionAt = lines.findIndex((line) => line.startsWith('compaction:'))
    expect(ledgerAt).toBeGreaterThan(0)
    expect(compactionAt).toBeGreaterThan(ledgerAt)
  })
})

describe('captureAttribution / readCompactionStatus / INV-7', () => {
  it('captureAttribution 记录时刻与索引大小，和恒等于 total', () => {
    const snapshot = captureAttribution(
      { totalTokens: 30, nodes: [{ seq: 1, tokens: 10 }, { seq: 2, tokens: 20 }] },
      new Map([[1, 'user' as const], [2, 'assistant' as const]]),
      '2026-06-01T00:00:00.000Z',
    )
    expect(snapshot.indexedSeqs).toBe(2)
    expect(snapshot.capturedAt).toBe('2026-06-01T00:00:00.000Z')
    const sum = snapshot.ledger.bySource.system + snapshot.ledger.bySource.user +
      snapshot.ledger.bySource.tool + snapshot.ledger.bySource.assistant + snapshot.ledger.bySource.unknown
    expect(sum).toBe(snapshot.ledger.totalTokens)
  })

  it('readCompactionStatus：0 行 ⇒ runs=0、last=null', async () => {
    expect(await readCompactionStatus(store.connection)).toEqual({ compactionRuns: 0, lastCompaction: null })
  })

  it('readCompactionStatus：写入两条 ⇒ 计数 2、最近一条按 started_at', async () => {
    await recordCompactionRun(store.connection, {
      sessionId: 's-1', compactionId: 'c-1', configSnapshot: { a: 1 }, startedAt: '2026-06-01T00:00:00.000Z',
    })
    await recordCompactionRun(store.connection, {
      sessionId: 's-1', compactionId: 'c-2', configSnapshot: { a: 2 }, startedAt: '2026-06-02T00:00:00.000Z',
    })
    const status = await readCompactionStatus(store.connection)
    expect(status.compactionRuns).toBe(2)
    expect(status.lastCompaction?.compactionId).toBe('c-2')
  })

  it('INV-7：只读实例不注册压缩接线（可执行判据）', () => {
    expect(shouldWireCompaction(false)).toBe(true)
    expect(shouldWireCompaction(true)).toBe(false)
  })
})

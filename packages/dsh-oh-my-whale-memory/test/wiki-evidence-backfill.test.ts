/**
 * EVIDENCE 边历史回填（Story 2.6 / 裁决 X1）。
 *
 * 真库验证四条不变量：
 * 1. 回填后「直接入边 == source_refs」差集为空（EII 判据②/漂移 A 成立）；
 * 2. 重放（含把游标倒回原点重扫）不产重边（MERGE 幂等）；
 * 3. 同层 ref **不建边**且在审计 + audit_gap（漂移）里可见（X1×U5）；
 * 4. 游标扫完落 `done`、闸门忙则一步不走。
 *
 * 开库次数：本文件共 1 次——LadybugDB 每进程约 15 个库封顶。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureEdgeTables, readEvidenceInEdgeIds } from '../src/db/edges'
import { computeEvidenceDrift } from '../src/db/eii'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { createIdleGate } from '../src/inbox/idle-gate'
import { createEvidenceBackfill, EVIDENCE_BACKFILL_DONE } from '../src/wiki/evidence-backfill'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'

let store: MemoryDatabase

async function exec(db: MemoryDatabase, statement: string): Promise<void> {
  await db.connection.query(statement)
}

async function seedL0(db: MemoryDatabase, id: string, rawText: string): Promise<void> {
  await exec(db, `CREATE (l:l0_raw {id: '${id}', raw_text: '${rawText}', recorded_at: '${T0}', actor: 'test'})`)
}

async function seedMemory(
  db: MemoryDatabase,
  args: { id: string, layer: string, refs?: readonly string[], recordedAt: string },
): Promise<void> {
  const refs = (args.refs ?? []).map((ref) => `'${ref}'`).join(', ')
  await exec(db, [
    `CREATE (m:memory {id: '${args.id}', layer: '${args.layer}', kind: '', priority: 0, text: '${args.id}',`,
    `  valid_at: '${args.recordedAt}', recorded_at: '${args.recordedAt}', invalid_at: NULL, expired_at: NULL,`,
    `  source_refs: [${refs}]})`,
  ].join(' '))
}

async function edgeCount(db: MemoryDatabase): Promise<number> {
  const rows = await queryAll(db.connection, 'MATCH ()-[e:EVIDENCE]->() RETURN count(*) AS c')
  return Number(rows[0]?.c ?? 0)
}

async function readCursor(db: MemoryDatabase): Promise<string | null> {
  const rows = await queryAll(db.connection, "MATCH (m:omw_meta {key: 'evidence_backfill_cursor'}) RETURN m.value AS value")
  const value = rows[0]?.value
  return value === undefined || value === null ? null : String(value)
}

async function backfillAuditRows(db: MemoryDatabase): Promise<Record<string, unknown>[]> {
  return queryAll(db.connection, "MATCH (g:generation_log {action: 'backfill_evidence'}) RETURN g.outcome AS outcome, g.reason AS reason")
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-ebf-')),
    dim: DIM,
    modelId: 'test-embed',
  })
  await ensureEdgeTables(store.connection)
  // 建表前写入的存量节点（= 需要回填的对象）。
  await seedL0(store, 'bf-l0a', '原文 A')
  await seedL0(store, 'bf-l0b', '原文 B')
  await seedMemory(store, { id: 'bf-m1', layer: 'L1', refs: ['bf-l0a', 'bf-l0b'], recordedAt: '2026-01-02T00:00:00.000Z' })
  await seedMemory(store, { id: 'bf-m2', layer: 'L2', refs: ['bf-m1'], recordedAt: '2026-01-03T00:00:00.000Z' })
  // 同层引用：L1 引用 L1（X1×U5 必须跳过）。
  await seedMemory(store, { id: 'bf-other-l1', layer: 'L1', refs: [], recordedAt: '2026-01-04T00:00:00.000Z' })
  await seedMemory(store, { id: 'bf-m3', layer: 'L1', refs: ['bf-other-l1'], recordedAt: '2026-01-05T00:00:00.000Z' })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('X1：EVIDENCE 边历史回填', () => {
  it('① 回填把 source_refs 差集清零（直接入边 == source_refs）', async () => {
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => store.connection, gate })
    const written = await backfill.runOnce()
    // bf-m1 ← bf-l0a、bf-l0b；bf-m2 ← bf-m1；同层 bf-m3 ← bf-other-l1 必须跳过。
    expect(written).toBe(3)
    expect(await readEvidenceInEdgeIds(store.connection, 'bf-m1')).toEqual(['bf-l0a', 'bf-l0b'])
    expect(await readEvidenceInEdgeIds(store.connection, 'bf-m2')).toEqual(['bf-m1'])
    expect(await readEvidenceInEdgeIds(store.connection, 'bf-m3')).toEqual([])

    const drift = await computeEvidenceDrift(store.connection, NOW)
    // 漂移 A 只剩那条同层引用（bf-m3 的 ref 仍在 source_refs 里，但合法地没有边）。
    expect(drift.refsWithoutEdges).toEqual([{ id: 'bf-m3', ref: 'bf-other-l1' }])
    expect(drift.edgesWithoutRefs).toEqual([])
    expect(await edgeCount(store)).toBe(3)
  })

  it('② 同层 ref 计审计（X1×U5：不静默）', async () => {
    const rows = await backfillAuditRows(store)
    expect(rows.length).toBeGreaterThan(0)
    const last = rows[rows.length - 1]!
    expect(String(last.outcome)).toBe('uncertain')
    expect(String(last.reason)).toContain('first=same-layer')
  })

  it('③ 游标扫完落 done：第二轮不再重扫（返回 0、边数不变）', async () => {
    expect(await readCursor(store)).toBe(EVIDENCE_BACKFILL_DONE)
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => store.connection, gate })
    expect(await backfill.runOnce()).toBe(0)
    expect(await edgeCount(store)).toBe(3)
  })

  it('④ 游标倒回原点重扫：MERGE 幂等，不产重边', async () => {
    await exec(store, "MATCH (m:omw_meta {key: 'evidence_backfill_cursor'}) DELETE m")
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => store.connection, gate })
    const written = await backfill.runOnce()
    expect(written).toBe(3)
    expect(await edgeCount(store)).toBe(3)
  })

  it('⑤ 空闲闸门：有活跃 turn 时一步不走', async () => {
    const gate = createIdleGate()
    gate.enterTurn('s1')
    const backfill = createEvidenceBackfill({ connection: () => store.connection, gate })
    expect(await backfill.runOnce()).toBe(0)
    gate.exitTurn('s1')
    expect(await backfill.runOnce()).toBe(0)
  })

  it('⑥ 连接未就绪（apply 早期）时返回 0，不抛错', async () => {
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => null, gate })
    expect(await backfill.runOnce()).toBe(0)
  })
})

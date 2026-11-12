/**
 * EVIDENCE 边历史回填（Story 2.6 / 裁决 X1）。
 *
 * 真库验证四条不变量：
 * 1. 回填后「直接入边 == source_refs」差集为空（EII 判据②/漂移 A 成立）；
 * 2. 重放（含把游标倒回原点重扫）不产重边（MERGE 幂等）；
 * 3. 同层 ref **不建边**且在审计 + audit_gap（漂移）里可见（X1×U5）；
 * 4. 游标扫完落 `done`、闸门忙则一步不走。
 *
 * 评审补钉（P1/P9③/P11/P15）在第二个库里跑（分页 / 中途转忙 / 空库首轮 / 墓碑过滤），
 * 使上面四条用例的共享状态不被污染。
 *
 * 开库次数：本文件共 2 次——LadybugDB 每进程约 15 个库封顶。
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

async function setCursor(db: MemoryDatabase, value: string): Promise<void> {
  await exec(db, [
    "MERGE (m:omw_meta {key: 'evidence_backfill_cursor'})",
    "ON CREATE SET m.value = '" + value + "'",
    "ON MATCH SET m.value = '" + value + "'",
  ].join(' '))
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
    // 评审 P18d②（T22）：边扫描没有 ORDER BY，返回顺序不是契约 ⇒ 排序后比集合，
    // 不钉实现巧合的物理顺序。
    expect((await readEvidenceInEdgeIds(store.connection, 'bf-m1')).slice().sort()).toEqual(['bf-l0a', 'bf-l0b'])
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

/**
 * 评审补钉（P1/P9③/P11/P15）：分页续跑、页内闸门转忙、空库首轮、墓碑过滤。
 * 独立库 + 独立 gate，避免与上面四条共享状态的用例互相干扰。
 */
describe('X1：回填的分页 / 中断 / 空库 / 墓碑（评审补钉）', () => {
  let db: MemoryDatabase

  beforeAll(async () => {
    db = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-ebf2-')),
      dim: DIM,
      modelId: 'test-embed',
    })
    await ensureEdgeTables(db.connection)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('评审 P15（T17）：空库首轮不写 done，之后写入的节点仍能被回填', async () => {
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => db.connection, gate })
    expect(await backfill.runOnce()).toBe(0)
    // 空库 + 游标为空 ⇒ 绝不落 done（否则后续新节点永不回填）。
    expect(await readCursor(db)).toBe(null)

    await seedL0(db, 'p15-l0', 'P15 原文')
    await seedMemory(db, { id: 'p15-m', layer: 'L1', refs: ['p15-l0'], recordedAt: '2026-02-01T00:00:00.000Z' })
    expect(await backfill.runOnce()).toBe(1)
    expect(await readEvidenceInEdgeIds(db.connection, 'p15-m')).toEqual(['p15-l0'])
  })

  it('评审 P11（T12①）：batchSize 分页——每轮只推进一页，续跑后边数不重复', async () => {
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => db.connection, gate, batchSize: 2 })
    await seedL0(db, 'p11-l0', 'P11 原文')
    await seedMemory(db, { id: 'p11-a', layer: 'L1', refs: ['p11-l0'], recordedAt: '2026-03-01T00:00:00.000Z' })
    await seedMemory(db, { id: 'p11-b', layer: 'L1', refs: ['p11-l0'], recordedAt: '2026-03-02T00:00:00.000Z' })
    await seedMemory(db, { id: 'p11-c', layer: 'L1', refs: ['p11-l0'], recordedAt: '2026-03-03T00:00:00.000Z' })
    // 显式把游标钉在第一页之前（不依赖上面用例留下的状态）。
    await setCursor(db, '2026-02-28T00:00:00.000Z|cursor')

    const first = await backfill.runOnce()
    // 第一页：p11-a 与 p11-b（按 recorded_at 升序），只写这两条的边。
    expect(first).toBe(2)
    const cursorAfterFirst = await readCursor(db)
    expect(cursorAfterFirst).not.toBe(EVIDENCE_BACKFILL_DONE)
    expect(String(cursorAfterFirst)).toContain('|')

    const second = await backfill.runOnce()
    expect(second).toBe(1)
    // 末批（不足一页且本页处理完）⇒ 落 done；再跑一轮即短路。
    expect(await readCursor(db)).toBe(EVIDENCE_BACKFILL_DONE)
    expect(await backfill.runOnce()).toBe(0)
    expect(await readEvidenceInEdgeIds(db.connection, 'p11-c')).toEqual(['p11-l0'])
    const total = await queryAll(db.connection, 'MATCH ()-[e:EVIDENCE]->() RETURN count(*) AS c')
    expect(Number(total[0]?.c)).toBe(4)
  })

  it('评审 P9③（T9）：墓碑 / 失效节点不被回填', async () => {
    await seedL0(db, 'p9-l0', 'P9 原文')
    await exec(db, [
      "CREATE (m:memory {id: 'p9-tomb', layer: 'L1', kind: '', priority: 0, text: 'p9-tomb',",
      "  valid_at: '2026-04-01T00:00:00.000Z', recorded_at: '2026-04-01T00:00:00.000Z',",
      "  invalid_at: '2026-04-02T00:00:00.000Z', expired_at: NULL, source_refs: ['p9-l0']})",
    ].join(' '))
    await setCursor(db, '2026-03-31T00:00:00.000Z|cursor')
    const gate = createIdleGate()
    const backfill = createEvidenceBackfill({ connection: () => db.connection, gate })
    await backfill.runOnce()
    expect(await readEvidenceInEdgeIds(db.connection, 'p9-tomb')).toEqual([])
  })

  it('评审 P1（T1）：页内闸门转忙 ⇒ 不落 done、尾部行下一轮被重扫', async () => {
    // 自定义 gate：前 1 次 isIdle=true（入口），随后 false（页内第一次复查即转忙）。
    let calls = 0
    const flaky = {
      enterTurn: () => {},
      exitTurn: () => {},
      isIdle: () => { calls += 1; return calls <= 1 },
      depthFor: () => 0,
    }
    await seedL0(db, 'p1-l0', 'P1 原文')
    await exec(db, [
      "CREATE (m:memory {id: 'p1-head', layer: 'L1', kind: '', priority: 0, text: 'p1-head',",
      "  valid_at: '2026-05-01T00:00:00.000Z', recorded_at: '2026-05-01T00:00:00.000Z', invalid_at: NULL, expired_at: NULL, source_refs: ['p1-l0']})",
    ].join(' '))
    await exec(db, [
      "CREATE (m:memory {id: 'p1-tail', layer: 'L1', kind: '', priority: 0, text: 'p1-tail',",
      "  valid_at: '2026-05-02T00:00:00.000Z', recorded_at: '2026-05-02T00:00:00.000Z', invalid_at: NULL, expired_at: NULL, source_refs: ['p1-l0']})",
    ].join(' '))

    // 显式钉在第一页之前，保证本轮只看 p1-head / p1-tail 两行。
    await setCursor(db, '2026-04-30T00:00:00.000Z|cursor')
    const shortPage = createEvidenceBackfill({ connection: () => db.connection, gate: flaky, batchSize: 2 })
    const written = await shortPage.runOnce()
    // 页内第一个节点就被闸门挡下 ⇒ 一条边都没写、游标不能落 done。
    expect(written).toBe(0)
    expect(await readCursor(db)).not.toBe(EVIDENCE_BACKFILL_DONE)

    // 闸门恢复 ⇒ 下一轮把两行都扫掉（尾部行没丢）。
    const healthy = createIdleGate()
    const resumed = createEvidenceBackfill({ connection: () => db.connection, gate: healthy, batchSize: 2 })
    expect(await resumed.runOnce()).toBe(2)
    expect(await readEvidenceInEdgeIds(db.connection, 'p1-head')).toEqual(['p1-l0'])
    expect(await readEvidenceInEdgeIds(db.connection, 'p1-tail')).toEqual(['p1-l0'])
  })

  it('评审 P1（T1）变异审计 M1 补钉：页内已推进过再转忙（不足一页）⇒ 仍不得落 done', async () => {
    // M1 撤掉 completed = false（只留 break）时，本用例变红：
    // processed < batchSize 会被误判「末批扫完」写 done，尾部行永久丢失回填机会。
    // 自定义 gate：第 1 次（入口）与第 2 次（第 1 行前复查）为 true，之后转忙。
    let calls2 = 0
    const flaky2 = {
      enterTurn: () => {},
      exitTurn: () => {},
      isIdle: () => { calls2 += 1; return calls2 <= 2 },
      depthFor: () => 0,
    }
    await seedL0(db, 'm1-l0', 'M1 原文')
    await exec(db, [
      "CREATE (m:memory {id: 'm1-a', layer: 'L1', kind: '', priority: 0, text: 'm1-a',",
      "  valid_at: '2026-06-01T00:00:00.000Z', recorded_at: '2026-06-01T00:00:00.000Z', invalid_at: NULL, expired_at: NULL, source_refs: ['m1-l0']})",
    ].join(' '))
    await exec(db, [
      "CREATE (m:memory {id: 'm1-b', layer: 'L1', kind: '', priority: 0, text: 'm1-b',",
      "  valid_at: '2026-06-02T00:00:00.000Z', recorded_at: '2026-06-02T00:00:00.000Z', invalid_at: NULL, expired_at: NULL, source_refs: ['m1-l0']})",
    ].join(' '))
    await setCursor(db, '2026-05-31T00:00:00.000Z|cursor')
    const backfill2 = createEvidenceBackfill({ connection: () => db.connection, gate: flaky2, batchSize: 5 })
    // 第 1 行（m1-a）处理完后，第 2 行前复查转忙 ⇒ break：m1-a 的边已写、游标推进但绝不 done。
    expect(await backfill2.runOnce()).toBe(1)
    const cursor2 = await readCursor(db)
    expect(cursor2).not.toBe(EVIDENCE_BACKFILL_DONE)
    expect(String(cursor2)).toContain('m1-a')
    // 恢复后剩余行仍能被扫（done 只属于真正扫完的那一轮）。
    const healthy2 = createIdleGate()
    const resumed2 = createEvidenceBackfill({ connection: () => db.connection, gate: healthy2, batchSize: 5 })
    expect(await resumed2.runOnce()).toBe(1)
    expect(await readEvidenceInEdgeIds(db.connection, 'm1-b')).toEqual(['m1-l0'])
  })
})

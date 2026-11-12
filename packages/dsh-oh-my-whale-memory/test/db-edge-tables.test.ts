/**
 * 类型化边表与 EII 校验（Story 2.6）。
 *
 * 真库（LadybugDB）验证，因为本模块的正确性全压在几条**未文档化或易错**的查询语义上：
 * GROUP 的跨表对递归、`label(x)` 动态属性谓词、零行上的 count 聚合、MERGE 重放幂等。
 * 层序取 L0 → L1 → L2（L3 已退役 AD-17），故现实证据链最长 2 跳。
 *
 * 开库次数：本文件共 2 次（共享 store 1 次 + 边表缺失场景 1 次）——LadybugDB 每进程约 15 个库封顶。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureEdgeTables, readEvidenceInEdgeIds, writeEvidenceEdges } from '../src/db/edges'
import {
  checkReachableToL0,
  checkRefReachableToL0,
  computeEiiViolations,
  computeEvidenceDrift,
  computeEvidenceGap,
  hasEdgeTables,
} from '../src/db/eii'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
/** 节点写入时间（早于所有断言用的 now）。 */
const T0 = '2026-01-01T00:00:00.000Z'
/** 断言用的「当前时刻」。 */
const NOW = '2026-06-01T00:00:00.000Z'

let store: MemoryDatabase

async function exec(db: MemoryDatabase, statement: string): Promise<void> {
  await db.connection.query(statement)
}

async function openDb(prefix: string): Promise<MemoryDatabase> {
  return openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir(prefix)),
    dim: DIM,
    modelId: 'test-embed',
  })
}

/** 直接建一行 L0（raw_text 为 null 即 redact 墓碑）。 */
async function seedL0(db: MemoryDatabase, id: string, rawText: string | null): Promise<void> {
  await exec(db, `CREATE (l:l0_raw {id: '${id}', raw_text: ${rawText === null ? 'NULL' : `'${rawText}'`}, recorded_at: '${T0}', actor: 'test'})`)
}

async function seedMemory(
  db: MemoryDatabase,
  args: { id: string, layer: string, refs?: readonly string[], invalidAt?: string | null, expiredAt?: string | null },
): Promise<void> {
  const refs = (args.refs ?? []).map((ref) => `'${ref}'`).join(', ')
  await exec(db, [
    `CREATE (m:memory {id: '${args.id}', layer: '${args.layer}', kind: '', priority: 0, text: '${args.id}',`,
    `  valid_at: '${T0}', recorded_at: '${T0}',`,
    `  invalid_at: ${args.invalidAt ? `'${args.invalidAt}'` : 'NULL'},`,
    `  expired_at: ${args.expiredAt ? `'${args.expiredAt}'` : 'NULL'},`,
    `  source_refs: [${refs}]})`,
  ].join(' '))
}

async function edgeCount(db: MemoryDatabase): Promise<number> {
  const rows = await queryAll(db.connection, 'MATCH ()-[e:EVIDENCE]->() RETURN count(*) AS c')
  return Number(rows[0]?.c ?? 0)
}

beforeAll(async () => {
  store = await openDb('omw-edge-')
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('边表 DDL 与写边原语', () => {
  it('ensureEdgeTables 幂等：重复建表不抛错，两张表都在', async () => {
    await ensureEdgeTables(store.connection)
    expect(await hasEdgeTables(store.connection)).toBe(true)
    const result = await store.connection.query("CALL show_connection('EVIDENCE') RETURN *")
    const rows = Array.isArray(result) ? result : [result]
    expect(rows.length).toBeGreaterThan(0)
  })

  it('写边：l0_raw→memory 建成、直接入边可读、重放不产重边（MERGE 幂等）', async () => {
    await seedL0(store, 'e1-l0a', '原文 A')
    await seedMemory(store, { id: 'e1-m1', layer: 'L1', refs: ['e1-l0a'] })
    const first = await writeEvidenceEdges(store.connection, [
      { fromId: 'e1-l0a', fromLayer: 'L0', toId: 'e1-m1', toLayer: 'L1', reason: 'capture' },
    ])
    expect(first.written).toBe(1)
    expect(first.skipped).toEqual([])
    expect(await readEvidenceInEdgeIds(store.connection, 'e1-m1')).toEqual(['e1-l0a'])
    const replay = await writeEvidenceEdges(store.connection, [
      { fromId: 'e1-l0a', fromLayer: 'L0', toId: 'e1-m1', toLayer: 'L1' },
    ])
    expect(replay.written).toBe(1)
    expect(await edgeCount(store)).toBe(1)
  })

  it('层序守卫：同层/倒置/自环一律跳过且不抛错，合法 L1→L2 照常写', async () => {
    await seedMemory(store, { id: 'e2-l1a', layer: 'L1' })
    await seedMemory(store, { id: 'e2-l1b', layer: 'L1' })
    await seedMemory(store, { id: 'e2-l2a', layer: 'L2' })
    const result = await writeEvidenceEdges(store.connection, [
      { fromId: 'e2-l1a', fromLayer: 'L1', toId: 'e2-l1b', toLayer: 'L1' },
      { fromId: 'e2-l2a', fromLayer: 'L2', toId: 'e2-l1a', toLayer: 'L1' },
      { fromId: 'e2-l1a', fromLayer: 'L1', toId: 'e2-l1a', toLayer: 'L1' },
      { fromId: 'e2-l1a', fromLayer: 'L1', toId: 'e2-l2a', toLayer: 'L2' },
    ])
    expect(result.written).toBe(1)
    expect(result.skipped.map((s) => s.reason)).toEqual(['layer-order', 'layer-order', 'self-loop'])
    expect(await readEvidenceInEdgeIds(store.connection, 'e2-l2a')).toEqual(['e2-l1a'])
  })

  it('评审 P6（T6）：全非法批 ⇒ written===0 且逐条给 skipped 原因（I-O 矩阵 #3）', async () => {
    await seedMemory(store, { id: 'p6-l1a', layer: 'L1' })
    await seedMemory(store, { id: 'p6-l1b', layer: 'L1' })
    await seedMemory(store, { id: 'p6-l2a', layer: 'L2' })
    const result = await writeEvidenceEdges(store.connection, [
      { fromId: 'p6-l1a', fromLayer: 'L1', toId: 'p6-l1b', toLayer: 'L1' },
      { fromId: 'p6-l2a', fromLayer: 'L2', toId: 'p6-l1a', toLayer: 'L1' },
      { fromId: 'p6-l1a', fromLayer: 'L1', toId: 'p6-l1a', toLayer: 'L1' },
    ])
    expect(result.written).toBe(0)
    expect(result.skipped.length).toBe(3)
  })

  it('评审 P6（T6）：端点缺失 ⇒ written===0 且记 endpoint-missing（不再与「成功」混淆）', async () => {
    await seedMemory(store, { id: 'p6-target', layer: 'L1' })
    const result = await writeEvidenceEdges(store.connection, [
      { fromId: 'p6-absent-l0', fromLayer: 'L0', toId: 'p6-target', toLayer: 'L1' },
    ])
    expect(result.written).toBe(0)
    expect(result.skipped.map((s) => s.reason)).toEqual(['endpoint-missing'])
  })

  it('评审 P10（T10）：重放传不同 reason ⇒ 保留首写（ON CREATE SET）', async () => {
    await seedL0(store, 'p10-l0', '原文')
    await seedMemory(store, { id: 'p10-m', layer: 'L1' })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'p10-l0', fromLayer: 'L0', toId: 'p10-m', toLayer: 'L1', reason: 'source-ref' },
    ])
    await writeEvidenceEdges(store.connection, [
      { fromId: 'p10-l0', fromLayer: 'L0', toId: 'p10-m', toLayer: 'L1', reason: 'refine' },
    ])
    const rows = await queryAll(
      store.connection,
      "MATCH (:l0_raw {id: 'p10-l0'})-[e:EVIDENCE]->(:memory {id: 'p10-m'}) RETURN e.reason AS reason",
    )
    expect(String(rows[0]?.reason)).toBe('source-ref')
  })
})

describe('只读可达性原语（2.5 判据②/判据①）', () => {
  it('not-found：id 不在 memory 表', async () => {
    const result = await checkReachableToL0(store.connection, 'nope', NOW)
    expect(result).toEqual({ id: 'nope', pass: false, failingReasons: ['not-found'] })
  })

  it('not-effective：invalid_at / expired_at 置位或尚未生效', async () => {
    await seedMemory(store, { id: 'r-invalid', layer: 'L1', invalidAt: T0 })
    await seedMemory(store, { id: 'r-expired', layer: 'L1', expiredAt: T0 })
    expect((await checkReachableToL0(store.connection, 'r-invalid', NOW)).failingReasons).toEqual(['not-effective'])
    expect((await checkReachableToL0(store.connection, 'r-expired', NOW)).failingReasons).toEqual(['not-effective'])
  })

  it('no-evidence-edge：有效但一条入边都没有', async () => {
    await seedMemory(store, { id: 'r-orphan', layer: 'L1' })
    const result = await checkReachableToL0(store.connection, 'r-orphan', NOW)
    expect(result.pass).toBe(false)
    expect(result.failingReasons).toEqual(['no-evidence-edge'])
  })

  it('pass：L0→L1→L2 两跳可达（含未提交事务内也可见）', async () => {
    await seedL0(store, 'r-src', '证据原文')
    await seedMemory(store, { id: 'r-l1', layer: 'L1', refs: ['r-src'] })
    await seedMemory(store, { id: 'r-l2', layer: 'L2', refs: ['r-l1'] })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'r-src', fromLayer: 'L0', toId: 'r-l1', toLayer: 'L1' },
      { fromId: 'r-l1', fromLayer: 'L1', toId: 'r-l2', toLayer: 'L2' },
    ])
    expect(await checkReachableToL0(store.connection, 'r-l1', NOW)).toEqual({ id: 'r-l1', pass: true, failingReasons: [] })
    const l2 = await checkReachableToL0(store.connection, 'r-l2', NOW)
    expect(l2.pass).toBe(true)
  })

  it('no-valid-path-to-l0：唯一证据端点是非墓碑判据外的墓碑 L0', async () => {
    await seedL0(store, 'r-tomb', null)
    await seedMemory(store, { id: 'r-t1', layer: 'L1', refs: ['r-tomb'] })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'r-tomb', fromLayer: 'L0', toId: 'r-t1', toLayer: 'L1' },
    ])
    const result = await checkReachableToL0(store.connection, 'r-t1', NOW)
    expect(result.pass).toBe(false)
    expect(result.failingReasons).toEqual(['no-valid-path-to-l0'])
  })

  it('no-valid-path-to-l0：链上经过无效中间节点', async () => {
    await seedL0(store, 'r-src2', '证据原文')
    await seedMemory(store, { id: 'r-mid', layer: 'L1', refs: ['r-src2'], invalidAt: T0 })
    await seedMemory(store, { id: 'r-top', layer: 'L2', refs: ['r-mid'] })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'r-src2', fromLayer: 'L0', toId: 'r-mid', toLayer: 'L1' },
      { fromId: 'r-mid', fromLayer: 'L1', toId: 'r-top', toLayer: 'L2' },
    ])
    // 中间节点自身 invalid 时，*1..4 的路径谓词必须把它整条剔掉（brief §2.2 ⑤ 的决定性实验）。
    const result = await checkReachableToL0(store.connection, 'r-top', NOW)
    expect(result.pass).toBe(false)
    expect(result.failingReasons).toEqual(['no-valid-path-to-l0'])
    // 中间节点自身则是 not-effective（更早的判据短路）。
    expect((await checkReachableToL0(store.connection, 'r-mid', NOW)).failingReasons).toEqual(['not-effective'])
  })

  it('checkRefReachableToL0：l0 命中 / l0 墓碑 / memory 命中委托闭包 / 都不命中', async () => {
    await seedL0(store, 'rf-l0', '原文')
    await seedL0(store, 'rf-tomb', null)
    await seedMemory(store, { id: 'rf-m1', layer: 'L1', refs: ['rf-l0'] })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'rf-l0', fromLayer: 'L0', toId: 'rf-m1', toLayer: 'L1' },
    ])
    expect(await checkRefReachableToL0(store.connection, 'rf-l0', NOW)).toEqual({ id: 'rf-l0', pass: true, failingReasons: [] })
    expect((await checkRefReachableToL0(store.connection, 'rf-tomb', NOW)).failingReasons).toEqual(['l0-tombstone'])
    expect((await checkRefReachableToL0(store.connection, 'rf-m1', NOW)).pass).toBe(true)
    expect((await checkRefReachableToL0(store.connection, 'rf-absent', NOW)).failingReasons).toEqual(['not-found'])
  })
})

describe('audit_gap 的边侧两集', () => {
  it('computeEiiViolations 只报「有效且不可达」，可达节点不报', async () => {
    await seedMemory(store, { id: 'g-orphan', layer: 'L1' })
    const violations = await computeEiiViolations(store.connection, NOW)
    expect(violations).toContain('g-orphan')
    // r-l1 在上面的 describe 里已建好 L0→L1 边，必须不在违例集里。
    expect(violations).not.toContain('r-l1')
    // 已失效节点不进「有效全集」，自然也不是 EII 违例。
    expect(violations).not.toContain('r-invalid')
  })

  it('computeEvidenceDrift 双向：refs 有边无 / 边有 refs 无', async () => {
    await seedL0(store, 'd-l0', '原文')
    await seedMemory(store, { id: 'd-m1', layer: 'L1', refs: ['d-l0', 'd-missing'] })
    await seedMemory(store, { id: 'd-m2', layer: 'L1', refs: [] })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'd-l0', fromLayer: 'L0', toId: 'd-m1', toLayer: 'L1' },
      { fromId: 'd-l0', fromLayer: 'L0', toId: 'd-m2', toLayer: 'L1' },
    ])
    const drift = await computeEvidenceDrift(store.connection, NOW)
    expect(drift.refsWithoutEdges).toContainEqual({ id: 'd-m1', ref: 'd-missing' })
    expect(drift.edgesWithoutRefs).toContainEqual({ id: 'd-m2', ref: 'd-l0' })
    // 自洽的那条既不在 A 也不在 B。
    expect(drift.refsWithoutEdges.some((entry) => entry.ref === 'd-l0')).toBe(false)
  })

  it('computeEvidenceGap 汇总三数（违例 + 漂移合计）', async () => {
    const gap = await computeEvidenceGap(store.connection, NOW)
    expect(gap).not.toBeNull()
    expect(gap!.total).toBe(gap!.eiiViolations + gap!.drift)
    expect(gap!.eiiViolations).toBeGreaterThan(0)
    expect(gap!.drift).toBeGreaterThan(0)
  })
})

describe('边表缺失与 DB 异常', () => {
  it('边表被删后：hasEdgeTables=false、computeEvidenceGap=null、可达性查询**抛错**而非 pass=false', async () => {
    const bare = await openDb('omw-noedge-')
    try {
      await exec(bare, 'DROP TABLE EVIDENCE')
      expect(await hasEdgeTables(bare.connection)).toBe(false)
      expect(await computeEvidenceGap(bare.connection, NOW)).toBeNull()
      // brief §5.2 的硬要求：DB 异常不得吞成「不合格」，必须冒泡让 2.5 走重试路径。
      // 先给一个**存在且有效**的节点，否则第一条查询就以 not-found 短路、根本碰不到边表。
      await seedMemory(bare, { id: 'bare-m1', layer: 'L1' })
      await expect(checkReachableToL0(bare.connection, 'bare-m1', NOW)).rejects.toThrow(/EVIDENCE/)
    } finally {
      await bare.close()
    }
  })
})

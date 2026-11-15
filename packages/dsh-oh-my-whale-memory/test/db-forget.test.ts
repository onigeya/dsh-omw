/**
 * forget 软删除与 EII 定序级联（Story 4.1 / FR-14、FR-15 / AD-10、AD-19、AD-21）。
 *
 * 真库（LadybugDB）验证，因为正确性全压在几条未文档化查询语义上：EVIDENCE 反转变长路径
 * （`*1..4` 字面量）、`length(p)`、指针写入的行数校验。
 *
 * 本文件 6 用例 = 1 次开库（≤14）。覆盖矩阵行：
 * - 行 1：单条、无上层引用者 ⇒ 目标 expired_at 落值 + 恰 1 行 cascade_depth=0 的账本；
 * - 行 2：同一 id 连续两次 ⇒ 幂等重放，expired_at 逐字保留，所有表行数不变；
 * - 行 3：不存在的 id ⇒ memory_not_found，零写入；
 * - 行 4：空 id ⇒ 参数错误在库层表现为 memory_not_found（命令/工具层先拦，见另两个测试）；
 * - 行 8：合法序列 —— list / recall 隐藏、show 可见并显示 expired_at、related 标 invalid；
 * - 行 14：EII 违例数与 audit_gap 不因这次 forget 上涨（D-D 的 keyed 行生效）。
 *
 * 级联链路（行 5–7）、幂等重放表计数（行 9–11）、事务回滚（行 13）、缺表（行 15）在
 * `db-forget-cascade.test.ts`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeAuditGap } from '../src/db/audit'
import { MemoryDbError } from '../src/db/errors'
import { computeEvidenceGap, computeEiiViolations } from '../src/db/eii'
import { traverseRelated } from '../src/db/edges'
import { forgetMemory } from '../src/db/forget'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { getMemoryById, listMemories } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { runRecallCore } from '../src/recall/core'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
/** 节点写入时间（早于所有断言用的 now）。 */
const T0 = '2026-01-01T00:00:00.000Z'
/** 断言用的「当前时刻」。 */
const NOW = '2026-06-01T00:00:00.000Z'
/** 固定的遗忘时刻（单测注入，保证断言逐字可比）。 */
const FORGET_AT = '2026-06-02T03:04:05.000Z'
const LAYER_WEIGHTS = { l2: 0.7, l1: 0.4 }

let store: MemoryDatabase

const forgetAt = (id: string) => forgetMemory(store.connection, id, { now: () => new Date(FORGET_AT) })

async function exec(statement: string): Promise<void> {
  await store.connection.query(statement)
}

/** 直接建一行 L0（真实 raw_text，非墓碑）。 */
async function seedL0(id: string, rawText: string): Promise<void> {
  await exec(
    `CREATE (l:l0_raw {id: '${id}', raw_text: '${rawText}', recorded_at: '${T0}', actor: 'test'})`,
  )
}

/** 直接建一行记忆（无向量；`sourceRefs` 与 EVIDENCE 直接入边一一对应，漂移恒 0）。 */
async function seedMemory(args: {
  id: string
  layer: string
  text: string
  refs?: readonly string[]
  invalidAt?: string | null
  expiredAt?: string | null
}): Promise<void> {
  const refs = (args.refs ?? []).map((ref) => `'${ref}'`).join(', ')
  await exec([
    `CREATE (m:memory {id: '${args.id}', layer: '${args.layer}', kind: '', priority: 0,`,
    `  text: '${args.text}', valid_at: '${T0}', recorded_at: '${T0}',`,
    `  invalid_at: ${args.invalidAt === undefined || args.invalidAt === null ? 'NULL' : `'${args.invalidAt}'`},`,
    `  expired_at: ${args.expiredAt === undefined || args.expiredAt === null ? 'NULL' : `'${args.expiredAt}'`},`,
    `  source_refs: [${refs}]})`,
  ].join(' '))
}

/** 写一条 EVIDENCE 边（端点标签由层名决定，与生产同形）。 */
async function seedEvidence(fromId: string, fromLayer: string, toId: string, toLayer: string): Promise<void> {
  const fromLabel = fromLayer === 'L0' ? 'l0_raw' : 'memory'
  await exec(
    `MATCH (a:${fromLabel} {id: '${fromId}'}), (b:memory {id: '${toId}'}) ` +
    'MERGE (a)-[r:EVIDENCE]->(b) ON CREATE SET r.reason = \'test\'',
  )
}

async function countOf(statement: string): Promise<number> {
  const rows = await queryAll(store.connection, statement)
  return Number(rows[0]?.c ?? 0)
}

const countGenerationLog = () => countOf('MATCH (g:generation_log) RETURN count(g) AS c')
const countKeyedDecision = () => countOf('MATCH (k:keyed_decision) RETURN count(k) AS c')
const countMemory = () => countOf('MATCH (m:memory) RETURN count(m) AS c')

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-forget-')),
    dim: DIM,
    modelId: MODEL,
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('forgetMemory：单条遗忘与幂等（矩阵行 1–4）', () => {
  it('行 1：无上层引用者 ⇒ 只写目标 expired_at + 恰 1 行 cascade_depth=0 的账本', async () => {
    await seedL0('f1-l0', 'f1 的原始观测')
    await seedMemory({ id: 'f1-a', layer: 'L1', text: '单条记忆', refs: ['f1-l0'] })
    await seedEvidence('f1-l0', 'L0', 'f1-a', 'L1')

    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()

    const result = await forgetAt('f1-a')

    expect(result.alreadyExpired).toBe(false)
    // 目标在最后（跳数降序，目标 hops=0）。
    expect(result.affected).toEqual([
      { id: 'f1-a', layer: 'L1', text: '单条记忆', hops: 0 },
    ])

    const rows = await queryAll(
      store.connection,
      "MATCH (m:memory {id: 'f1-a'}) RETURN m.expired_at AS expired_at, m.invalid_at AS invalid_at, m.text AS text",
    )
    expect(rows[0]?.expired_at).toBe(FORGET_AT)
    // 目标自身不写 invalid_at（用户级遗忘只落在 expired_at，D-C）。
    expect(rows[0]?.invalid_at).toBeNull()
    // 内容不可改写：text 原样。
    expect(rows[0]?.text).toBe('单条记忆')

    // generation_log 恰 1 行，且级联字段形态钉死。
    expect(await countGenerationLog()).toBe(logBefore + 1)
    const log = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.reason = 'forget root=f1-a depth=0'" +
      ' RETURN g.actor AS actor, g.kind AS kind, g.action AS action, g.policy AS policy,' +
      ' g.cascade_depth AS depth, g.trigger_id AS trigger_id, g.l0_refs AS refs',
    )
    expect(log).toHaveLength(1)
    expect(log[0]?.actor).toBe('user')
    expect(log[0]?.kind).toBe('cascade')
    expect(log[0]?.action).toBe('forget')
    expect(log[0]?.policy).toBe('user-forget')
    expect(Number(log[0]?.depth)).toBe(0)
    expect(log[0]?.trigger_id).toBeNull()
    expect(log[0]?.refs).toEqual(['f1-l0'])

    // 目标的 keyed 裁决：old_id = new_id = 目标（audit_gap 不上涨的依据）。
    expect(await countKeyedDecision()).toBe(keyedBefore + 1)
    const keyed = await queryAll(
      store.connection,
      "MATCH (k:keyed_decision) WHERE k.old_id = 'f1-a' RETURN k.new_id AS new_id, k.action AS action," +
      ' k.policy AS policy, k.resolution_source AS source',
    )
    expect(keyed).toHaveLength(1)
    expect(keyed[0]?.new_id).toBe('f1-a')
    expect(keyed[0]?.action).toBe('supersede')
    expect(keyed[0]?.policy).toBe('user-forget')
    expect(keyed[0]?.source).toBe('user')
  })

  it('行 2：同一 id 连续两次 ⇒ 第二次幂等重放，expired_at 逐字保留且所有表行数不变', async () => {
    await seedL0('f2-l0', 'f2 的原始观测')
    await seedMemory({ id: 'f2-a', layer: 'L1', text: '重复遗忘', refs: ['f2-l0'] })
    await seedEvidence('f2-l0', 'L0', 'f2-a', 'L1')

    const first = await forgetAt('f2-a')
    expect(first.alreadyExpired).toBe(false)
    const stampRows = await queryAll(
      store.connection,
      "MATCH (m:memory {id: 'f2-a'}) RETURN m.expired_at AS expired_at",
    )
    const firstStamp = stampRows[0]?.expired_at

    // 第二次用不同时刻：若真重写，expired_at 会变。
    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()
    const memoryBefore = await countMemory()

    const second = await forgetMemory(store.connection, 'f2-a', {
      now: () => new Date('2026-12-31T23:59:59.000Z'),
    })
    expect(second.alreadyExpired).toBe(true)
    expect(second.affected).toEqual([{ id: 'f2-a', layer: 'L1', text: '重复遗忘', hops: 0 }])

    const after = await queryAll(
      store.connection,
      "MATCH (m:memory {id: 'f2-a'}) RETURN m.expired_at AS expired_at",
    )
    expect(after[0]?.expired_at).toBe(firstStamp)
    expect(await countGenerationLog()).toBe(logBefore)
    expect(await countKeyedDecision()).toBe(keyedBefore)
    expect(await countMemory()).toBe(memoryBefore)
  })

  it('行 3：不存在的 id ⇒ memory_not_found，且不写任何行', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()
    const memoryBefore = await countMemory()

    await expect(forgetAt(missing)).rejects.toThrowError(MemoryDbError)
    await expect(forgetAt(missing)).rejects.toMatchObject({
      code: 'memory_not_found',
      message: `未找到 id 为 ${missing} 的记忆。`,
    })

    expect(await countGenerationLog()).toBe(logBefore)
    expect(await countKeyedDecision()).toBe(keyedBefore)
    expect(await countMemory()).toBe(memoryBefore)
  })

  it('行 4：空 id 在库层就是「查不到」⇒ memory_not_found（命令/工具层更早拦成 usage / invalid_query）', async () => {
    const logBefore = await countGenerationLog()
    await expect(forgetMemory(store.connection, '   ')).rejects.toMatchObject({
      code: 'memory_not_found',
    })
    expect(await countGenerationLog()).toBe(logBefore)
  })
})

describe('forgetMemory：合法序列的可观察后果（矩阵行 8）', () => {
  it('遗忘后 list / recall 隐藏、show 可见并显示 expired_at、related 把节点标 invalid', async () => {
    await seedL0('f8-l0', 'f8 的原始观测')
    await seedMemory({ id: 'f8-a', layer: 'L1', text: 'forgetrow8alpha', refs: ['f8-l0'] })
    await seedMemory({ id: 'f8-b', layer: 'L2', text: 'forgetrow8beta', refs: ['f8-a'] })
    await seedEvidence('f8-l0', 'L0', 'f8-a', 'L1')
    await seedEvidence('f8-a', 'L1', 'f8-b', 'L2')

    const listed = await listMemories(store.connection, { query: 'forgetrow8alpha', limit: 20 })
    expect(listed.map((entry) => entry.id)).toContain('f8-a')

    await forgetAt('f8-a')

    // list：目标退出当前快照。
    const listedAfter = await listMemories(store.connection, { query: 'forgetrow8alpha', limit: 20 })
    expect(listedAfter.map((entry) => entry.id)).not.toContain('f8-a')

    // recall（关键词单路，queryVector=null ⇒ degraded）：目标不再命中。
    const recalled = await runRecallCore({
      connection: store.connection,
      query: 'forgetrow8alpha',
      queryVector: null,
      embeddingModelId: MODEL,
      rrfK: 60,
      retrievalTopK: 50,
      layerWeights: LAYER_WEIGHTS,
      priorityWeight: 0.5,
      limit: 20,
      now: NOW,
    })
    expect(recalled.results.map((item) => item.id)).not.toContain('f8-a')

    // show：墓碑照样可见，且 expired_at 原样带回。
    const detail = await getMemoryById(store.connection, 'f8-a')
    expect(detail?.expiredAt).toBe(FORGET_AT)
    expect(detail?.text).toBe('forgetrow8alpha')

    // related：从上层邻居看，目标出现在结果里并标 invalid + expired_at。
    const traversed = await traverseRelated(store.connection, { id: 'f8-b', depth: 1 })
    const neighbor = traversed.results.find((item) => item.id === 'f8-a')
    expect(neighbor).toBeDefined()
    expect(neighbor?.invalid).toBe(true)
    expect(neighbor?.expiredAt).toBe(FORGET_AT)
  })
})

describe('forgetMemory：EII 与 audit_gap 不变量（矩阵行 14）', () => {
  it('遗忘后 computeEiiViolations 不增、audit_gap 不上涨（keyed 行生效）', async () => {
    await seedL0('f14-l0', 'f14 的原始观测')
    await seedMemory({ id: 'f14-a', layer: 'L1', text: '证据根', refs: ['f14-l0'] })
    await seedMemory({ id: 'f14-b', layer: 'L2', text: '综合陈述', refs: ['f14-a'] })
    await seedEvidence('f14-l0', 'L0', 'f14-a', 'L1')
    await seedEvidence('f14-a', 'L1', 'f14-b', 'L2')

    const violationsBefore = await computeEiiViolations(store.connection, NOW)
    const auditGapBefore = await computeAuditGap(store.connection)

    const result = await forgetAt('f14-a')
    expect(result.affected.map((node) => node.id)).toEqual(['f14-b', 'f14-a'])

    const violationsAfter = await computeEiiViolations(store.connection, NOW)
    const auditGapAfter = await computeAuditGap(store.connection)
    const evidenceGap = await computeEvidenceGap(store.connection, NOW)

    // 违例数不因这次 forget 增加：两个节点都已离开当前快照，不参与 EII 判定。
    expect(violationsAfter.length).toBeLessThanOrEqual(violationsBefore.length)
    for (const id of ['f14-a', 'f14-b']) expect(violationsAfter).not.toContain(id)
    // audit_gap（keyed 口径）不上涨 —— 每个被作废节点都落了 keyed 裁决（D-D）。
    expect(auditGapAfter).toBe(auditGapBefore)
    // 边侧差额也不因这次 forget 上涨（漂移基准是直接入边，forget 不动边）。
    expect(evidenceGap?.total ?? 0).toBe(0)
  })
})

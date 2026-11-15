/**
 * forget 的 EII 定序级联、幂等重放与失败注入（Story 4.1 / AD-10、AD-19、AD-21）。
 *
 * 真库（LadybugDB）验证。覆盖矩阵行：
 * - 行 5：L0→L1(A)→L2(B) ⇒ affected=[B@1, A@0]，B 写 invalid_at、A 写 expired_at；
 * - 行 6：菱形（B、C 都引用 A，D 同时引用 B 和 C）⇒ 每个 id 只出现一次（最小跳数），D 的
 *   cascade_depth=2；
 * - 行 7：已失效的上层 ⇒ 进闭包但不重写、不新增 log/keyed；
 * - 行 9：目标 expired_at 已非空但 invalid_at 为空 ⇒ 幂等 success 且不级联；
 * - 行 10：同 id 两次 forget ⇒ 两个账本表行数不变，keyed_decision.old_id=目标 至多 1 行；
 * - 行 11：迟到事件 —— forget 后用旧文本重写 ⇒ 不复活、库里仍只有 1 条同文本节点（D-A）；
 * - 行 13：事务内写 invalid_at 阶段抛错 ⇒ 整事务回滚（无半级联状态）；
 * - 行 15：缺 generation_log / 边表 ⇒ 抛可读错误，不以「成功」收尾。
 *
 * 本文件 8 用例 = 2 次开库（共享 store 1 + 缺表场景 1，≤14）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { computeAuditGap } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { writeDeduplicatedMemory } from '../src/db/dedup'
import { computeEvidenceGap } from '../src/db/eii'
import { forgetMemory } from '../src/db/forget'
import { getMemoryById, listMemories } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll, queryRows } from '../src/db/rows'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
const T0 = '2026-01-01T00:00:00.000Z'
/** 固定的遗忘时刻（注入时钟，断言逐字可比）。 */
const FORGET_AT = '2026-06-02T03:04:05.000Z'
/** 上层节点本来就有的失效时刻（矩阵行 7 的「保持原值」）。 */
const OLD_INVALID_AT = '2026-03-01T00:00:00.000Z'

let store: MemoryDatabase

const forgetAt = (connection: lbug.Connection, id: string) =>
  forgetMemory(connection, id, { now: () => new Date(FORGET_AT) })

async function exec(statement: string): Promise<void> {
  await store.connection.query(statement)
}

async function seedL0(id: string, rawText: string): Promise<void> {
  await exec(
    `CREATE (l:l0_raw {id: '${id}', raw_text: '${rawText}', recorded_at: '${T0}', actor: 'test'})`,
  )
}

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

async function seedEvidence(fromId: string, fromLayer: string, toId: string): Promise<void> {
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

/** 取一条节点的两列墓碑（不存在的列返回 null）。 */
async function tombstones(id: string): Promise<{ invalidAt: unknown, expiredAt: unknown }> {
  const rows = await queryAll(
    store.connection,
    `MATCH (m:memory {id: '${id}'}) RETURN m.invalid_at AS invalid_at, m.expired_at AS expired_at`,
  )
  return { invalidAt: rows[0]?.invalid_at ?? null, expiredAt: rows[0]?.expired_at ?? null }
}

/**
 * 包一层连接，让「写 invalid_at」这一步抛错（矩阵行 13 的注入点）。
 * 判据是绑定参数里出现 `invalid_at` 键：SET 语句独有，读语句只绑 `id`。
 */
function connectionFailingOn(real: lbug.Connection, paramKey: string): lbug.Connection {
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown
      if (typeof value !== 'function') return value
      if (property === 'execute') {
        return async (statement: unknown, params?: Record<string, unknown>) => {
          if (params !== undefined && paramKey in params) {
            throw new Error(`注入的写失败（矩阵行 13）：${paramKey}`)
          }
          return (value as (...args: unknown[]) => unknown).call(target, statement, params)
        }
      }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  }) as lbug.Connection
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-forget-cascade-')),
    dim: DIM,
    modelId: MODEL,
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('forgetMemory：级联链与定序（矩阵行 5–7）', () => {
  it('行 5：L0→L1(A)→L2(B) ⇒ affected=[B@1, A@0]；B 写 invalid_at、A 写 expired_at', async () => {
    await seedL0('c5-l0', 'c5 的原始观测')
    await seedMemory({ id: 'c5-a', layer: 'L1', text: 'L1 原子记忆', refs: ['c5-l0'] })
    await seedMemory({ id: 'c5-b', layer: 'L2', text: 'L2 综合陈述', refs: ['c5-a'] })
    await seedEvidence('c5-l0', 'L0', 'c5-a')
    await seedEvidence('c5-a', 'L1', 'c5-b')

    const result = await forgetAt(store.connection, 'c5-a')

    expect(result.affected).toEqual([
      { id: 'c5-b', layer: 'L2', text: 'L2 综合陈述', hops: 1 },
      { id: 'c5-a', layer: 'L1', text: 'L1 原子记忆', hops: 0 },
    ])
    expect(await tombstones('c5-b')).toEqual({ invalidAt: FORGET_AT, expiredAt: null })
    expect(await tombstones('c5-a')).toEqual({ invalidAt: null, expiredAt: FORGET_AT })

    // 级联行的记账形态：cascade_depth=1、trigger_id = 目标的 log 行 id。
    const rootLog = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.reason = 'forget root=c5-a depth=0' RETURN g.id AS id",
    )
    expect(rootLog).toHaveLength(1)
    const cascadeLog = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.reason = 'forget root=c5-a depth=1'" +
      ' RETURN g.cascade_depth AS depth, g.trigger_id AS trigger_id',
    )
    expect(cascadeLog).toHaveLength(1)
    expect(Number(cascadeLog[0]?.depth)).toBe(1)
    expect(cascadeLog[0]?.trigger_id).toBe(rootLog[0]?.id)
    // 受害者的 keyed 裁决同样落行（audit_gap 不上涨）。
    const victimKeyed = await queryAll(
      store.connection,
      "MATCH (k:keyed_decision) WHERE k.old_id = 'c5-b' RETURN k.new_id AS new_id",
    )
    expect(victimKeyed).toHaveLength(1)
    expect(victimKeyed[0]?.new_id).toBe('c5-a')
  })

  it('行 6：菱形 ⇒ 每个 id 只出现一次（最小跳数），D 的 cascade_depth=2', async () => {
    await seedL0('c6-l0', 'c6 的原始观测')
    await seedMemory({ id: 'c6-a', layer: 'L1', text: '菱形根', refs: ['c6-l0'] })
    await seedMemory({ id: 'c6-b', layer: 'L2', text: '左枝', refs: ['c6-a'] })
    await seedMemory({ id: 'c6-c', layer: 'L2', text: '右枝', refs: ['c6-a'] })
    await seedMemory({ id: 'c6-d', layer: 'L2', text: '汇合点', refs: ['c6-b', 'c6-c'] })
    await seedEvidence('c6-l0', 'L0', 'c6-a')
    await seedEvidence('c6-a', 'L1', 'c6-b')
    await seedEvidence('c6-a', 'L1', 'c6-c')
    await seedEvidence('c6-b', 'L2', 'c6-d')
    await seedEvidence('c6-c', 'L2', 'c6-d')

    const result = await forgetAt(store.connection, 'c6-a')

    // 跳数降序；同跳按 id 升序。D 经两条路径到达，只出现一次且取最小跳数 2。
    expect(result.affected).toEqual([
      { id: 'c6-d', layer: 'L2', text: '汇合点', hops: 2 },
      { id: 'c6-b', layer: 'L2', text: '左枝', hops: 1 },
      { id: 'c6-c', layer: 'L2', text: '右枝', hops: 1 },
      { id: 'c6-a', layer: 'L1', text: '菱形根', hops: 0 },
    ])
    const ids = result.affected.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)

    const dLog = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.reason = 'forget root=c6-a depth=2' RETURN g.cascade_depth AS depth",
    )
    expect(dLog).toHaveLength(1)
    expect(Number(dLog[0]?.depth)).toBe(2)
    expect(await tombstones('c6-d')).toEqual({ invalidAt: FORGET_AT, expiredAt: null })
  })

  it('行 7：上层 B 已失效 ⇒ 进闭包但不重写、不新增 B 的 log/keyed 行；A 照常作废', async () => {
    await seedL0('c7-l0', 'c7 的原始观测')
    await seedMemory({ id: 'c7-a', layer: 'L1', text: '待遗忘', refs: ['c7-l0'] })
    await seedMemory({ id: 'c7-b', layer: 'L2', text: '早已作废', refs: ['c7-a'], invalidAt: OLD_INVALID_AT })
    await seedEvidence('c7-l0', 'L0', 'c7-a')
    await seedEvidence('c7-a', 'L1', 'c7-b')

    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()
    const result = await forgetAt(store.connection, 'c7-a')

    // B 不在 affected 里（没有作废它），A 照常。
    expect(result.affected).toEqual([
      { id: 'c7-a', layer: 'L1', text: '待遗忘', hops: 0 },
    ])
    // B 的 invalid_at 保持原值。
    expect(await tombstones('c7-b')).toEqual({ invalidAt: OLD_INVALID_AT, expiredAt: null })
    expect(await tombstones('c7-a')).toEqual({ invalidAt: null, expiredAt: FORGET_AT })
    // 只多了 A 自己的 log + keyed 各一行，B 一行都没有。
    expect(await countGenerationLog()).toBe(logBefore + 1)
    expect(await countKeyedDecision()).toBe(keyedBefore + 1)
    const bKeyed = await queryAll(
      store.connection,
      "MATCH (k:keyed_decision) WHERE k.old_id = 'c7-b' RETURN k.old_id AS old_id",
    )
    expect(bKeyed).toHaveLength(0)
  })
})

describe('forgetMemory：幂等重放与迟到事件（矩阵行 9–11）', () => {
  it('行 9：目标 expired_at 已非空但 invalid_at 为空 ⇒ 幂等 success 且不级联', async () => {
    await seedL0('c9-l0', 'c9 的原始观测')
    await seedMemory({ id: 'c9-a', layer: 'L1', text: '此前已遗忘', refs: ['c9-l0'], expiredAt: OLD_INVALID_AT })
    await seedMemory({ id: 'c9-b', layer: 'L2', text: '仍然有效的上层', refs: ['c9-a'] })
    await seedEvidence('c9-l0', 'L0', 'c9-a')
    await seedEvidence('c9-a', 'L1', 'c9-b')

    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()
    const result = await forgetAt(store.connection, 'c9-a')

    expect(result.alreadyExpired).toBe(true)
    expect(result.affected).toEqual([
      { id: 'c9-a', layer: 'L1', text: '此前已遗忘', hops: 0 },
    ])
    // 不级联：上层保持有效。
    expect(await tombstones('c9-b')).toEqual({ invalidAt: null, expiredAt: null })
    // 不重复写：两本账都没有新增。
    expect(await countGenerationLog()).toBe(logBefore)
    expect(await countKeyedDecision()).toBe(keyedBefore)
  })

  it('行 10：同 id 两次 forget ⇒ 两本账行数不变，keyed_decision.old_id=目标 至多 1 行', async () => {
    await seedL0('c10-l0', 'c10 的原始观测')
    await seedMemory({ id: 'c10-a', layer: 'L1', text: '重放用例', refs: ['c10-l0'] })
    await seedEvidence('c10-l0', 'L0', 'c10-a')

    await forgetAt(store.connection, 'c10-a')
    const logAfterFirst = await countGenerationLog()
    const keyedAfterFirst = await countKeyedDecision()
    await forgetAt(store.connection, 'c10-a')

    expect(await countGenerationLog()).toBe(logAfterFirst)
    expect(await countKeyedDecision()).toBe(keyedAfterFirst)
    const rows = await queryAll(
      store.connection,
      "MATCH (k:keyed_decision) WHERE k.old_id = 'c10-a' RETURN count(k) AS c",
    )
    expect(Number(rows[0]?.c)).toBe(1)
  })

  it('行 11：迟到事件 —— 用旧文本重写不复活，库里仍只有 1 条同文本节点（D-A）', async () => {
    const text = '迟到事件用的同文本'
    const written = await store.upsertMemory({ layer: 'L1', text })
    const before = await getMemoryById(store.connection, written.id)
    expect(before?.expiredAt).toBeNull()

    await forgetAt(store.connection, written.id)
    const forgotten = await getMemoryById(store.connection, written.id)
    expect(forgotten?.expiredAt).toBe(FORGET_AT)

    // 迟到：同文本重写（同一指纹 ⇒ 同一 id）。
    const replay = await store.upsertMemory({ layer: 'L1', text })
    expect(replay.id).toBe(written.id)

    const after = await getMemoryById(store.connection, written.id)
    expect(after?.expiredAt).toBe(FORGET_AT)
    expect(after?.validAt).toBe(forgotten?.validAt)
    // 不复活：不进 list。
    const listed = await listMemories(store.connection, { query: text, limit: 20 })
    expect(listed.map((entry) => entry.id)).not.toContain(written.id)
    // 库内仍只有一条同文本节点（同文本生成不出第二个 id）。
    const same = await queryRows(
      store.connection,
      'MATCH (m:memory) WHERE m.layer = $layer AND m.text = $text RETURN count(m) AS c',
      { layer: 'L1', text },
    )
    expect(Number(same[0]?.c)).toBe(1)
    // dedup 记了一条 uncertain（skip-resurrect），这是矩阵行 11 声明的可观察后果。
    // 走真实的去重写路径（inbox 精炼用的那条），不是 upsertMemory。
    const deduped = await runInTransaction(store.connection, () => writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      text,
      embedding: null,
      sourceRefs: ['late-ref'],
      validAt: '2026-07-01T00:00:00.000Z',
    }))
    expect(deduped.outcome).toBe('fingerprint-merge')
    const afterDedup = await getMemoryById(store.connection, written.id)
    // 不复活：expired_at 逐字保留，valid_at 不动；只合并 source_refs。
    expect(afterDedup?.expiredAt).toBe(FORGET_AT)
    expect(afterDedup?.validAt).toBe(forgotten?.validAt)
    expect(afterDedup?.sourceRefs).toContain('late-ref')
    const uncertain = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'resurrect_memory' AND g.outcome = 'uncertain'" +
      " RETURN g.reason AS reason",
    )
    expect(uncertain).toHaveLength(1)
    expect(String(uncertain[0]?.reason)).toContain('skip-resurrect expired_at=')
  })
})

describe('forgetMemory：失败注入（矩阵行 13、15）', () => {
  it('行 13：写 invalid_at 阶段抛错 ⇒ 整个事务回滚，无半级联状态', async () => {
    await seedL0('c13-l0', 'c13 的原始观测')
    await seedMemory({ id: 'c13-a', layer: 'L1', text: '回滚根', refs: ['c13-l0'] })
    await seedMemory({ id: 'c13-b', layer: 'L2', text: '回滚上层', refs: ['c13-a'] })
    await seedEvidence('c13-l0', 'L0', 'c13-a')
    await seedEvidence('c13-a', 'L1', 'c13-b')

    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()
    const failing = connectionFailingOn(store.connection, 'invalid_at')

    await expect(forgetAt(failing, 'c13-a')).rejects.toThrow(/注入的写失败/)

    // 目标没被遗忘、上层没被作废。
    expect(await tombstones('c13-a')).toEqual({ invalidAt: null, expiredAt: null })
    expect(await tombstones('c13-b')).toEqual({ invalidAt: null, expiredAt: null })
    // 已写下的两本账被一起回滚（这是「无半级联状态」的实质）。
    expect(await countGenerationLog()).toBe(logBefore)
    expect(await countKeyedDecision()).toBe(keyedBefore)
  })

  it('行 15：缺 generation_log / 边表 ⇒ 抛可读错误，不以「成功」收尾', async () => {
    const bareDir = await makeTempDir('omw-forget-bare-')
    const bare = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(bareDir),
      dim: DIM,
      modelId: MODEL,
    })
    try {
      await bare.connection.query(
        `CREATE (l:l0_raw {id: 'c15-l0', raw_text: 'c15 原始观测', recorded_at: '${T0}', actor: 'test'})`,
      )
      await bare.connection.query(
        `CREATE (m:memory {id: 'c15-a', layer: 'L1', kind: '', priority: 0, text: '缺表用例',` +
        ` valid_at: '${T0}', recorded_at: '${T0}', source_refs: ['c15-l0']})`,
      )
      await bare.connection.query(
        "MATCH (a:l0_raw {id: 'c15-l0'}), (b:memory {id: 'c15-a'}) MERGE (a)-[:EVIDENCE]->(b)",
      )
      expect(await computeAuditGap(bare.connection)).toBe(0)

      // 审计表缺失：账本写不进去 ⇒ 必须失败，且目标没有被写上半套状态。
      await bare.connection.query('DROP TABLE generation_log')
      await expect(forgetAt(bare.connection, 'c15-a')).rejects.toThrow(/does not exist/i)
      const afterAuditGap = await bare.connection.query(
        "MATCH (m:memory {id: 'c15-a'}) RETURN m.expired_at AS expired_at",
      )
      const rows = await (Array.isArray(afterAuditGap) ? afterAuditGap[0]! : afterAuditGap).getAll()
      expect(rows[0]?.expired_at).toBeNull()
      // 审计表缺失 ⇒ status 口径的 audit_gap 是「未知」，不静默报 0。
      expect(await computeAuditGap(bare.connection)).toBeNull()

      // 边表缺失：反向闭包语句无法执行 ⇒ 同样必须失败（不静默降级成「无级联」）。
      await bare.connection.query('DROP TABLE EVIDENCE')
      await expect(forgetAt(bare.connection, 'c15-a')).rejects.toThrow(/does not exist/i)
      expect(await computeEvidenceGap(bare.connection, T0)).toBeNull()
    } finally {
      await bare.close()
    }
  })
})

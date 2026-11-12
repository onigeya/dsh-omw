/**
 * 有效性谓词钉（Story 2.6 评审补钉 P9①/P9② / T9，VG-5 + VG-6）。
 *
 * 两条只有「种子真的落在边界上」才能暴露：
 * 1. `checkReachableToL0` 的有效性三条件（AD-19:175）——未来 `valid_at` 的节点必须判
 *    `not-effective`，且**不进** `computeEiiViolations`（违例集只由有效节点构成）；
 * 2. `recallNeighbors` 的 `invalid_at IS NULL AND expired_at IS NULL`——已失效节点不得被
 *    召回（否则关系识别会把 RELATED 连到墓碑上）。
 *
 * 独立成文件：本文件 1 个用例 = 1 次开库（LadybugDB 每进程约 15 库封顶，db-edge-tables
 * 已有 17 个用例各开一库，不能再往里加）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { checkReachableToL0, computeEiiViolations } from '../src/db/eii'
import { ensureEdgeTables, writeEvidenceEdges } from '../src/db/edges'
import { memoryNodeId } from '../src/db/id'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { recallNeighbors } from '../src/wiki/relations'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = '2026-06-01T00:00:00.000Z'
const PAST = '2026-01-01T00:00:00.000Z'
const FUTURE = '2027-01-01T00:00:00.000Z'
const E1 = [1, 0, 0, 0]

let store: MemoryDatabase

beforeEach(async () => {
  const dir = await makeTempDir('omw-eff-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed' })
  await ensureEdgeTables(store.connection)
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

/**
 * 直写节点：可精确控制 `valid_at` / `invalid_at` / `embedding`（走 upsertMemory 就写不出
 * 未来 valid_at 或墓碑，那正是本条要钉的边界）。
 */
async function seedNode(args: {
  id: string
  text: string
  validAt?: string
  invalidAt?: string | null
  expiredAt?: string | null
  embedding?: readonly number[] | null
}): Promise<void> {
  const cols = [
    "id: '" + args.id + "'",
    "layer: 'L1'",
    "kind: 'work_fact'",
    'priority: 0',
    "text: '" + args.text + "'",
    "valid_at: '" + (args.validAt ?? PAST) + "'",
    "recorded_at: '" + PAST + "'",
    'source_refs: []',
  ]
  if (args.invalidAt) cols.push("invalid_at: '" + args.invalidAt + "'")
  if (args.expiredAt) cols.push("expired_at: '" + args.expiredAt + "'")
  if (args.embedding) {
    cols.push('embedding: [' + args.embedding.map((v) => String(v)).join(', ') + ']')
    cols.push("embedding_model_id: 'test-embed'")
    cols.push('embedding_dim: ' + String(DIM))
  }
  await store.connection.query('CREATE (m:memory {' + cols.join(', ') + '})')
}

async function seedL0(id: string): Promise<void> {
  await store.connection.query(
    "CREATE (l:l0_raw {id: '" + id + "', raw_text: '原文', recorded_at: '" + PAST + "', actor: 'system'})",
  )
}

describe('P9①：有效性三条件（未来 valid_at / 失效 / forget）', () => {
  it('未来 valid_at ⇒ not-effective 且不算 EII 违例；失效节点不被召回', async () => {
    // ① 未来 valid_at 的节点：有真实 L0 证据链，但「尚未生效」⇒ 必须 not-effective。
    const futureId = memoryNodeId('L1', '未来的事实')
    await seedL0('eff-l0-future')
    await seedNode({ id: futureId, text: '未来的事实', validAt: FUTURE, embedding: E1 })
    await writeEvidenceEdges(store.connection, [
      { fromId: 'eff-l0-future', fromLayer: 'L0', toId: futureId, toLayer: 'L1', reason: 'refine' },
    ])

    const reach = await checkReachableToL0(store.connection, futureId, NOW)
    expect(reach.pass).toBe(false)
    expect(reach.failingReasons).toEqual(['not-effective'])
    // 违例集只由**有效**节点构成：尚未生效的节点既不是违例，也不该被要求有证据链。
    expect(await computeEiiViolations(store.connection, NOW)).not.toContain(futureId)

    // ② 已失效（invalid_at）与用户 forget（expired_at）：都不得被 recall 召回。
    const invalidId = memoryNodeId('L1', '已失效的事实')
    const expiredId = memoryNodeId('L1', '被遗忘的事实')
    await seedNode({ id: invalidId, text: '已失效的事实', invalidAt: '2026-03-01T00:00:00.000Z', embedding: E1 })
    await seedNode({ id: expiredId, text: '被遗忘的事实', expiredAt: '2026-03-01T00:00:00.000Z', embedding: E1 })
    // 一条有效的对照节点，证明召回本身在工作（否则「召回为空」可能只是查询坏了）。
    const aliveId = memoryNodeId('L1', '仍然有效的事实')
    await seedNode({ id: aliveId, text: '仍然有效的事实', embedding: E1 })

    const neighbors = await recallNeighbors(store.connection, { embedding: E1, k: 10, now: NOW })
    const ids = neighbors.map((n) => n.id)
    expect(ids).toContain(aliveId)
    expect(ids).not.toContain(invalidId)
    expect(ids).not.toContain(expiredId)
    expect(ids).not.toContain(futureId)

    // 失效节点的可达性结论也是 not-effective（与 recall 的过滤口径一致）。
    expect((await checkReachableToL0(store.connection, invalidId, NOW)).failingReasons).toEqual(['not-effective'])
    expect((await checkReachableToL0(store.connection, expiredId, NOW)).failingReasons).toEqual(['not-effective'])

    // 兜底：这三条都不该出现在 EII 违例集里。
    const violations = await computeEiiViolations(store.connection, NOW)
    expect(violations).toContain(aliveId) // 有效但无证据链 ⇒ 违例（正对照）
    expect(violations).not.toContain(futureId)
    expect(violations).not.toContain(invalidId)
    expect(violations).not.toContain(expiredId)
    void queryAll
  })
})

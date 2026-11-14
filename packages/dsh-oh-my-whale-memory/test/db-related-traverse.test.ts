/**
 * `traverseRelated` 真库测试（Story 3.2 / FR-12）。
 *
 * 用**真实 GROUP schema**（EVIDENCE 两对端点：l0_raw→memory + memory→memory）验证：
 * - 端点显式 `(n:memory)` ⇒ 无向 EVIDENCE 不会把 l0_raw 带进结果面（探针 2b 的反例）；
 * - 无向解释：从高层/邻居反向也能到达（RELATED 与 EVIDENCE 都无向）；
 * - 同 id 多路径去重取 **min hops**、两型在同 hops 下的确定性排序；
 * - 起点不存在 ⇒ `startFound:false` 的空结果（不抛错）；
 * - depth 夹紧 [1,3]（入参 99 → 3）。
 *
 * 开库次数：本文件共享 1 次（LadybugDB 每进程约 15 个实例封顶）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { writeEvidenceEdges, writeRelatedEdges, traverseRelated } from '../src/db/edges'
import { resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const T0 = '2026-01-01T00:00:00.000Z'

let store: MemoryDatabase

async function exec(statement: string): Promise<void> {
  await store.connection.query(statement)
}

async function seedL0(id: string, rawText: string | null): Promise<void> {
  await exec(`CREATE (l:l0_raw {id: '${id}', raw_text: ${rawText === null ? 'NULL' : `'${rawText}'`}, recorded_at: '${T0}', actor: 'test'})`)
}

async function seedMemory(id: string, layer: string, invalidAt: string | null = null): Promise<void> {
  await exec([
    `CREATE (m:memory {id: '${id}', layer: '${layer}', kind: '', priority: 0, text: '${id} 的内容',`,
    `  valid_at: '${T0}', recorded_at: '${T0}',`,
    `  invalid_at: ${invalidAt === null ? 'NULL' : `'${invalidAt}'`}, expired_at: NULL})`,
  ].join(' '))
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-related-traverse-')),
    dim: DIM,
    modelId: 'test-embed',
  })

  // L0 → A（L1）→ B（L2）的证据链；A → C / A → D → C 的语义关联（C 有 1 跳与 2 跳两条路径）。
  await seedL0('L0', '原始观测')
  await seedMemory('A', 'L1')
  await seedMemory('B', 'L2')
  await seedMemory('C', 'L1')
  await seedMemory('D', 'L1')
  await writeEvidenceEdges(store.connection, [
    { fromId: 'L0', fromLayer: 'L0', toId: 'A', toLayer: 'L1', reason: 'ev-l0-a' },
    { fromId: 'A', fromLayer: 'L1', toId: 'B', toLayer: 'L2', reason: 'ev-a-b' },
  ])
  await writeRelatedEdges(store.connection, [
    { fromId: 'A', toId: 'C', reason: 'rel-a-c' },
    { fromId: 'A', toId: 'D', reason: 'rel-a-d' },
    { fromId: 'D', toId: 'C', reason: 'rel-d-c' },
  ])
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('traverseRelated：无向 BFS 与结果面约束（AC:872-880）', () => {
  it('A depth=2：两型各取无向变长路径；端点约束排除 l0_raw、C 取 min hops、reason 取末跳', async () => {
    const result = await traverseRelated(store.connection, { id: 'A', depth: 2 })

    expect(result).toMatchObject({ id: 'A', depth: 2, startFound: true })
    // 命中 B/C/D 三个 memory 邻居；L0 是 EVIDENCE 的另一端点但**不是结果**（端点 `(n:memory)`）。
    expect(result.results.map((item) => item.id)).toEqual(['B', 'C', 'D'])
    expect(result.total).toBe(3)
    expect(result.results.some((item) => item.id === 'L0')).toBe(false)

    const byId = new Map(result.results.map((item) => [item.id, item]))
    // B 由 EVIDENCE 命中（1 跳）；reason 来自 relationships(p) 的末元素。
    expect(byId.get('B')).toMatchObject({ layer: 'L2', hops: 1, edgeType: 'EVIDENCE', reason: 'ev-a-b', invalid: false })
    // C 有 A→C（1 跳）与 A→D→C（2 跳）两条路径 ⇒ 去重取 min hops=1 的那条。
    expect(byId.get('C')).toMatchObject({ hops: 1, edgeType: 'RELATED', reason: 'rel-a-c', invalid: false })
    expect(byId.get('D')).toMatchObject({ hops: 1, edgeType: 'RELATED', reason: 'rel-a-d', invalid: false })
    // 全有效路径 ⇒ pathValid=true（spec D4 的判定原语）。
    expect(result.results.every((item) => item.pathValid)).toBe(true)
    // 文本原样带回（截断在工具面，256-token 口径）。
    expect(byId.get('B')?.text).toBe('B 的内容')
  })

  it('无向：从 B 反向也能回到 A（EVIDENCE 存储方向是 A→B）', async () => {
    const fromB = await traverseRelated(store.connection, { id: 'B', depth: 1 })
    expect(fromB.results.map((item) => item.id)).toEqual(['A'])
    expect(fromB.results[0]).toMatchObject({ hops: 1, edgeType: 'EVIDENCE', reason: 'ev-a-b' })

    // RELATED 同样无向：从 C 反向到 A / D。
    const fromC = await traverseRelated(store.connection, { id: 'C', depth: 1 })
    expect(fromC.results.map((item) => item.id).sort()).toEqual(['A', 'D'])
  })

  it('起点不存在：startFound=false 的空结果（AC:882-884：不抛错）', async () => {
    const missing = await traverseRelated(store.connection, { id: 'absent-id', depth: 2 })
    expect(missing).toMatchObject({ startFound: false, total: 0, results: [] })
  })

  it('depth 夹紧 [1,3]：99 → 3、0 → 1；缺省 2', async () => {
    expect((await traverseRelated(store.connection, { id: 'A', depth: 99 })).depth).toBe(3)
    expect((await traverseRelated(store.connection, { id: 'A', depth: 0 })).depth).toBe(1)
    expect((await traverseRelated(store.connection, { id: 'A' })).depth).toBe(2)
  })
})

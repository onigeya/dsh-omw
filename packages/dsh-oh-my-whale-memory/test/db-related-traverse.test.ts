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
import {
  RelatedTraversalTimeoutError,
  RELATED_MAX_RESULTS,
  traverseRelated,
  writeEvidenceEdges,
  writeRelatedEdges,
} from '../src/db/edges'
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

async function seedMemory(
  id: string,
  layer: string,
  invalidAt: string | null = null,
  expiredAt: string | null = null,
): Promise<void> {
  await exec([
    `CREATE (m:memory {id: '${id}', layer: '${layer}', kind: '', priority: 0, text: '${id} 的内容',`,
    `  valid_at: '${T0}', recorded_at: '${T0}',`,
    `  invalid_at: ${invalidAt === null ? 'NULL' : `'${invalidAt}'`},`,
    `  expired_at: ${expiredAt === null ? 'NULL' : `'${expiredAt}'`}})`,
  ].join(' '))
}

/** 批量写 RELATED 边（`from` → 每个 `to`，reason 统一前缀）。 */
async function relate(from: string, to: readonly string[], reasonPrefix: string): Promise<void> {
  await writeRelatedEdges(
    store.connection,
    to.map((target) => ({ fromId: from, toId: target, reason: `${reasonPrefix}-${target}` })),
  )
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

  // ---- B2 夹具（各场景独立连通分量，互不干扰） ----
  // ① 失效中间节点可穿过：i1 → i2(失效) → i3。
  await seedMemory('i1', 'L1')
  await seedMemory('i2', 'L1', '2026-03-01T00:00:00.000Z')
  await seedMemory('i3', 'L1')
  await relate('i1', ['i2'], 'rel-i1')
  await relate('i2', ['i3'], 'rel-i2')

  // ② 有效节点但唯一路径经失效中间节点：q0 → qm(失效) → qt。
  await seedMemory('q0', 'L1')
  await seedMemory('qm', 'L1', null, '2026-03-02T00:00:00.000Z')
  await seedMemory('qt', 'L2')
  await relate('q0', ['qm'], 'rel-q0')
  await relate('qm', ['qt'], 'rel-qm')

  // ③ 有效优先 / 不足补失效：p0 有 2 个有效 + 3 个失效邻居。
  await seedMemory('p0', 'L1')
  await seedMemory('pv1', 'L1')
  await seedMemory('pv2', 'L1')
  await seedMemory('pi1', 'L1', '2026-03-03T00:00:00.000Z')
  await seedMemory('pi2', 'L1', null, '2026-03-04T00:00:00.000Z')
  await seedMemory('pi3', 'L1', '2026-03-05T00:00:00.000Z')
  await relate('p0', ['pv1', 'pv2', 'pi1', 'pi2', 'pi3'], 'rel-p0')

  // ④ 结果上限：c0 有 21 个有效 + 3 个失效邻居（有效已超 20 ⇒ 失效不补位）。
  await seedMemory('c0', 'L1')
  const capValid = Array.from({ length: 21 }, (_, index) => `cv${String(index + 1).padStart(2, '0')}`)
  for (const id of capValid) await seedMemory(id, 'L1')
  for (const id of ['ci1', 'ci2', 'ci3']) await seedMemory(id, 'L1', '2026-03-06T00:00:00.000Z')
  await relate('c0', [...capValid, 'ci1', 'ci2', 'ci3'], 'rel-c0')

  // ⑤ 全部邻居无全有效路径：e0 → ea(失效) / eb(过期)。
  await seedMemory('e0', 'L1')
  await seedMemory('ea', 'L1', '2026-03-07T00:00:00.000Z')
  await seedMemory('eb', 'L1', null, '2026-03-08T00:00:00.000Z')
  await relate('e0', ['ea', 'eb'], 'rel-e0')

  // ⑥ 起点自身失效：s0(失效) → s1。
  await seedMemory('s0', 'L1', '2026-03-09T00:00:00.000Z')
  await seedMemory('s1', 'L1')
  await relate('s0', ['s1'], 'rel-s0')

  // ⑦ F-02：同一邻居「短失效路径 + 长有效路径」——t1 → tin(失效) → tn（2 跳、含失效中间节点）；
  //    t1 → tb → tc → tn（3 跳、全有效）。depth=3 时 tn 必须按**跨路径 OR** 判为有效。
  await seedMemory('t1', 'L1')
  await seedMemory('tin', 'L1', '2026-03-10T00:00:00.000Z')
  await seedMemory('tn', 'L1')
  await seedMemory('tb', 'L1')
  await seedMemory('tc', 'L1')
  await relate('t1', ['tin'], 'rel-t1')
  await relate('tin', ['tn'], 'rel-tin')
  await relate('t1', ['tb'], 'rel-t1b')
  await relate('tb', ['tc'], 'rel-tb')
  await relate('tc', ['tn'], 'rel-tc')

  // ⑧ F-02：>20 命中且有效路径来自截断外——u0 有 20 个失效 RELATED 邻居（1 跳）占满 top-20；
  //    另有一条经 l0_raw 的 EVIDENCE 桥：u0 ← un-l0 → un（2 跳、邻居侧全有效）。
  //    un 排在第 21 名被截断，但 anyValidPath（截断前聚合）必须为 true。
  await seedMemory('u0', 'L1')
  const uiIds = Array.from({ length: 20 }, (_, index) => `ui${String(index + 1).padStart(2, '0')}`)
  for (const id of uiIds) await seedMemory(id, 'L1', '2026-03-11T00:00:00.000Z')
  await relate('u0', uiIds, 'rel-u0')
  await seedMemory('un', 'L1')
  await seedL0('un-l0', '桥梁原始观测')
  await writeEvidenceEdges(store.connection, [
    { fromId: 'un-l0', fromLayer: 'L0', toId: 'u0', toLayer: 'L1', reason: 'ev-bridge-u0' },
    { fromId: 'un-l0', fromLayer: 'L0', toId: 'un', toLayer: 'L1', reason: 'ev-bridge-un' },
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
    expect(missing).toMatchObject({
      startFound: false,
      total: 0,
      results: [],
      // 起点不存在时 start 为零值（B3 据此不渲染「起点已失效」，也不误判成失效起点）。
      start: { invalid: false, invalidAt: null, expiredAt: null },
    })
  })

  it('depth 夹紧 [1,3]：99 → 3、0 → 1；缺省 2', async () => {
    expect((await traverseRelated(store.connection, { id: 'A', depth: 99 })).depth).toBe(3)
    expect((await traverseRelated(store.connection, { id: 'A', depth: 0 })).depth).toBe(1)
    expect((await traverseRelated(store.connection, { id: 'A' })).depth).toBe(2)
  })
})

describe('失效节点分组（AC:886/888/889 / spec D3/D4）', () => {
  it('i1→i2(失效)→i3：失效中间节点不被整条剔除；i2 标 invalid、i3 的 pathValid=false', async () => {
    const result = await traverseRelated(store.connection, { id: 'i1', depth: 2 })

    // 关键反例：路径级有效性过滤（eii 的 all(...) WHERE 形态）会把 i3 一起剔掉；这里两条都在。
    expect(result.results.map((item) => item.id)).toEqual(['i2', 'i3'])
    const byId = new Map(result.results.map((item) => [item.id, item]))
    expect(byId.get('i2')).toMatchObject({
      hops: 1,
      invalid: true,
      invalidAt: '2026-03-01T00:00:00.000Z',
      pathValid: false,
    })
    expect(byId.get('i3')).toMatchObject({ hops: 2, invalid: false, pathValid: false })
  })

  it('有效优先、不足补失效：2 有效 + 3 失效 ⇒ 有效在前，失效补入并带标记（AC:888）', async () => {
    const result = await traverseRelated(store.connection, { id: 'p0', depth: 1 })

    expect(result.total).toBe(5)
    expect(result.results).toHaveLength(5)
    expect(result.results.slice(0, 2).map((item) => item.id)).toEqual(['pv1', 'pv2'])
    expect(result.results.slice(0, 2).every((item) => !item.invalid)).toBe(true)
    expect(result.results.slice(2).map((item) => item.id).sort()).toEqual(['pi1', 'pi2', 'pi3'])
    expect(result.results.slice(2).every((item) => item.invalid)).toBe(true)
  })

  it('有效命中 ≥20 ⇒ 失效不补位（21 有效 + 3 失效 → 20 条全有效）', async () => {
    const result = await traverseRelated(store.connection, { id: 'c0', depth: 1 })

    expect(result.total).toBe(24)
    expect(result.results).toHaveLength(RELATED_MAX_RESULTS)
    expect(result.results.every((item) => !item.invalid)).toBe(true)
  })

  it('全部邻居无全有效路径 ⇒ pathValid 全 false（B3 据此返回 hint:evidence expired，AC:889）', async () => {
    const result = await traverseRelated(store.connection, { id: 'e0', depth: 1 })

    expect(result.total).toBe(2)
    expect(result.results.every((item) => item.invalid)).toBe(true)
    expect(result.results.every((item) => !item.pathValid)).toBe(true)
  })

  it('有效节点但唯一路径经失效中间节点 ⇒ invalid=false 且 pathValid=false（D4 判定所需）', async () => {
    const result = await traverseRelated(store.connection, { id: 'q0', depth: 2 })

    const qt = result.results.find((item) => item.id === 'qt')
    expect(qt).toMatchObject({ hops: 2, invalid: false, pathValid: false })
  })

  it('F-02：短失效路径 + 长有效路径并存 ⇒ pathValid 是跨路径 OR（不能只看 min-hops 那条）', async () => {
    const result = await traverseRelated(store.connection, { id: 't1', depth: 3 })

    // 展示仍取 min hops（2 跳、经失效中间节点），但有效性按「存在至少一条全有效路径」判 true。
    const tn = result.results.find((item) => item.id === 'tn')
    expect(tn).toMatchObject({ hops: 2, invalid: false, pathValid: true })
    expect(result.anyValidPath).toBe(true)
  })

  it('F-02：命中 >20 时 anyValidPath 按截断前聚合（有效路径邻居不被 20 条截断丢弃）', async () => {
    const result = await traverseRelated(store.connection, { id: 'u0', depth: 2 })

    // 20 个失效邻居（1 跳）+ 经 l0_raw 桥的有效邻居 un（2 跳）= 21 命中。
    // AC:888 的「有效优先入选」保证有效路径邻居不会被 20 条上限丢弃；anyValidPath 仍按
    // **截断前全量**聚合（不依赖 results），故不会因截断误报 evidence expired。
    expect(result.total).toBe(21)
    expect(result.results).toHaveLength(RELATED_MAX_RESULTS)
    expect(result.anyValidPath).toBe(true)
    const un = result.results.find((item) => item.id === 'un')
    expect(un).toMatchObject({ hops: 2, invalid: false, pathValid: true })
    // top-20 名额：1 个有效邻居 + 19 个失效邻居（失效优先补位的那 19 个仍在 hop1 上）。
    expect(result.results.filter((item) => item.invalid)).toHaveLength(RELATED_MAX_RESULTS - 1)
  })
})

describe('起点语义（spec D5）', () => {
  it('起点自身失效 ⇒ 照常遍历、不拦截（它是锚点不是候选；hint 由 B3 渲染）', async () => {
    const result = await traverseRelated(store.connection, { id: 's0', depth: 1 })

    expect(result).toMatchObject({ id: 's0', startFound: true, total: 1 })
    expect(result.start).toMatchObject({ invalid: true, invalidAt: '2026-03-09T00:00:00.000Z' })
    expect(result.results[0]).toMatchObject({ id: 's1', hops: 1, invalid: false })
  })
})

describe('超时与确定性（spec D7/D8）', () => {
  it('超时 ⇒ RelatedTraversalTimeoutError（不吞成空结果/降级），为 B3 的 depth=1 重试铺路', async () => {
    // 假连接：prepare 永不 resolve ⇒ 确定性触发预算分支（真库上 1ms 超时会随机器快慢抖动）。
    const hanging = { prepare: () => new Promise(() => {}) } as unknown as Parameters<typeof traverseRelated>[0]
    const started = Date.now()

    await expect(traverseRelated(hanging, { id: 'A', timeoutMs: 10 }))
      .rejects.toBeInstanceOf(RelatedTraversalTimeoutError)
    // 预算分支生效且不会等满查询（底层查询仍在跑，本断言只钉调用方时延）。
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('确定性：同输入两次遍历的 id/hops/edgeType/invalid/reason 顺序完全一致', async () => {
    const first = await traverseRelated(store.connection, { id: 'A', depth: 2 })
    const second = await traverseRelated(store.connection, { id: 'A', depth: 2 })

    const project = (result: Awaited<ReturnType<typeof traverseRelated>>) =>
      result.results.map((item) => [item.id, item.hops, item.edgeType, item.invalid, item.reason])
    expect(project(second)).toEqual(project(first))
  })
})

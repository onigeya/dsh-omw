/**
 * 5k 规模只报数（Story 2.6 / 裁决 U3、spec Known Limitations #1）。
 *
 * **不设性能阈值**：CI 机器与负载差异会让毫秒断言变成 flake。本用例只做两件事——
 * 1. 用事实断言证明夹具真建起来了（节点/边计数），避免退出码掩盖空跑；
 * 2. 把各查询耗时打印出来，作为首周标定与后续优化的**观测记录**。
 *
 * 规模：5000 个 L1 节点 + 1200 条 l0_raw→L1 EVIDENCE 边（brief §2 已测包线是 1500 节点/1200 边，
 * 这里按 U3 把节点量提到 5k，边量保持已测的 1200），另加 50 条带向量的节点供 KNN。
 * 开库 1 次（LadybugDB 每进程约 15 库封顶）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { ensureEdgeTables } from '../src/db/edges'
import {
  checkReachableToL0,
  computeEiiViolations,
  computeEvidenceDrift,
  computeEvidenceGap,
} from '../src/db/eii'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { recallNeighbors } from '../src/wiki/relations'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NODES = 5_000
const EDGES = 1_200
const VECTOR_NODES = 50
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'
const BATCH = 500
const nodeId = (index: number): string => 'scale-node-' + String(index).padStart(5, '0')
const l0Id = (index: number): string => 'scale-l0-' + String(index).padStart(5, '0')

let store: MemoryDatabase

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const value = await run()
  console.log('[scale] ' + label + ': ' + (performance.now() - start).toFixed(1) + ' ms')
  return value
}

async function bulk(statement: string, items: readonly unknown[]): Promise<void> {
  const prepared = await store.connection.prepare(statement)
  for (let start = 0; start < items.length; start += BATCH) {
    await store.connection.execute(prepared, { items: items.slice(start, start + BATCH) })
  }
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-scale-')),
    dim: DIM,
    modelId: 'test-embed',
  })
  await ensureEdgeTables(store.connection)

  const buildStart = performance.now()
  // 节点：前 VECTOR_NODES 条带向量（供 KNN），前 EDGES 条的 source_refs 指向同名 L0 行。
  await bulk(
    'UNWIND $items AS it CREATE (m:memory {id: it.id, layer: \'L1\', kind: \'work_fact\', priority: 0, ' +
      'text: it.text, valid_at: it.valid_at, recorded_at: it.recorded_at, source_refs: it.refs})',
    Array.from({ length: NODES }, (_, index) => ({
      id: nodeId(index),
      text: '规模夹具事实 ' + String(index),
      valid_at: T0,
      recorded_at: T0,
      refs: index < EDGES ? [l0Id(index)] : [],
    })),
  )
  await bulk(
    'UNWIND $items AS it CREATE (l:l0_raw {id: it.id, raw_text: it.raw_text, recorded_at: it.recorded_at, actor: \'system\'})',
    Array.from({ length: EDGES }, (_, index) => ({
      id: l0Id(index),
      raw_text: '捕获原文 ' + String(index),
      recorded_at: T0,
    })),
  )
  await bulk(
    'UNWIND $items AS it MATCH (a:l0_raw {id: it.from}), (b:memory {id: it.to}) ' +
      'CREATE (a)-[:EVIDENCE {reason: \'refine\'}]->(b)',
    Array.from({ length: EDGES }, (_, index) => ({ from: l0Id(index), to: nodeId(index) })),
  )
  // KNN 候选：把前 VECTOR_NODES 条的 embedding 用 UNWIND 批量补上。
  await bulk(
    'UNWIND $items AS it MATCH (m:memory {id: it.id}) ' +
      'SET m.embedding = it.embedding, m.embedding_model_id = \'test-embed\', m.embedding_dim = ' + String(DIM),
    // 全用非整数字面量：LadybugDB 按 JS 值推断 STRUCT 字段类型，整数会推成 INT64[] 而与
    // FLOAT[dim] 列不兼容（实测报 incompatible STRUCT(... INT64[]) and STRUCT(... DOUBLE[])）。
    Array.from({ length: VECTOR_NODES }, (_, index) => ({
      id: nodeId(index),
      embedding: [0.9999, index / 1000 + 0.0001, 0.0011, 0.0012],
    })),
  )
  console.log('[scale] 夹具构建（' + NODES + ' 节点 / ' + EDGES + ' 边 / ' + VECTOR_NODES + ' 向量）: ' +
    (performance.now() - buildStart).toFixed(1) + ' ms')
  expect(await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS c')).toEqual([{ c: NODES }])
  expect(await queryAll(store.connection, 'MATCH ()-[e:EVIDENCE]->() RETURN count(*) AS c')).toEqual([{ c: EDGES }])
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('U3：5k 规模只报数', () => {
  it('EII / 漂移 / 可达性 / KNN 各跑一次，打印耗时（不断言阈值）', async () => {
    const eii = await timed('computeEiiViolations', () => computeEiiViolations(store.connection, NOW))
    const drift = await timed('computeEvidenceDrift', () => computeEvidenceDrift(store.connection, NOW))
    const gap = await timed('computeEvidenceGap', () => computeEvidenceGap(store.connection, NOW))
    const reachable = await timed('checkReachableToL0', () => checkReachableToL0(store.connection, nodeId(1), NOW))
    const neighbors = await timed('recallNeighbors(k=8)', () => recallNeighbors(store.connection, {
      embedding: [1.0, 0.0, 0.0, 0.0],
      k: 8,
      now: NOW,
    }))

    // 事实断言（非阈值）：未回填的 5000-1200 条无 L0 前驱 ⇒ EII 违例；有边的 1200 条可达。
    expect(eii.length).toBe(NODES - EDGES)
    expect(drift.refsWithoutEdges).toHaveLength(0)
    expect(drift.edgesWithoutRefs).toHaveLength(0)
    expect(gap?.total).toBe(NODES - EDGES)
    expect(reachable.pass).toBe(true)
    expect(neighbors).toHaveLength(8)
    console.log('[scale] 结果：EII=' + eii.length + ' 漂移=' +
      (drift.refsWithoutEdges.length + drift.edgesWithoutRefs.length) +
      ' gap=' + String(gap?.total) + ' KNN=' + neighbors.length)
  }, 120_000)
})

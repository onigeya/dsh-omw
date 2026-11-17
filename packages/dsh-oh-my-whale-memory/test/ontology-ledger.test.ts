/**
 * 本体闸门丢弃账本测试（Story 9.1 / T5、矩阵行 10）。
 *
 * 断言：
 * - 按维分桶读回，各维之和 = 候选丢失总数；
 * - 只写既有 generation_log（不建表），detail 是唯一计数载体；
 * - 审计表缺失 ⇒ null（status 渲染 n/a，不静默报 0）；
 * - 只读实例只读聚合、零写副作用（AD-12）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { insertGenerationLog } from '../src/db/audit'
import { queryAll } from '../src/db/memory'
import {
  ONTOLOGY_DISCARD_ACTION,
  countOntologyDrops,
  emptyOntologyDropCounts,
  ontologyDropDetail,
  parseOntologyDropDetail,
  sumOntologyDrops,
} from '../src/ontology/ledger'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = '2026-11-18T00:00:00.000Z'

let store: MemoryDatabase

beforeEach(async () => {
  const dir = await makeTempDir('omw-ontology-ledger-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed-model' })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

async function insertDropRow(dimension: Parameters<typeof ontologyDropDetail>[0], dropped: number): Promise<void> {
  await insertGenerationLog(store.connection, {
    recordedAt: NOW,
    actor: 'system',
    kind: 'refine',
    action: ONTOLOGY_DISCARD_ACTION,
    outcome: 'success',
    reason: 'dimension=' + dimension,
    detail: ontologyDropDetail(dimension, dropped),
  })
}

describe('按维分桶与守恒（AD-31:443 / SM-9 ③）', () => {
  it('各维丢弃数之和 = 候选丢失总数，其它 action / 非法 detail 不参与聚合', async () => {
    await insertDropRow('entityType', 3)
    await insertDropRow('entityType', 2)
    await insertDropRow('datatype', 4)
    // 非本 action 的行不得计入。
    await insertGenerationLog(store.connection, {
      recordedAt: NOW,
      actor: 'system',
      kind: 'refine',
      action: 'refine_inbox',
      outcome: 'success',
      detail: ontologyDropDetail('domainRange', 99),
    })
    // 损坏 / 旧格式 detail 不得把账算歪。
    await insertGenerationLog(store.connection, {
      recordedAt: NOW,
      actor: 'system',
      kind: 'refine',
      action: ONTOLOGY_DISCARD_ACTION,
      outcome: 'success',
      detail: '{"dimension":"not-a-dimension","dropped":5}',
    })

    const counts = await countOntologyDrops(store.connection)

    expect(counts).not.toBeNull()
    expect(counts).toEqual({
      ...emptyOntologyDropCounts(),
      entityType: 5,
      datatype: 4,
    })
    expect(sumOntologyDrops(counts!)).toBe(9)
  })

  it('detail 形状固定：dimension + dropped；非法行解析成 null', () => {
    expect(JSON.parse(ontologyDropDetail('domainRange', 2))).toEqual({ dimension: 'domainRange', dropped: 2 })
    expect(parseOntologyDropDetail(ontologyDropDetail('entityType', 2))).toEqual({ dimension: 'entityType', dropped: 2 })
    expect(parseOntologyDropDetail('not json')).toBeNull()
    expect(parseOntologyDropDetail('{"dimension":"nope","dropped":1}')).toBeNull()
    expect(parseOntologyDropDetail('{"dimension":"entityType","dropped":-1}')).toBeNull()
  })

  it('审计表缺失 ⇒ null（渲染 n/a，不静默报 0）', async () => {
    const missing = {
      query: async () => { throw new Error('Binder exception: Table generation_log does not exist.') },
    } as unknown as lbug.Connection
    expect(await countOntologyDrops(missing)).toBeNull()
  })
})

describe('只读聚合（AD-12：读侧零写副作用）', () => {
  it('countOntologyDrops 只读：行数前后不变，返回既有桶', async () => {
    await insertDropRow('relationType', 2)
    const before = await queryAll(store.connection, 'MATCH (g:generation_log) RETURN count(g) AS total')
    const counts = await countOntologyDrops(store.connection)
    const after = await queryAll(store.connection, 'MATCH (g:generation_log) RETURN count(g) AS total')

    expect(counts?.relationType).toBe(2)
    expect(Number(after[0]?.total)).toBe(Number(before[0]?.total))
    expect(Number(before[0]?.total)).toBe(1)
  })
})

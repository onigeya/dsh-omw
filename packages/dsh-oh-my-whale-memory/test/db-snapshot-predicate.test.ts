/**
 * 「当前快照」共享谓词的收敛回归钉（Story 3.1 / FR-15）。
 *
 * 断言四条读路都经 src/db/snapshot.ts 的唯一谓词实现：
 * - `listMemories`（浏览）：未来 valid_at / 未来 recorded_at / 墓碑节点被排除；
 * - `computeEvidenceDrift`（eii 的 EFFECTIVE_MEMORY_REFS 正集）：同上；
 * - `writeDeduplicatedMemory` 的 ANN 粗筛（dedup）：被排除节点不参与语义合并/版本作废；
 * - `recallNeighbors`（relations 的 RECALL_STATEMENT）：被排除节点不进邻接候选。
 *
 * 真库单一临时库、beforeAll 播种（LadybugDB 每进程约 15 个实例封顶，本文件 1 个）。
 * 时间口径：PAST = 2026-01-01、FUTURE = 2999-01-01，测试期真实时刻必然落在两者之间——
 * listMemories 用真实 now（无注入点），dedup/relations/eii 显式传 NOW=2026-06-01。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { listMemories, upsertMemory } from '../src/db/memory'
import { computeEvidenceDrift } from '../src/db/eii'
import { writeDeduplicatedMemory } from '../src/db/dedup'
import { recallNeighbors } from '../src/wiki/relations'
import { currentSnapshotPredicate } from '../src/db/snapshot'
import { memoryNodeId } from '../src/db/id'
import { resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const LAYER = 'L1'
const MODEL = 'test-embed'
const PAST = '2026-01-01T00:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
/** 同一向量：余弦 = 1，让 ANN/语义合并对「排除条件」敏感（排除只能来自谓词）。 */
const VECTOR = [1, 0, 0, 0]

const nid = (key: string, layer: string = LAYER): string => memoryNodeId(layer, key)

interface SeedOptions {
  readonly layer?: string
  readonly validAt?: string
  readonly recordedAt?: string
  readonly invalidAt?: string | null
  readonly expiredAt?: string | null
  readonly embedding?: readonly number[] | null
  readonly embeddingModelId?: string | null
  readonly sourceRefs?: readonly string[]
}

let store: MemoryDatabase

async function seed(key: string, options: SeedOptions = {}): Promise<string> {
  const layer = options.layer ?? LAYER
  await upsertMemory(store.connection, {
    layer,
    text: key,
    embedding: options.embedding ?? null,
    embeddingModelId: options.embedding ? (options.embeddingModelId ?? MODEL) : null,
    kind: '',
    priority: 0,
    validAt: options.validAt ?? PAST,
    recordedAt: options.recordedAt ?? PAST,
    sourceRefs: options.sourceRefs ?? [],
  })
  const id = nid(key, layer)
  if (options.invalidAt !== undefined || options.expiredAt !== undefined) {
    await setLifecycle(id, options.invalidAt ?? null, options.expiredAt ?? null)
  }
  return id
}

/** 置 invalid_at / expired_at（写路径不产出墓碑，测试用裸语句；与 db-generation-log 同法）。 */
async function setLifecycle(id: string, invalidAt: string | null, expiredAt: string | null): Promise<void> {
  const prepared = await store.connection.prepare(
    'MATCH (m:memory {id: $id}) SET m.invalid_at = $invalid_at, m.expired_at = $expired_at',
  )
  await store.connection.execute(prepared, { id, invalid_at: invalidAt, expired_at: expiredAt })
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-snapshot-')),
    dim: DIM,
    modelId: MODEL,
  })
})

afterAll(async () => {
  await store?.close()
  await cleanupTempDirs()
})

describe('currentSnapshotPredicate（唯一实现）', () => {
  it('拼出四条件，alias 与 nowExpr 可替换', () => {
    expect(currentSnapshotPredicate('m')).toBe(
      'm.valid_at <= $now AND m.recorded_at <= $now AND m.invalid_at IS NULL AND m.expired_at IS NULL',
    )
    expect(currentSnapshotPredicate('x', "'2026-01-01T00:00:00.000Z'")).toBe(
      "x.valid_at <= '2026-01-01T00:00:00.000Z' AND x.recorded_at <= '2026-01-01T00:00:00.000Z' AND x.invalid_at IS NULL AND x.expired_at IS NULL",
    )
  })
})

describe('浏览路（listMemories）', () => {
  it('未来 valid_at / 未来 recorded_at / 墓碑节点被排除，只留当前快照', async () => {
    const valid = await seed('快照-有效节点')
    await seed('快照-将来生效', { validAt: FUTURE })
    await seed('快照-将来记录', { recordedAt: FUTURE })
    await seed('快照-已失效', { invalidAt: PAST })
    await seed('快照-已过期', { expiredAt: PAST })

    const entries = await listMemories(store.connection, { limit: 100 })
    const ids = new Set(entries.map((entry) => entry.id))
    expect(ids.has(valid)).toBe(true)
    expect(entries.filter((entry) => entry.id === nid('快照-将来生效'))).toHaveLength(0)
    expect(entries.filter((entry) => entry.id === nid('快照-将来记录'))).toHaveLength(0)
    expect(entries.filter((entry) => entry.id === nid('快照-已失效'))).toHaveLength(0)
    expect(entries.filter((entry) => entry.id === nid('快照-已过期'))).toHaveLength(0)
  })
})

describe('eii 正集（EFFECTIVE_MEMORY_REFS）', () => {
  it('漂移 A 只统计当前快照节点的 source_refs', async () => {
    // 有效节点：ref 无边 ⇒ 计入漂移 A。
    await seed('漂移-有效', { sourceRefs: ['msg-drift-valid'] })
    // 非快照节点：即使 ref 无边也不得计入（它们不在正集里）。
    await seed('漂移-已失效', { invalidAt: PAST, sourceRefs: ['msg-drift-invalid'] })
    await seed('漂移-将来记录', { recordedAt: FUTURE, sourceRefs: ['msg-drift-future'] })
    await seed('漂移-将来生效', { validAt: FUTURE, sourceRefs: ['msg-drift-future-valid'] })

    const drift = await computeEvidenceDrift(store.connection, NOW)
    const driftRefs = new Set(drift.refsWithoutEdges.map((entry) => entry.ref))
    expect(driftRefs.has('msg-drift-valid')).toBe(true)
    expect(driftRefs.has('msg-drift-invalid')).toBe(false)
    expect(driftRefs.has('msg-drift-future')).toBe(false)
    expect(driftRefs.has('msg-drift-future-valid')).toBe(false)
  })
})

describe('dedup ANN 粗筛（ANN_CANDIDATE_STATEMENT）', () => {
  it('控制组：同向量有效节点参与语义合并（证明排除只能来自谓词）', async () => {
    await seed('去重-有效-同向量', { embedding: VECTOR })
    const written = await writeDeduplicatedMemory(store.connection, {
      layer: LAYER,
      text: '去重-有效-同向量的另一表述',
      embedding: VECTOR,
      embeddingModelId: MODEL,
    }, { now: () => new Date(NOW) })
    expect(written.outcome).toBe('semantic-merge')
    expect(written.id).toBe(nid('去重-有效-同向量'))
  })

  it('未来 valid_at / 未来 recorded_at / 墓碑节点不参与语义合并（outcome=created）', async () => {
    // 用 L2 + 每条正交向量：既避开上面的 L1 有效节点（layer 过滤），也让三个用例互不相似
    // （否则前一个用例 created 出的节点会成为后一个用例的语义合并目标）。
    const axis = (index: number): number[] => [0, 0, 0, 0].map((_, at) => (at === index ? 1 : 0))

    await seed('去重-将来生效', { layer: 'L2', validAt: FUTURE, embedding: axis(0) })
    const futureValid = await writeDeduplicatedMemory(store.connection, {
      layer: 'L2',
      text: '去重-将来生效-的新表述',
      embedding: axis(0),
      embeddingModelId: MODEL,
    }, { now: () => new Date(NOW) })
    expect(futureValid.outcome).toBe('created')
    // 落库的是新节点（新文本指纹），不是被谓词排除的旧节点。
    expect(futureValid.id).toBe(nid('去重-将来生效-的新表述', 'L2'))

    await seed('去重-将来记录', { layer: 'L2', recordedAt: FUTURE, embedding: axis(1) })
    const futureRecorded = await writeDeduplicatedMemory(store.connection, {
      layer: 'L2',
      text: '去重-将来记录-的新表述',
      embedding: axis(1),
      embeddingModelId: MODEL,
    }, { now: () => new Date(NOW) })
    expect(futureRecorded.outcome).toBe('created')

    await seed('去重-已失效', { layer: 'L2', invalidAt: PAST, embedding: axis(2) })
    const invalidated = await writeDeduplicatedMemory(store.connection, {
      layer: 'L2',
      text: '去重-已失效-的新表述',
      embedding: axis(2),
      embeddingModelId: MODEL,
    }, { now: () => new Date(NOW) })
    expect(invalidated.outcome).toBe('created')
  })
})

describe('relations 邻接候选（RECALL_STATEMENT）', () => {
  it('只返回当前快照节点（有效向量命中，其余被谓词排除）', async () => {
    await seed('关系-有效', { embedding: VECTOR })
    await seed('关系-将来生效', { validAt: FUTURE, embedding: VECTOR })
    await seed('关系-将来记录', { recordedAt: FUTURE, embedding: VECTOR })
    await seed('关系-已过期', { expiredAt: PAST, embedding: VECTOR })

    const neighbors = await recallNeighbors(store.connection, {
      embedding: VECTOR,
      k: 10,
      now: NOW,
    })
    const ids = neighbors.map((neighbor) => neighbor.id)
    expect(ids).toContain(nid('关系-有效'))
    expect(ids).not.toContain(nid('关系-将来生效'))
    expect(ids).not.toContain(nid('关系-将来记录'))
    expect(ids).not.toContain(nid('关系-已过期'))
  })
})

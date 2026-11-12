/**
 * 写入去重原语（Story 2.4：路径①指纹 / ②语义重复 / ③版本作废）。
 *
 * 真库（LadybugDB + HNSW）验证，向量按 cosine 精确构造：
 * 查询向量恒为 e1 = [1,0,…]，库内向量取 [c, √(1−c²), 0,…] ⇒ cosine = c。
 *   c = 0.99 → 语义重复路径（≥0.97）；c = 0.93 → 版本亲缘窗口 [0.90,0.97)；c = 0.5 → 窗口外。
 *
 * **U4 粗筛上界的钉住用例**在第 3 条：c = 0.93（distance ≈ 0.07）能被 ANN 取回并走进版本链分支。
 * 若有人把粗筛上界退回 0.03，该用例立刻变红（0.07 > 0.03 取不回候选 ⇒ outcome 变成 'created'）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { writeDeduplicatedMemory } from '../src/db/dedup'
import { memoryNodeId } from '../src/db/id'
import { upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const E1 = [1, 0, 0, 0, 0, 0, 0, 0]

/** 与 e1 的 cosine 恰为 c 的向量。 */
function vectorWithCosine(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0, 0, 0, 0, 0]
}

const LAYER = 'L1'

async function openDb(prefix: string): Promise<MemoryDatabase> {
  return openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir(prefix)),
    dim: DIM,
    modelId: 'test-embed',
  })
}

/** 原语不自开事务（与 writeMemoryVersion 同一契约）——测试里补一层。 */
async function writeDedup(store: MemoryDatabase, input: Parameters<typeof writeDeduplicatedMemory>[1]) {
  return runInTransaction(store.connection, () => writeDeduplicatedMemory(store.connection, input))
}

async function nodeCount(store: MemoryDatabase): Promise<number> {
  const rows = await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS total')
  return Number(rows[0]?.total ?? 0)
}

async function readNode(store: MemoryDatabase, id: string): Promise<{
  text: string
  refs: string[]
  recordedAt: string
  invalidAt: string | null
  parentId: string | null
}> {
  const rows = await queryAll(
    store.connection,
    `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.text AS text, m.source_refs AS refs,` +
      ' m.recorded_at AS recorded_at, m.invalid_at AS invalid_at, m.parent_id AS parent_id',
  )
  const row = rows[0]
  if (row === undefined) throw new Error('节点不存在：' + id)
  return {
    text: String(row.text ?? ''),
    refs: Array.isArray(row.refs) ? row.refs.map(String) : [],
    recordedAt: String(row.recorded_at ?? ''),
    invalidAt: row.invalid_at === null || row.invalid_at === undefined ? null : String(row.invalid_at),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
  }
}

async function readAudit(store: MemoryDatabase, action: string): Promise<Array<{ reason: string; outcome: string }>> {
  const rows = await queryAll(
    store.connection,
    `MATCH (g:generation_log) WHERE g.action = '${action}' RETURN g.reason AS reason, g.outcome AS outcome`,
  )
  return rows.map((row) => ({ reason: String(row.reason ?? ''), outcome: String(row.outcome ?? '') }))
}

afterAll(cleanupTempDirs)

describe('writeDeduplicatedMemory（Story 2.4 三路去重）', () => {
  it('路径①：同指纹再写 → 合并 source_refs、保留最早 recorded_at、不新建节点', async () => {
    const store = await openDb('omw-dd-fp-')
    try {
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '同一事实',
        embedding: E1,
        sourceRefs: ['m1'],
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '同一事实',
        embedding: E1,
        sourceRefs: ['m2'],
        recordedAt: '2026-05-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('fingerprint-merge')
      expect(await nodeCount(store)).toBe(1)
      const node = await readNode(store, memoryNodeId(LAYER, '同一事实'))
      expect(node.refs.slice().sort()).toEqual(['m1', 'm2'])
      expect(node.recordedAt).toBe('2026-01-01T00:00:00.000Z')
    } finally {
      await store.close()
    }
  })

  it('路径②：cosine ≈ 0.99 → 向既有节点追加 source_refs、不新建、不改原文与 recorded_at', async () => {
    const store = await openDb('omw-dd-sem-')
    try {
      const targetId = memoryNodeId(LAYER, '原文')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '原文',
        embedding: vectorWithCosine(0.99),
        sourceRefs: ['m1'],
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '另一种表述',
        embedding: E1,
        sourceRefs: ['m2'],
        recordedAt: '2026-05-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('semantic-merge')
      expect(result.id).toBe(targetId)
      expect(await nodeCount(store)).toBe(1)
      const node = await readNode(store, targetId)
      expect(node.text).toBe('原文')
      expect(node.refs.slice().sort()).toEqual(['m1', 'm2'])
      expect(node.recordedAt).toBe('2026-01-01T00:00:00.000Z')
      const audits = await readAudit(store, 'merge_semantic')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('success')
      expect(audits[0]!.reason).toContain('similarity=')
      expect(audits[0]!.reason).toContain('threshold=0.97')
    } finally {
      await store.close()
    }
  })

  it('路径③ + U4 钉住：cosine ≈ 0.93（distance ≈ 0.07）被 ANN 取回 → 作废旧版本、新节点记 parent_id', async () => {
    const store = await openDb('omw-dd-ver-')
    try {
      const oldId = memoryNodeId(LAYER, '旧版本')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '旧版本',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '新版本',
        embedding: E1,
        sourceRefs: ['s1'],
        validAt: '2026-02-01T00:00:00.000Z',
        recordedAt: '2026-02-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('version-invalidated')
      expect(result.parentId).toBe(oldId)
      expect(await nodeCount(store)).toBe(2)
      const old = await readNode(store, oldId)
      // X4：区间重叠 ⇒ invalid_at 对齐触发事实的 valid_at（不是 now）。
      expect(old.invalidAt).toBe('2026-02-01T00:00:00.000Z')
      const fresh = await readNode(store, result.id)
      expect(fresh.parentId).toBe(oldId)
      expect(fresh.invalidAt).toBeNull()
      const audits = await readAudit(store, 'invalidate_version')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('success')
      expect(audits[0]!.reason).toContain('window=[0.9,0.97)')
      expect(audits[0]!.reason).toContain('invalid_at=2026-02-01T00:00:00.000Z')
    } finally {
      await store.close()
    }
  })

  it('路径③模糊：窗口内命中多条 + 亲缘都命中 → 不作废、写新节点、审计 uncertain', async () => {
    const store = await openDb('omw-dd-amb-')
    try {
      const oldA = memoryNodeId(LAYER, '旧版本A')
      const oldB = memoryNodeId(LAYER, '旧版本B')
      for (const text of ['旧版本A', '旧版本B']) {
        await upsertMemory(store.connection, {
          layer: LAYER,
          text,
          embedding: vectorWithCosine(0.93),
          sourceRefs: ['s1'],
          validAt: '2026-01-01T00:00:00.000Z',
          recordedAt: '2026-01-01T00:00:00.000Z',
        })
      }
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '最新表述',
        embedding: E1,
        sourceRefs: ['s1'],
      })
      expect(result.outcome).toBe('created')
      expect(await nodeCount(store)).toBe(3)
      expect((await readNode(store, oldA)).invalidAt).toBeNull()
      expect((await readNode(store, oldB)).invalidAt).toBeNull()
      const audits = await readAudit(store, 'invalidate_version')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('uncertain')
      expect(audits[0]!.reason).toBe('ambiguous-version-candidates')
    } finally {
      await store.close()
    }
  })

  it('路径③安全缺省：窗口内命中但 source_refs 无交集 → 不作废', async () => {
    const store = await openDb('omw-dd-noref-')
    try {
      const oldId = memoryNodeId(LAYER, '无关来源的旧版本')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '无关来源的旧版本',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['other'],
        validAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, { layer: LAYER, text: '新表述', embedding: E1, sourceRefs: ['s1'] })
      expect(result.outcome).toBe('created')
      expect((await readNode(store, oldId)).invalidAt).toBeNull()
      expect(await readAudit(store, 'invalidate_version')).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('U6 跨层不判重：L2 写入不吸收 L1 的近似节点', async () => {
    const store = await openDb('omw-dd-layer-')
    try {
      await upsertMemory(store.connection, {
        layer: 'L1',
        text: 'L1 的原文',
        embedding: vectorWithCosine(0.99),
        sourceRefs: ['m1'],
      })
      const result = await writeDedup(store, { layer: 'L2', text: 'L2 的表述', embedding: E1, sourceRefs: ['m2'] })
      expect(result.outcome).toBe('created')
      expect(await nodeCount(store)).toBe(2)
      expect(await readAudit(store, 'merge_semantic')).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('U8 无向量整段跳过：库里有近似节点也只写新节点（不查 ANN）', async () => {
    const store = await openDb('omw-dd-novec-')
    try {
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '已有向量节点',
        embedding: vectorWithCosine(0.99),
        sourceRefs: ['m1'],
      })
      const result = await writeDedup(store, { layer: LAYER, text: '无向量表述', embedding: null, sourceRefs: ['m2'] })
      expect(result.outcome).toBe('created')
      expect(await nodeCount(store)).toBe(2)
      expect(await readAudit(store, 'merge_semantic')).toHaveLength(0)
    } finally {
      await store.close()
    }
  })
})

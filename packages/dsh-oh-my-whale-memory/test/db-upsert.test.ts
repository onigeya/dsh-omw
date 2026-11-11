/**
 * memory 写入与同指纹合并测试（Story 1.4 / AC6）。
 *
 * 契约：同 (layer, 归一化 text) 重复写入命中同一 id；ON MATCH 合并 source_refs
 * （并集去重）、保留最早 recorded_at、不改 text/layer；跨层同文本产生两个节点。
 * embedding 长度与库 pin 的 dim 不符时抛 MemoryDbError(code='embedding_dim_mismatch')。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 abi-smoke.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let dbPath: string
let store: MemoryDatabase

beforeAll(async () => {
  dir = await makeTempDir('omw-upsert-')
  dbPath = resolveMemoryDbPath(dir)
  store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try {
    await store?.close()
  } catch {
    /* ignore */
  }
  await cleanupTempDirs()
})

describe('记忆写入与 ON CONFLICT 合并（AC6）', () => {
  it('首次写入 + 重复写入：id 稳定、节点数 1、source_refs 并集、recorded_at 保留最早', async () => {
    const first = await store.upsertMemory({
      layer: 'L1_INBOX',
      text: '用户偏好深色主题',
      embedding: [0.1, 0.2, 0.3, 0.4],
      sourceRefs: ['msg-a'],
      recordedAt: '2026-11-09T00:00:00.000Z',
    })
    const second = await store.upsertMemory({
      layer: 'L1_INBOX',
      text: '用户偏好深色主题',
      embedding: [0.1, 0.2, 0.3, 0.4],
      sourceRefs: ['msg-b'],
      recordedAt: '2026-11-10T00:00:00.000Z',
    })

    expect(second.id).toBe(first.id)
    expect(second.recordedAt).toBe('2026-11-09T00:00:00.000Z') // 保留更早

    // 节点数仍为 1，且 ON MATCH 真正合并了 source_refs（并集去重）。
    const matched = await queryAll(
      store.connection,
      `MATCH (m:memory {id: '${first.id}'}) RETURN m.source_refs AS refs, m.text AS text, m.layer AS layer`,
    )
    expect(matched).toHaveLength(1)
    expect(matched[0]['refs']).toEqual(['msg-a', 'msg-b'])
    expect(matched[0]['text']).toBe('用户偏好深色主题')
    expect(matched[0]['layer']).toBe('L1_INBOX')
  })

  it('同 id 重复写入的 source_refs 并集去重（重叠引用不重复）', async () => {
    const base = { layer: 'L2_WIKI' as const, text: 'dedupe-refs', embedding: [1, 0, 0, 0] }
    await store.upsertMemory({ ...base, sourceRefs: ['a', 'b'], recordedAt: '2026-11-09T00:00:00.000Z' })
    await store.upsertMemory({ ...base, sourceRefs: ['b', 'c'], recordedAt: '2026-11-08T00:00:00.000Z' })

    const rows = await queryAll(
      store.connection,
      "MATCH (m:memory) WHERE m.text = 'dedupe-refs' RETURN m.source_refs AS refs, m.recorded_at AS recorded_at",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]['refs']).toEqual(['a', 'b', 'c'])
    expect(rows[0]['recorded_at']).toBe('2026-11-08T00:00:00.000Z')
  })

  it('跨层同文本产生两个节点（AC3 + AC6 不冲突）', async () => {
    const a = await store.upsertMemory({ layer: 'L1_INBOX', text: 'fact-x', embedding: [1, 0, 0, 0] })
    const b = await store.upsertMemory({ layer: 'L2_WIKI', text: 'fact-x', embedding: [1, 0, 0, 0] })
    expect(a.id).not.toBe(b.id)

    const rows = await queryAll(store.connection, "MATCH (m:memory) WHERE m.text = 'fact-x' RETURN m.id AS id")
    expect(rows).toHaveLength(2)
  })

  it('embedding 长度与 dim 不符 → 抛 embedding_dim_mismatch', async () => {
    await expect(store.upsertMemory({ layer: 'L1_INBOX', text: 'bad-vec', embedding: [1, 2] }))
      .rejects.toMatchObject({ code: 'embedding_dim_mismatch' })
    await expect(store.upsertMemory({ layer: 'L1_INBOX', text: 'bad-vec', embedding: [1, 2] }))
      .rejects.toThrow(/向量长度/)
  })

  it('缺省 embedding（Story 1.6）：三列向量写 NULL，id 幂等、source_refs 仍并集、recorded_at 保留最早', async () => {
    const first = await store.upsertMemory({
      layer: 'L1',
      text: 'no vec fact',
      sourceRefs: ['msg-1'],
      recordedAt: '2026-11-09T00:00:00.000Z',
    })
    // 同指纹变体：大小写不同 + 多余标点/空白——归一化后命中同一 id。
    const second = await store.upsertMemory({
      layer: 'L1',
      text: '  No Vec Fact!!! ',
      sourceRefs: ['msg-2'],
      recordedAt: '2026-11-10T00:00:00.000Z',
    })

    expect(second.id).toBe(first.id)
    expect(second.recordedAt).toBe('2026-11-09T00:00:00.000Z') // 保留最早

    const rows = await queryAll(
      store.connection,
      `MATCH (m:memory {id: '${first.id}'}) RETURN m.layer AS layer, m.text AS text, m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim, m.source_refs AS refs, m.recorded_at AS recorded_at`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]['layer']).toBe('L1')
    // text 不被 ON MATCH 改写：保留首次写入的原文。
    expect(rows[0]['text']).toBe('no vec fact')
    // 三列向量全 NULL（绝不写零向量），embedding 由 Epic 2 补齐。
    expect(rows[0]['embedding']).toBeNull()
    expect(rows[0]['model_id']).toBeNull()
    expect(rows[0]['dim']).toBeNull()
    expect(rows[0]['refs']).toEqual(['msg-1', 'msg-2'])
    expect(rows[0]['recorded_at']).toBe('2026-11-09T00:00:00.000Z')
  })

  it('带 embedding 与缺省 embedding 可交替命中同一节点（ON MATCH 不重写向量列）', async () => {
    const a = await store.upsertMemory({
      layer: 'L1',
      text: 'mixed-vec-fact',
      embedding: [0.5, 0.5, 0.5, 0.5],
      sourceRefs: ['msg-a'],
    })
    const b = await store.upsertMemory({
      layer: 'L1',
      text: 'mixed-vec-fact',
      sourceRefs: ['msg-b'],
    })

    expect(b.id).toBe(a.id)
    const rows = await queryAll(
      store.connection,
      `MATCH (m:memory {id: '${a.id}'}) RETURN m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim, m.source_refs AS refs`,
    )
    expect(rows).toHaveLength(1)
    // 首次写入带 embedding：列保持首次值，缺省重写不清空、不补零。
    expect(rows[0]['embedding']).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(rows[0]['model_id']).toBe('test-embed-model')
    expect(rows[0]['dim']).toBe(4)
    expect(rows[0]['refs']).toEqual(['msg-a', 'msg-b'])
  })
})

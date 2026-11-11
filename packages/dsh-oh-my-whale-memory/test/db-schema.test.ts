/**
 * 建库与 schema 测试（Story 1.4 / AC1、AC2、AC4）。
 *
 * 契约：openMemoryDatabase 幂等——缺目录建目录、缺表建表、缺索引建索引、
 * 首建写入库级元数据 omw_meta{schema_version, embedding_dim, embedding_model_id, created_at}。
 * AC6（同指纹重复写入的合并语义）在 db-upsert.test.ts。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 abi-smoke.test.ts。
 */
import { access } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let dbPath: string
let store: MemoryDatabase

beforeAll(async () => {
  dir = await makeTempDir('omw-schema-')
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

describe('记忆库建库（AC1/AC2/AC4）', () => {
  it('库文件建于 <profile>/memory/lbug.db', async () => {
    await expect(access(dbPath)).resolves.toBeUndefined()
  })

  it('memory 节点表含 AC2 列出的全部列', async () => {
    const rows = await queryAll(store.connection, `CALL table_info('memory') RETURN name, type`)
    const columns = new Map(rows.map((r) => [String(r.name), String(r.type)]))
    expect([...columns.keys()]).toEqual(expect.arrayContaining([
      'id', 'layer', 'kind', 'priority', 'text', 'embedding', 'valid_at', 'recorded_at',
      'invalid_at', 'expired_at', 'source_refs', 'embedding_model_id', 'embedding_dim',
    ]))
    expect(columns.get('embedding')).toBe('FLOAT[4]')
    expect(columns.get('source_refs')).toBe('STRING[]')
  })

  it('l0_raw 表含 AC2 列出的四列', async () => {
    const rows = await queryAll(store.connection, `CALL table_info('l0_raw') RETURN name, type`)
    const columns = rows.map((r) => String(r.name))
    expect(columns).toEqual(expect.arrayContaining(['id', 'raw_text', 'recorded_at', 'actor']))
  })

  it('omw_meta 写入了库级元数据（AC2）', async () => {
    const rows = await queryAll(store.connection, 'MATCH (m:omw_meta) RETURN m.key AS key, m.value AS value')
    const meta = new Map(rows.map((r) => [String(r.key), String(r.value)]))
    expect(meta.get('schema_version')).toBe('1')
    expect(meta.get('embedding_dim')).toBe('4')
    expect(meta.get('embedding_model_id')).toBe('test-embed-model')
    expect(meta.get('created_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('HNSW 与 FTS 索引在首次建库时创建，且参数与锁定值一致（AC4）', async () => {
    const rows = await queryAll(
      store.connection,
      'CALL show_indexes() RETURN table_name, index_name, index_type, index_definition',
    )
    const memoryIndexes = rows.filter((r) => String(r.table_name) === 'memory')
    const types = memoryIndexes.map((r) => String(r.index_type))
    expect(types).toContain('HNSW')
    expect(types).toContain('FTS')

    const hnsw = memoryIndexes.find((r) => String(r.index_type) === 'HNSW')
    expect(hnsw).toBeDefined()
    const definition = String(hnsw?.index_definition)
    // 只断言锁定参数片段，不断言整串（扩展可能追加默认参数，如 alpha）。
    for (const token of ['mu := 30', 'ml := 60', 'pu := 0.05', 'efc := 200', "metric := 'cosine'"]) {
      expect(definition).toContain(token)
    }
  })

  it('二次打开同一库幂等：dim 对齐 + 索引不重复创建 + modelId 同步', async () => {
    const reopened = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model-v2' })
    expect(reopened).toBe(store) // registry 复用同一句柄
    expect(reopened.modelId).toBe('test-embed-model-v2')
    const rows = await queryAll(store.connection, 'MATCH (m:omw_meta) RETURN m.key AS key, m.value AS value')
    const meta = new Map(rows.map((r) => [String(r.key), String(r.value)]))
    expect(meta.get('embedding_model_id')).toBe('test-embed-model-v2')
  })

  it('同进程同路径不同 dim → 抛 embedding_dim_mismatch（registry 快路径）', async () => {
    await expect(openMemoryDatabase({ dbPath, dim: 768, modelId: 'x' }))
      .rejects.toThrow(/维度不符/)
  })

  it('close() 后同路径重开成功并复用同一 connection（registry 存在的理由）', async () => {
    const connectionBefore = store.connection
    await store.close()
    // dispose→re-apply 的真实路径：facade 已删，底层句柄仍在 registry 里。
    const reopened = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'test-embed-model-v2' })
    expect(reopened.connection).toBe(connectionBefore)
    const rows = await queryAll(reopened.connection, 'CALL show_indexes() RETURN index_name AS name')
    expect(rows.map((r) => String(r.name))).toContain('memory_embedding_hnsw')
  })
})

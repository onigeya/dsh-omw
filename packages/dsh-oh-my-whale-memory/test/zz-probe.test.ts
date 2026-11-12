import { afterAll, it } from 'vitest'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)

it('probe：CREATE 字面量向量 + UNWIND 参数批量', async () => {
  const store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(await makeTempDir('omw-probe-')), dim: 4, modelId: 'x' })
  await store.connection.query("CREATE (m:memory {id: 'p1', layer: 'L1', kind: '', priority: 0, text: 't', valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-01T00:00:00.000Z', embedding: [1.0, 0.0, 0.0, 0.0], embedding_model_id: 'x', embedding_dim: 4, source_refs: []})")
  const rows = await queryAll(store.connection, 'MATCH (m:memory) RETURN m.id AS id, m.embedding AS e')
  console.log('LITERAL_OK', JSON.stringify(rows))
  try {
    await store.connection.query('UNWIND $items AS it CREATE (m:memory {id: it.id, layer: \'L1\', kind: \'\', priority: 0, text: it.text, valid_at: it.valid_at, recorded_at: it.recorded_at, source_refs: []})')
    console.log('UNWIND_NO_PARAMS_MISSING')
  } catch (e) { console.log('UNWIND_ERR', String(e).slice(0, 200)) }
  const prepared = await store.connection.prepare('UNWIND $items AS it CREATE (m:memory {id: it.id, layer: \'L1\', kind: \'\', priority: 0, text: it.text, valid_at: it.valid_at, recorded_at: it.recorded_at, source_refs: []})')
  const items = Array.from({ length: 3 }, (_, i) => ({ id: 'u' + i, text: 't' + i, valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-01T00:00:00.000Z' }))
  try { await store.connection.execute(prepared, { items }); console.log('UNWIND_OK', (await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS c'))[0]?.c) } catch (e) { console.log('UNWIND_EXEC_ERR', String(e).slice(0, 200)) }
  await store.close()
})
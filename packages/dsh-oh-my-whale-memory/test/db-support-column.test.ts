/**
 * memory.support 加列与旧库迁移（Story 2.5 / U16）。
 *
 * AD-4 Rule（ARCHITECTURE-SPINE.md:90）与 epics.md:328 都把 support 列在 memory 列清单里，
 * 但 Epic 1 的 createMemoryTableStatement 漏落；Story 2.5 的质量门判据③ 要写入它
 * （support := 候选 source_refs 中命中存活 L0 的条数，≥1）。照 Story 2.4 / U1 的 parent_id
 * 同一模式补：新库直接带列、旧库由唯一迁移点幂等 ALTER、只读实例绝不 ALTER。
 *
 * 旧库/新库都在**子进程**里建（Windows 上 close() 后同进程重开同一库文件报 Error: 33，
 * 与 test/db-parent-id.test.ts 同一手法）。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { getMemoryById, writeMemoryVersion } from '../src/db/memory'
import { queryAll } from '../src/db/rows'
import { runInTransaction } from '../src/db/transaction'
import {
  META_KEYS,
  SUPPORT_COLUMN,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const LEGACY_ID = 'legacy-support-1'

/** 冻结的旧库 DDL（Story 1.4 形态：13 列，既无 parent_id 也无 support）。 */
const LEGACY_MEMORY_TABLE = [
  'CREATE NODE TABLE IF NOT EXISTS memory(',
  '  id STRING,',
  '  layer STRING,',
  '  kind STRING,',
  '  priority INT64,',
  '  text STRING,',
  `  embedding FLOAT[${DIM}],`,
  '  valid_at STRING,',
  '  recorded_at STRING,',
  '  invalid_at STRING,',
  '  expired_at STRING,',
  '  source_refs STRING[],',
  '  embedding_model_id STRING,',
  '  embedding_dim INT64,',
  '  PRIMARY KEY(id)',
  ')',
].join('')

function legacyStatements(dbPath: string): string[] {
  return [
    dbPath,
    LEGACY_MEMORY_TABLE,
    createL0RawTableStatement(),
    createMetaTableStatement(),
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = 'test-embed' ON MATCH SET m.value = 'test-embed'`,
    `MERGE (m:memory {id: '${LEGACY_ID}'}) ON CREATE SET m.layer = 'L1', m.kind = '', m.priority = 0, m.text = '旧数据', m.valid_at = '2026-01-01T00:00:00.000Z', m.recorded_at = '2026-01-01T00:00:00.000Z', m.source_refs = []`,
  ]
}

function createDbInChild(statements: string[]): void {
  const script = [
    "import { Database, Connection } from '@ladybugdb/core'",
    'const [path, ...stmts] = JSON.parse(process.env.OMW_TEST_STMTS)',
    "const { mkdirSync } = await import('node:fs')",
    "const { dirname } = await import('node:path')",
    'mkdirSync(dirname(path), { recursive: true })',
    'const db = new Database(path)',
    'const conn = new Connection(db)',
    "await conn.query('INSTALL vector; LOAD vector; INSTALL fts; LOAD fts;')",
    'for (const s of stmts) await conn.query(s)',
    'await conn.close()',
    'await db.close()',
    'process.stdout.write(String(stmts.length))',
  ].join(';\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, OMW_TEST_STMTS: JSON.stringify(statements) },
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`子进程建库失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
}

async function readColumnNames(connection: lbug.Connection): Promise<string[]> {
  const rows = await queryAll(connection, "CALL table_info('memory') RETURN name")
  return rows.map((row) => String(row.name))
}

/** getMemoryById 的投影不含 support（show 格式钉死），故直读该列。 */
async function readSupport(connection: lbug.Connection, id: string): Promise<number | null> {
  const rows = await queryAll(connection, `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.support AS support`)
  const value = rows[0]?.support
  return value === null || value === undefined ? null : Number(value)
}

afterAll(cleanupTempDirs)

describe('memory.support 加列与旧库迁移（U16）', () => {
  it('新库直接带 support 列（createMemoryTableStatement）', async () => {
    const store = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-sup-new-')),
      dim: DIM,
      modelId: 'test-embed',
    })
    expect(await readColumnNames(store.connection)).toContain(SUPPORT_COLUMN)
    await store.close()
  })

  it('旧库（无该列）用写者打开：幂等 ALTER 补列，且写入的 support 真的落库', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-sup-old-'))
    createDbInChild(legacyStatements(dbPath))

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'test-embed' })
    expect(await readColumnNames(store.connection)).toContain(SUPPORT_COLUMN)
    // 旧行仍可读，且 support 为 NULL（旧数据无该列时的缺省）。
    const legacy = await getMemoryById(store.connection, LEGACY_ID)
    expect(legacy?.text).toBe('旧数据')
    expect(await readSupport(store.connection, LEGACY_ID)).toBeNull()

    // 补列之后写入的节点必须能真的存下 support（否则「只补了列、写不进去」也会绿）。
    const written = await runInTransaction(store.connection, () =>
      writeMemoryVersion(store.connection, { layer: 'L2', text: '综合陈述', support: 3 }),
    )
    expect(await readSupport(store.connection, written.id)).toBe(3)
    await store.close()
  })

  it('旧库用只读打开：绝不执行 ALTER，列仍缺席（AC2）', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-sup-ro-'))
    createDbInChild(legacyStatements(dbPath))

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'test-embed', readOnly: true })
    expect(store.readonly).toBe(true)
    expect(await readColumnNames(store.connection)).not.toContain(SUPPORT_COLUMN)
    await store.close()
  })
})

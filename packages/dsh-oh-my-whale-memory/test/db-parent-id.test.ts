/**
 * memory.parent_id 加列与旧库迁移（Story 2.4 / U1、X2、X3）。
 *
 * 三条验收：
 *   A. 旧库（无 parent_id）用写者打开 → 幂等 ALTER 补列、旧数据仍可读；
 *   B. 旧库用只读打开 → **不执行 ALTER**，列仍缺席（AC2：只读不写库）；
 *   C. 已带 parent_id 的库再次打开 → verifyExistingSchema 容忍多出来的列，不重复 ALTER（X3）。
 *
 * 旧库/新库都在**子进程**里建：LadybugDB 0.22.3 在 Windows 上 close() 后同进程立刻重开
 * 同一库文件会拿到 "IO exception: Could not set lock on file ... (Error: 33)"；
 * 子进程退出后父进程打开则正常（与 test/db-dim-mismatch.test.ts 同一手法）。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { getMemoryById } from '../src/db/memory'
import { queryAll } from '../src/db/rows'
import {
  META_KEYS,
  PARENT_ID_COLUMN,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const LEGACY_ID = 'legacy-1'

/**
 * 冻结的旧库 DDL（Story 1.4 的 memory 表形态：13 列，**无 parent_id**）。
 * 故意不复用 src 的 createMemoryTableStatement——它已经带上新列，写进测试就等于
 * 拿新 schema 冒充旧库，"旧库能补列"这条断言会变成永真式。
 */
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

function modernStatements(dbPath: string): string[] {
  return [
    dbPath,
    createMemoryTableStatement(DIM),
    createL0RawTableStatement(),
    createMetaTableStatement(),
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = 'test-embed' ON MATCH SET m.value = 'test-embed'`,
  ]
}

/** 在子进程里建库（DDL 由父进程传入，保持单一事实来源）。 */
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

/** 直接读 parent_id：getMemoryById 的投影不含该列（show 格式钉死，未扩列）。 */
async function readParentId(connection: lbug.Connection, id: string): Promise<string | null> {
  const rows = await queryAll(connection, `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.parent_id AS parent_id`)
  const value = rows[0]?.parent_id
  return value === null || value === undefined ? null : String(value)
}

afterAll(cleanupTempDirs)

describe('memory.parent_id 加列与旧库迁移（U1/X2/X3）', () => {
  it('新库直接带 parent_id 列（createMemoryTableStatement）', async () => {
    const store = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-pid-new-')),
      dim: DIM,
      modelId: 'test-embed',
    })
    expect(await readColumnNames(store.connection)).toContain(PARENT_ID_COLUMN)
    await store.close()
  })

  it('旧库（无该列）用写者打开：幂等 ALTER 补列且旧数据可读', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-pid-old-'))
    createDbInChild(legacyStatements(dbPath))

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'test-embed' })
    expect(await readColumnNames(store.connection)).toContain(PARENT_ID_COLUMN)
    const legacy = await getMemoryById(store.connection, LEGACY_ID)
    expect(legacy?.text).toBe('旧数据')
    expect(await readParentId(store.connection, LEGACY_ID)).toBeNull()
    await store.close()
  })

  it('旧库用只读打开：绝不执行 ALTER，列仍缺席（AC2）', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-pid-ro-'))
    createDbInChild(legacyStatements(dbPath))

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'test-embed', readOnly: true })
    expect(store.readonly).toBe(true)
    expect(await readColumnNames(store.connection)).not.toContain(PARENT_ID_COLUMN)
    await store.close()
  })

  it('已带 parent_id 的库再次打开：verifyExistingSchema 容忍多列、不重复 ALTER（X3）', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-pid-modern-'))
    createDbInChild(modernStatements(dbPath))

    // 重复 ALTER 会抛 "Property parent_id already exists"，本用例能返回即证明没重复执行。
    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'test-embed' })
    const columns = await readColumnNames(store.connection)
    expect(columns).toContain(PARENT_ID_COLUMN)
    expect(columns.filter((name) => name === PARENT_ID_COLUMN)).toHaveLength(1)
    await store.close()
  })
})

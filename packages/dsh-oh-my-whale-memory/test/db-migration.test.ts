/**
 * 首个迁移 0002（Story 4.2 / AD-34）：备份、版本比较、单事务、bootstrap、fail-loud。
 *
 * 覆盖 I/O & Edge-Case 矩阵行 1–6。旧库一律在**子进程**里建（Windows 上同进程 close()
 * 后重开同一库文件报 Error: 33，手法同 `test/db-support-column.test.ts`），并断言备份文件
 * 真的产生且能独立打开（唯一回滚点不是日志里的说法，而是文件系统里的事实）。
 *
 * 本文件 6 次开库（4 次经 openMemoryDatabase + 2 个迁移注入用例的裸句柄），≤14。
 */
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { loadStorageBackend } from '../src/db/backend'
import { openMemoryDatabase, closeMemoryDatabase } from '../src/db/database'
import { migrateDatabase } from '../src/db/migrate'
import { queryRows } from '../src/db/rows'
import { resolveMemoryDbPath } from '../src/db/paths'
import {
  EVIDENCE_DEGRADED_COLUMN,
  META_KEYS,
  REDACTED_BY_COLUMN,
  SCHEMA_MIGRATION_TABLE,
  SCHEMA_VERSION,
  createGenerationLogTableStatement,
  createKeyedDecisionTableStatement,
  createL0RawTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import type { Migration } from '../src/db/migrations'
import { buildJudgeKey, buildLegacyJudgeKey } from '../src/db/audit'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
const T0 = '2026-01-01T00:00:00.000Z'

/** 冻结的 v1 memory DDL（15 列：有 parent_id/support，无 evidence_degraded）。 */
const V1_MEMORY_TABLE = [
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
  '  parent_id STRING,',
  '  support INT64,',
  '  PRIMARY KEY(id)',
  ')',
].join('')

/** 冻结的 v1 l0_raw DDL（4 列，无墓碑两列）。 */
const V1_L0_TABLE =
  'CREATE NODE TABLE IF NOT EXISTS l0_raw(id STRING, raw_text STRING, recorded_at STRING, actor STRING, PRIMARY KEY(id))'

/** 冻结的 v1 generation_log DDL（15 列，无 detail）。 */
const V1_GENERATION_LOG = [
  'CREATE NODE TABLE IF NOT EXISTS generation_log(',
  '  id STRING, recorded_at STRING, actor STRING, kind STRING, action STRING, policy STRING,',
  '  l0_refs STRING[], outcome STRING, reason STRING, question_key STRING, probability DOUBLE,',
  '  threshold DOUBLE, passed BOOL, cascade_depth INT64, trigger_id STRING, PRIMARY KEY(id)',
  ')',
].join('')

function metaStatements(version: string | null): string[] {
  const rows = [
    createMetaTableStatement(),
  ]
  if (version !== null) {
    rows.push(`MERGE (m:omw_meta {key: '${META_KEYS.schemaVersion}'}) ON CREATE SET m.value = '${version}' ON MATCH SET m.value = '${version}'`)
  }
  rows.push(
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = '${MODEL}' ON MATCH SET m.value = '${MODEL}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.createdAt}'}) ON CREATE SET m.value = '${T0}' ON MATCH SET m.value = '${T0}'`,
  )
  return rows
}

/** v1 旧库：三张表都是旧列形态，并写入一行数据（迁移必须保住它）。 */
function v1Statements(version: string | null = '1'): string[] {
  return [
    V1_MEMORY_TABLE,
    V1_L0_TABLE,
    V1_GENERATION_LOG,
    ...metaStatements(version),
    "CREATE (:memory {id: 'legacy-m1', layer: 'L1', kind: '', priority: 0, text: '旧数据', valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-01T00:00:00.000Z', source_refs: []})",
    "CREATE (:l0_raw {id: 'legacy-l0', raw_text: '旧原文', recorded_at: '2026-01-01T00:00:00.000Z', actor: 'test'})",
  ]
}

/** 当前形态（v2）的库，只把版本号写成 3：模拟「新插件写的库被旧插件打开」。 */
function v3Statements(): string[] {
  return [
    'CREATE NODE TABLE IF NOT EXISTS memory(id STRING, layer STRING, kind STRING, priority INT64, text STRING, embedding FLOAT[4], valid_at STRING, recorded_at STRING, invalid_at STRING, expired_at STRING, source_refs STRING[], embedding_model_id STRING, embedding_dim INT64, parent_id STRING, support INT64, evidence_degraded BOOL, PRIMARY KEY(id))',
    createL0RawTableStatement(),
    createGenerationLogTableStatement(),
    ...metaStatements('4'),
  ]
}

/** 子进程动作：建库（`create`）或只读转储（`dump`），统一走原生 lbug。 */
function runChild(action: 'create' | 'dump', dbPath: string, statements: string[] = []): Record<string, unknown> {
  const script = [
    "import { Database, Connection } from '@ladybugdb/core'",
    "const { mkdirSync } = await import('node:fs')",
    "const { dirname } = await import('node:path')",
    'const [action, path, payload] = JSON.parse(process.env.OMW_TEST_JOB)',
    'mkdirSync(dirname(path), { recursive: true })',
    'const db = new Database(path)',
    'const conn = new Connection(db)',
    "await conn.query('INSTALL vector')",
    "await conn.query('LOAD vector')",
    "await conn.query('INSTALL fts')",
    "await conn.query('LOAD fts')",
    'const statements = action === "create" ? payload : []',
    'for (const s of statements) await conn.query(s)',
    "let out = 'null'",
    'if (action === "dump") {',
    "  const read = async (sql) => { const r = await conn.query(sql); const rows = await r.getAll(); await r.close(); return rows }",
    "  const columns = await read(\"CALL table_info('memory') RETURN name\")",
    '  const l0 = await read("CALL table_info(\'l0_raw\') RETURN name")',
    "  const meta = await read(\"MATCH (m:omw_meta) RETURN m.key AS key, m.value AS value\")",
    '  let hasMigrationTable = true',
    "  try { await read(\"CALL table_info('schema_migration') RETURN name\") } catch { hasMigrationTable = false }",
    '  out = JSON.stringify({',
    '    memoryColumns: columns.map((r) => String(r.name)),',
    '    l0Columns: l0.map((r) => String(r.name)),',
    '    meta: Object.fromEntries(meta.map((r) => [String(r.key), String(r.value)])),',
    '    hasMigrationTable,',
    '  })',
    '}',
    'process.stdout.write(out)',
    'await conn.close()',
    'await db.close()',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, OMW_TEST_JOB: JSON.stringify([action, dbPath, statements]) },
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`子进程 ${action} 失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
  return action === 'dump' ? JSON.parse(child.stdout) as Record<string, unknown> : {}
}

async function backupFiles(dbPath: string): Promise<string[]> {
  const entries = await readdir(dirname(dbPath))
  // 只数主备份文件：`<db>.bak-<from>-<pid>-<ns>` 旁边可能还有同名 `-wal` 副本（一并复制）。
  return entries.filter((entry) => /^lbug\.db\.bak-\d+-\d+-\d+$/.test(entry))
}

async function columnsOf(connection: lbug.Connection, table: string): Promise<Map<string, string>> {
  const rows = await queryRows(connection, `CALL table_info('${table}') RETURN name, type`)
  return new Map(rows.map((row) => [String(row.name), String(row.type)]))
}

async function readMeta(connection: lbug.Connection): Promise<Map<string, string>> {
  const rows = await queryRows(connection, 'MATCH (m:omw_meta) RETURN m.key AS key, m.value AS value')
  return new Map(rows.map((row) => [String(row.key), String(row.value)]))
}

/** 新列的 BOOL 缺省：AC:1053 逐字要求 `DEFAULT false`（不是 NULL）。 */
async function degradedFlag(connection: lbug.Connection, id: string): Promise<unknown> {
  const rows = await queryRows(
    connection,
    'MATCH (m:memory {id: $id}) RETURN m.evidence_degraded AS flag',
    { id },
  )
  return rows[0]?.flag
}

afterAll(cleanupTempDirs)

describe('矩阵行 1：全新空库 bootstrap', () => {
  it('SCHEMA_VERSION=3；schema_migration 含 0002+0003 两行；三表新列齐；无备份文件', async () => {
    const dir = await makeTempDir('omw-migr-fresh-')
    const dbPath = resolveMemoryDbPath(dir)
    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })

    expect(SCHEMA_VERSION).toBe('3')
    expect((await readMeta(store.connection)).get(META_KEYS.schemaVersion)).toBe('3')
    const applied = await queryRows(
      store.connection,
      `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN s.version AS version, s.checksum AS checksum`,
    )
    expect(applied.map((row) => Number(row.version))).toEqual([2, 3])
    expect(String(applied[0]?.checksum)).toMatch(/^[0-9a-f]{64}$/)

    expect((await columnsOf(store.connection, 'memory')).get(EVIDENCE_DEGRADED_COLUMN)).toBe('BOOL')
    expect((await columnsOf(store.connection, 'l0_raw')).get(REDACTED_BY_COLUMN)).toBe('STRING')
    expect((await columnsOf(store.connection, 'l0_raw')).get('redacted_at')).toBe('STRING')
    expect((await columnsOf(store.connection, 'generation_log')).get('detail')).toBe('STRING')

    // bootstrap 不备份：备份只在「旧库升级」这条有回滚需求的路径上产生。
    expect(await backupFiles(dbPath)).toEqual([])

    // AC:1053 逐字要求 DEFAULT false：新建节点不写该列时读到 false，不是 NULL。
    const created = await store.upsertMemory({ layer: 'L1', text: '默认值验证' })
    expect(await degradedFlag(store.connection, created.id)).toBe(false)
    await store.close()
  }, 30_000)
})

describe('矩阵行 2：v1 旧库自动升级', () => {
  it('三表新列出现、版本 3、schema_migration 两行、lbug.db.bak-1-* 产生且内容可独立打开', async () => {
    const dir = await makeTempDir('omw-migr-v1-')
    const dbPath = resolveMemoryDbPath(dir)
    runChild('create', dbPath, v1Statements())

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })
    const meta = await readMeta(store.connection)
    expect(meta.get(META_KEYS.schemaVersion)).toBe('3')
    expect((await columnsOf(store.connection, 'memory')).get(EVIDENCE_DEGRADED_COLUMN)).toBe('BOOL')
    const l0Columns = await columnsOf(store.connection, 'l0_raw')
    expect(l0Columns.get(REDACTED_BY_COLUMN)).toBe('STRING')
    expect(l0Columns.get('redacted_at')).toBe('STRING')
    expect((await columnsOf(store.connection, 'generation_log')).get('detail')).toBe('STRING')
    const applied = await queryRows(store.connection, `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN s.version AS v`)
    expect(applied.map((row) => Number(row.v))).toEqual([2, 3])
    // 旧数据必须还在（迁移只加列）。
    const legacy = await queryRows(store.connection, "MATCH (m:memory {id: 'legacy-m1'}) RETURN m.text AS text")
    expect(legacy[0]?.text).toBe('旧数据')

    // 备份：同目录、命名含 fromVersion=1，且是迁移**之前**的快照（memory 仍是 15 列）。
    const backups = await backupFiles(dbPath)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^lbug\.db\.bak-1-\d+-\d+$/)
    // 在**新进程**里打开备份：同进程换路径打开同一份库会撞 LadybugDB 的进程级句柄状态
    // （实测会报 catalog 不存在），所以「内容可打开」这条必须由子进程证明。
    const backupDump = runChild('dump', join(dirname(dbPath), backups[0]!))
    expect(backupDump.memoryColumns as string[]).not.toContain(EVIDENCE_DEGRADED_COLUMN)
    expect((backupDump.memoryColumns as string[]).length).toBe(15)
    expect((backupDump.meta as Record<string, string>)[META_KEYS.schemaVersion]).toBe('1')
    expect(backupDump.hasMigrationTable).toBe(false)

    // ALTER 也要带 DEFAULT false（AC:1053 的两处之一）：迁移后新写入的节点读回 false。
    const created = await store.upsertMemory({ layer: 'L1', text: '迁移后默认值验证' })
    expect(await degradedFlag(store.connection, created.id)).toBe(false)

    await store.close()
  }, 60_000)
})

describe('矩阵行 3：重复启动', () => {
  it('已迁移库再开：不重复 ALTER、不新增 schema_migration 行、不产生新备份', async () => {
    const dir = await makeTempDir('omw-migr-reopen-')
    const dbPath = resolveMemoryDbPath(dir)
    const first = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })
    const appliedBefore = await queryRows(first.connection, `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN count(s) AS c`)
    const backupsBefore = await backupFiles(dbPath)
    await first.close()

    // 同进程重开：facade 已回收，底层句柄复用 ⇒ 真正再跑一遍 initializeDatabase 的迁移入口。
    const second = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })
    const appliedAfter = await queryRows(second.connection, `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN count(s) AS c`)
    expect(Number(appliedAfter[0]?.c)).toBe(Number(appliedBefore[0]?.c))
    expect(await backupFiles(dbPath)).toEqual(backupsBefore)
    expect((await readMeta(second.connection)).get(META_KEYS.schemaVersion)).toBe('3')
    await second.close()
  }, 60_000)
})

describe('矩阵行 4：版本高于插件', () => {
  it('version=4 ⇒ fail-loud schema_mismatch，且库内列与版本都不变（无 schema_migration 表）', async () => {
    const dir = await makeTempDir('omw-migr-v3-')
    const dbPath = resolveMemoryDbPath(dir)
    runChild('create', dbPath, v3Statements())

    await expect(openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL }))
      .rejects.toMatchObject({ code: 'schema_mismatch' })
    await expect(openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL }))
      .rejects.toThrow(/高于本插件支持/)

    // 用子进程独立核对：版本仍是 3，且本插件没有偷偷建出 schema_migration。
    // 先释放父进程持有的句柄（被拒绝的打开同样会缓存 Database，跨进程会挡住建库文件的锁）。
    await closeMemoryDatabase(dbPath)
    const dump = runChild('dump', dbPath)
    expect((dump.meta as Record<string, string>)[META_KEYS.schemaVersion]).toBe('4')
    expect(dump.hasMigrationTable).toBe(false)
  }, 60_000)
})

describe('矩阵行 5：迁移中途失败', () => {
  it('注入一条非法 DDL ⇒ 整条迁移回滚：列与版本都不变、schema_migration 无新行、备份仍在', async () => {
    const dir = await makeTempDir('omw-migr-fail-')
    const dbPath = resolveMemoryDbPath(dir)
    runChild('create', dbPath, v1Statements())

    const backend = loadStorageBackend()
    const database = backend.createDatabase(dbPath, false)
    const connection = await backend.createConnection(database)
    await backend.loadExtensions(connection)

    const broken: Migration = {
      version: 2,
      name: 'broken-injection',
      statements: [
        // 第一条合法：若事务语义失效，它就会留下来（断言点）。
        {
          table: 'memory',
          column: EVIDENCE_DEGRADED_COLUMN,
          ddl: `ALTER TABLE memory ADD ${EVIDENCE_DEGRADED_COLUMN} BOOL`,
        },
        { table: 'no_such_table', column: 'x', ddl: 'ALTER TABLE no_such_table ADD x STRING' },
      ],
    }

    await expect(migrateDatabase(connection, { dbPath, migrations: [broken] }))
      .rejects.toMatchObject({ code: 'schema_migration_failed' })

    expect((await columnsOf(connection, 'memory')).has(EVIDENCE_DEGRADED_COLUMN)).toBe(false)
    expect((await readMeta(connection)).get(META_KEYS.schemaVersion)).toBe('1')
    // 连表本身都被回滚掉：事务内的 CREATE 同样不是「已提交事实」。
    await expect(queryRows(connection, `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN count(s) AS c`))
      .rejects.toThrow(/does not exist/i)
    // 备份是唯一回滚点：失败后必须仍在。
    expect(await backupFiles(dbPath)).toHaveLength(1)
    await backend.close(database, connection)
  }, 60_000)
})

describe('矩阵行 6：备份创建失败', () => {
  it('预置同名备份文件 ⇒ 拒绝迁移、不执行任何 DDL', async () => {
    const dir = await makeTempDir('omw-migr-nobak-')
    const dbPath = resolveMemoryDbPath(dir)
    runChild('create', dbPath, v1Statements())

    const backend = loadStorageBackend()
    const database = backend.createDatabase(dbPath, false)
    const connection = await backend.createConnection(database)
    await backend.loadExtensions(connection)

    const occupied = join(dirname(dbPath), 'lbug.db.bak-1-occupied')
    // 先占位：O_EXCL 创建必须失败（不覆盖上一份备份）。
    const { open } = await import('node:fs/promises')
    const handle = await open(occupied, 'wx')
    await handle.close()

    await expect(migrateDatabase(connection, {
      dbPath,
      backupPath: () => occupied,
    })).rejects.toMatchObject({ code: 'schema_migration_failed' })

    expect((await columnsOf(connection, 'memory')).has(EVIDENCE_DEGRADED_COLUMN)).toBe(false)
    expect((await readMeta(connection)).get(META_KEYS.schemaVersion)).toBe('1')
    await backend.close(database, connection)
  }, 60_000)
})

describe('FIX-3：bootstrap 判据（版本键缺失 ≠ 新库）', () => {
  it('版本键缺失但 memory 表已存在 ⇒ 不是 bootstrap：先备份、再迁移到 3', async () => {
    const dir = await makeTempDir('omw-migr-noversion-')
    const dbPath = resolveMemoryDbPath(dir)
    // 冻结的 v1 表形态，但**不写** schema_version（旧库的极端形态）。
    runChild('create', dbPath, v1Statements(null))

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })
    expect((await readMeta(store.connection)).get(META_KEYS.schemaVersion)).toBe('3')
    expect((await columnsOf(store.connection, 'memory')).get(EVIDENCE_DEGRADED_COLUMN)).toBe('BOOL')
    const applied = await queryRows(store.connection, `MATCH (s:${SCHEMA_MIGRATION_TABLE}) RETURN s.version AS v`)
    expect(applied.map((row) => Number(row.v))).toEqual([2, 3])
    // 关键差异：走的是升级路径 ⇒ 备份文件名里的 fromVersion 是 0，而不是「不备份」。
    const backups = await backupFiles(dbPath)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^lbug\.db\.bak-0-\d+-\d+$/)
    await store.close()
  }, 60_000)

  it('版本记录=2 但 memory 表缺失 ⇒ schema_mismatch（不隐式重建）', async () => {
    const dir = await makeTempDir('omw-migr-corrupt-')
    const dbPath = resolveMemoryDbPath(dir)
    runChild('create', dbPath, [
      createMetaTableStatement(),
      `MERGE (m:omw_meta {key: '${META_KEYS.schemaVersion}'}) ON CREATE SET m.value = '2' ON MATCH SET m.value = '2'`,
      `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    ])

    const backend = loadStorageBackend()
    const database = backend.createDatabase(dbPath, false)
    const connection = await backend.createConnection(database)
    await backend.loadExtensions(connection)

    // 直接调迁移运行器：openMemoryDatabase 会在更早的 verifyExistingSchema 就拒绝，测不到这条。
    await expect(migrateDatabase(connection, { dbPath }))
      .rejects.toMatchObject({ code: 'schema_mismatch' })
    await expect(migrateDatabase(connection, { dbPath }))
      .rejects.toThrow(/表不存在.*损坏|损坏.*表不存在/s)
    // 没有新建任何表：拒绝发生在 DDL 之前。
    await expect(queryRows(connection, `CALL table_info('${SCHEMA_MIGRATION_TABLE}') RETURN name`))
      .rejects.toThrow(/does not exist/i)
    await backend.close(database, connection)
  }, 60_000)
})




describe('迁移 0003：judge_key 加 action（Story 5.4 / AC:1299-1301）', () => {
  it('旧键行被就地重算：只剩新键、字段保留、版本到 3', async () => {
    const dir = await makeTempDir('omw-migr-judgekey-')
    const dbPath = resolveMemoryDbPath(dir)
    const policy = 'last-writer-wins'
    const oldId = 'old-judge-1'
    const newId = 'new-judge-1'
    const legacyKey = buildLegacyJudgeKey(policy, oldId, newId)
    const expectedKey = buildJudgeKey(policy, 'supersede', oldId, newId)
    expect(legacyKey).not.toBe(expectedKey)

    // v2 库：v1 三张表 + keyed_decision（10 列，0003 不改它的 DDL）+ 一行**旧键**裁决。
    runChild('create', dbPath, [
      V1_MEMORY_TABLE,
      V1_L0_TABLE,
      V1_GENERATION_LOG,
      createKeyedDecisionTableStatement(),
      ...metaStatements('2'),
      `CREATE (:keyed_decision {judge_key: '${legacyKey}', new_id: '${newId}', old_id: '${oldId}', ` +
      `action: 'supersede', policy: '${policy}', l0_refs: [], resolution_source: 'auto', ` +
      `write_pending: false, ts: '2026-01-01T00:00:00.000Z'})`,
    ])

    // 写者打开 ⇒ 迁移 0002 + 0003 依次执行。
    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL })
    const rows = await queryRows(
      store.connection,
      'MATCH (k:keyed_decision) RETURN k.judge_key AS key, k.old_id AS old_id, k.new_id AS new_id, k.action AS action, k.policy AS policy, k.ts AS ts',
    )
    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.key)).toBe(expectedKey)
    expect(String(rows[0]?.old_id)).toBe(oldId)
    expect(String(rows[0]?.new_id)).toBe(newId)
    expect(String(rows[0]?.action)).toBe('supersede')
    expect(String(rows[0]?.policy)).toBe(policy)
    expect(String(rows[0]?.ts)).toBe('2026-01-01T00:00:00.000Z')
    const meta = await queryRows(store.connection, "MATCH (m:omw_meta {key: 'schema_version'}) RETURN m.value AS v")
    expect(String(meta[0]?.v)).toBe('3')
    await store.close()
  }, 60_000)
})

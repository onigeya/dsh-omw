/**
 * Story 11.4 / T5、矩阵行 3：只读实例打开**未迁移旧 schema**（version 9，四列仍含 `persona`）。
 *
 * 验证四件事：
 * 1. 只读实例不迁移、不写：库内 `persona` 原值仍在、`schema_version` 仍是 9；
 * 2. 读路径把持久化 `persona` 当只读别名：recall / 详情 / 待裁决清单都读成 `user_portrait`；
 * 3. `schema_version_mismatch` 在 `/memory status` 可见（AD-34 的可见状态不被静默吞掉）；
 * 4. 旧库无审计/边表时 status 仍能渲染（只读实例的真实形态，AD-12）。
 *
 * 旧库在子进程里建（Windows 上同进程 close() 后重开同一文件报 Error: 33，手法同
 * db-migration.test.ts / db-readonly.test.ts）。本文件 2 次连库（子进程 1、父进程只读 1）。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveRuntimeConfig } from '../src/config'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { getMemoryById, queryAll } from '../src/db/memory'
import { readDeclaredSchemaVersion } from '../src/db/migrate'
import { createFtsIndexStatement, createL0RawTableStatement, createVectorIndexStatement } from '../src/db/schema'
import { runRecallCore } from '../src/recall/core'
import { createInjectionStore } from '../src/injection/state'
import { createMemoryAccess } from '../src/wire/access'
import { renderMemoryStatus } from '../src/command'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createGenerationLogTableStatement,
  createKeyedDecisionTableStatement,
  createL1InboxTableStatement,
  createL2InboxTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
  createPendingDecisionTableStatement,
} from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
const T0 = '2026-01-01T00:00:00.000Z'

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/**
 * 冻结的 v9 旧库：当前表形态 + version 9 + 四列各一条 `persona` 行。
 *
 * 刻意**不建** EVIDENCE / RELATED 边表（旧库常见形态）：status 必须能在缺表时降级渲染。
 */
function v9Statements(): string[] {
  return [
    createMetaTableStatement(),
    createMemoryTableStatement(DIM),
    createL0RawTableStatement(),
    createGenerationLogTableStatement(),
    createKeyedDecisionTableStatement(),
    createL1InboxTableStatement(),
    createL2InboxTableStatement(),
    createPendingDecisionTableStatement(),
    mergeMeta(META_KEYS.schemaVersion, '9'),
    mergeMeta(META_KEYS.embeddingDim, String(DIM)),
    mergeMeta(META_KEYS.embeddingModelId, MODEL),
    mergeMeta(META_KEYS.createdAt, T0),
    // 索引先建、行后插：与生产建库顺序一致（FTS/向量索引都支持增量写入）。
    createVectorIndexStatement(),
    createFtsIndexStatement(),
    `CREATE (:memory {id: 'portrait-legacy', layer: 'L1', kind: 'persona', priority: -1, ` +
      `text: 'user prefers dark theme', embedding: [1.0, 0.0, 0.0, 0.0], ` +
      `valid_at: '${T0}', recorded_at: '${T0}', source_refs: []})`,
    `CREATE (:memory {id: 'fact-legacy', layer: 'L1', kind: 'work_fact', priority: 0, ` +
      `text: 'project uses pnpm', embedding: [0.0, 1.0, 0.0, 0.0], ` +
      `valid_at: '${T0}', recorded_at: '${T0}', source_refs: []})`,
    `CREATE (:l1_inbox {id: 'inbox-legacy', session_id: 's-1', kind: 'persona', payload: '旧队列条目', ` +
      `status: 'pending', attempts: 0, enqueued_at: '${T0}', updated_at: '${T0}'})`,
    `CREATE (:l2_inbox {id: 'l2-legacy', session_id: 's-1', kind: 'persona', payload: '旧 L2 条目', ` +
      `status: 'pending', attempts: 0, enqueued_at: '${T0}', updated_at: '${T0}'})`,
    `CREATE (:pending_decision {id: 'pending-legacy', old_id: 'portrait-old', new_id: 'portrait-new', ` +
      `payload: '我更喜欢浅色主题', kind: 'persona', priority: -1, actor: 'agent', created_at: '${T0}'})`,
  ]
}

/** 子进程建库（父进程不持有句柄，随后可只读打开）。 */
function createOldDatabase(dbPath: string, statements: readonly string[]): void {
  const script = [
    "import { Database, Connection } from '@ladybugdb/core'",
    "const { mkdirSync } = await import('node:fs')",
    "const { dirname } = await import('node:path')",
    'const [path, payload] = JSON.parse(process.env.OMW_TEST_JOB)',
    'mkdirSync(dirname(path), { recursive: true })',
    'const db = new Database(path)',
    'const conn = new Connection(db)',
    "await conn.query('INSTALL vector')",
    "await conn.query('LOAD vector')",
    "await conn.query('INSTALL fts')",
    "await conn.query('LOAD fts')",
    'for (const s of payload) await conn.query(s)',
    'await conn.close()',
    'await db.close()',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, OMW_TEST_JOB: JSON.stringify([dbPath, statements]) },
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`子进程建旧库失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
}

afterAll(cleanupTempDirs)

describe('Story 11.4 / 矩阵行 3：只读实例打开未迁移旧 schema', () => {
  it('不迁移、不写；recall/详情/待裁决读成 user_portrait；schema_version_mismatch 可见', async () => {
    const dir = await makeTempDir('omw-portrait-ro-')
    const dbPath = resolveMemoryDbPath(dir)
    createOldDatabase(dbPath, v9Statements())

    const store = await openMemoryDatabase({
      dbPath,
      dim: DIM,
      modelId: MODEL,
      readOnly: true,
    })
    try {
      // ① 不迁移、不写：版本仍是 9，四列原值仍是 persona。
      expect(await readDeclaredSchemaVersion(store.connection, dbPath)).toBe(9)
      const rawKinds = await queryAll(
        store.connection,
        'MATCH (m:memory) RETURN m.id AS id, m.kind AS kind ORDER BY id',
      )
      expect(rawKinds.map((row) => [String(row.id), String(row.kind)])).toEqual([
        ['fact-legacy', 'work_fact'],
        ['portrait-legacy', 'persona'],
      ])
      const inboxKinds = await queryAll(
        store.connection,
        'MATCH (q:l1_inbox) RETURN q.kind AS kind LIMIT 1',
      )
      expect(String(inboxKinds[0]?.kind)).toBe('persona')

      // ② 读路径别名：详情与待裁决清单把 persona 读成 user_portrait（行为与迁移后一致）。
      expect((await getMemoryById(store.connection, 'portrait-legacy'))?.kind).toBe('user_portrait')
      const access = createMemoryAccess({
        getDb: () => store,
        resolved: resolveRuntimeConfig({
          embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL, dim: DIM },
        }),
        readonlyState: () => ({ readonly: true, reason: 'another instance owns the writer lock' }),
        getSystemOneClient: () => null,
        injectionStore: createInjectionStore(),
      })
      const status = await access.getStatus()
      expect(status.pendingConflicts).toBe(1)
      expect(status.pendingConflictEntries?.[0]?.kind).toBe('user_portrait')
      // ③ schema_version_mismatch 可见（旧库 9 / 插件 10），且 readonly 行为不变。
      expect(SCHEMA_VERSION).toBe('10')
      expect(status.schemaVersionMismatch).toEqual({ actual: '9', expected: '10' })
      const text = renderMemoryStatus(status)
      expect(text).toContain('schema_version_mismatch: 库=9 插件=10')
      expect(text).toContain("readonly: true, reason: 'another instance owns the writer lock'")

      // ④ recall 的 kind 同样是规范值（旧库只读，行为不因迁移缺失而改变）。
      const recalled = await runRecallCore({
        connection: store.connection,
        query: 'dark',
        queryVector: null,
        embeddingModelId: MODEL,
        rrfK: 60,
        retrievalTopK: 50,
        layerWeights: { l1: 1, l2: 1.2 },
        priorityWeight: 0.5,
        limit: 5,
        now: '2026-06-01T00:00:00.000Z',
      })
      const portraitHit = recalled.results.find((item) => item.id === 'portrait-legacy')
      expect(portraitHit?.kind).toBe('user_portrait')
    } finally {
      await store.close()
    }
  }, 60_000)
})

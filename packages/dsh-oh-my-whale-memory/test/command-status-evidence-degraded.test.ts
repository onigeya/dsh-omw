/**
 * `/memory status` 的 `evidence_degraded` 行（Story 4.2 / D-5；矩阵行 16）。
 *
 * 三态：
 * - 0 ⇒ 不出现该行（既有逐行输出逐字不变，这是本 story 最容易回归的一条）；
 * - 3 ⇒ `evidence_degraded: 3`；
 * - 列缺失（旧库未迁移且只读）⇒ `evidence_degraded: 未知（库缺少该列）`。
 *
 * 本文件 2 次开库（空库写者 1 次 + v1 只读 1 次），≤14。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveRuntimeConfig } from '../src/config'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { countEvidenceDegraded } from '../src/db/redact'
import { queryRows } from '../src/db/rows'
import {
  META_KEYS,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { createInjectionStore } from '../src/injection/state'
import { createMemoryAccess } from '../src/wire/access'
import { renderMemoryStatus, type MemoryStatusSnapshot } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
/** 过去时刻：有效集谓词含 `valid_at/recorded_at <= now`，用未来时刻会让种子节点被排除。 */
const NOW = '2026-01-01T00:00:00.000Z'

const RESOLVED = resolveRuntimeConfig({
  embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL, dim: DIM },
})

/** 快照基线：只有本 story 之前的行，没有任何 evidence_degraded。 */
function baselineSnapshot(): MemoryStatusSnapshot {
  return {
    layers: { L1: 0, L2: 0 },
    inboxes: { L1: 0, L2: 0 },
    failed: 0,
    embeddingMode: 'enabled',
    systemOne: 'enabled',
    unembedded: 0,
    readonly: false,
    auditGap: 0,
    evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
    relatedSkipped: 0,
    injection: null,
  }
}

afterAll(cleanupTempDirs)

describe('矩阵行 16：renderMemoryStatus 的三态', () => {
  const BASELINE = [
    '记忆状态',
    'L1: 0',
    'L2: 0',
    'L1_INBOX: 0',
    'L2_INBOX: 0',
    'failed: 0',
    'audit_gap: 0',
    'embedding: enabled',
    'systemOne: enabled',
    'readonly: false',
    'injection: 未知（本实例尚未触发开局注入）',
  ].join('\n')

  it('evidenceDegraded = 0 / undefined ⇒ 不追加任何行（既有逐行输出逐字不变）', () => {
    expect(renderMemoryStatus(baselineSnapshot())).toBe(BASELINE)
    expect(renderMemoryStatus({ ...baselineSnapshot(), evidenceDegraded: 0 })).toBe(BASELINE)
    expect(renderMemoryStatus({ ...baselineSnapshot(), evidenceDegraded: 3 })).toContain('evidence_degraded: 3')
  })

  it('evidenceDegraded = 3 ⇒ 恰好一行 `evidence_degraded: 3`', () => {
    const text = renderMemoryStatus({ ...baselineSnapshot(), evidenceDegraded: 3 })
    expect(text.split('\n').filter((line) => line.startsWith('evidence_degraded'))).toEqual(['evidence_degraded: 3'])
  })

  it('evidenceDegraded = null ⇒ `evidence_degraded: 未知（库缺少该列）`（不静默报 0）', () => {
    const text = renderMemoryStatus({ ...baselineSnapshot(), evidenceDegraded: null })
    expect(text).toContain('evidence_degraded: 未知（库缺少该列）')
    expect(text).not.toContain('evidence_degraded: 0')
  })
})

describe('矩阵行 16：status 装配读的是有效且降级的真实计数', () => {
  it('空库 ⇒ 0 且不出现该行；标 3 条后 ⇒ evidence_degraded: 3', async () => {
    const store = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-status-degraded-')),
      dim: DIM,
      modelId: MODEL,
    })
    const access = createMemoryAccess({
      getDb: () => store,
      resolved: RESOLVED,
      readonlyState: () => ({ readonly: false }),
      getSystemOneClient: () => null,
      injectionStore: createInjectionStore(),
    })

    const empty = await access.getStatus()
    expect(empty.evidenceDegraded).toBe(0)
    expect(renderMemoryStatus(empty)).not.toContain('evidence_degraded')

    for (const text of ['降级一', '降级二', '降级三']) {
      await store.upsertMemory({ layer: 'L1', text, validAt: NOW, recordedAt: NOW })
    }
    await queryRows(store.connection, 'MATCH (m:memory) SET m.evidence_degraded = true')
    const withThree = await access.getStatus()
    expect(withThree.evidenceDegraded).toBe(3)
    expect(renderMemoryStatus(withThree)).toContain('evidence_degraded: 3')
    await store.close()
  }, 60_000)
})

describe('矩阵行 16：列缺失（v1 只读库）⇒ null = 未知', () => {
  it('countEvidenceDegraded 在缺列的库上返回 null（调用方渲染成「未知」）', async () => {
    const dir = await makeTempDir('omw-status-degraded-v1-')
    const dbPath = resolveMemoryDbPath(dir)
    createLegacyDb(dbPath)

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL, readOnly: true })
    expect(store.readonly).toBe(true)
    expect(await countEvidenceDegraded(store.connection, NOW)).toBeNull()
    await store.close()
  }, 60_000)
})

/** v1 形态（无 evidence_degraded）的库：只读实例不做迁移，正好用来验「未知」分支。 */
function createLegacyDb(dbPath: string): void {
  const statements = [
    createMetaTableStatement(),
    // 冻结的 v1 memory DDL：与当前 createMemoryTableStatement 的差别只有 evidence_degraded，
    // 这里显式手写，避免未来加列时本夹具跟着漂移（它要的就是「缺列」形态）。
    'CREATE NODE TABLE IF NOT EXISTS memory(id STRING, layer STRING, kind STRING, priority INT64, text STRING, ' +
    `embedding FLOAT[${DIM}], valid_at STRING, recorded_at STRING, invalid_at STRING, expired_at STRING, ` +
    'source_refs STRING[], embedding_model_id STRING, embedding_dim INT64, parent_id STRING, support INT64, PRIMARY KEY(id))',
    createL0RawTableStatement(),
    `MERGE (m:omw_meta {key: '${META_KEYS.schemaVersion}'}) ON CREATE SET m.value = '1' ON MATCH SET m.value = '1'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = '${MODEL}' ON MATCH SET m.value = '${MODEL}'`,
    "CREATE (:memory {id: 'v1-m1', layer: 'L1', kind: '', priority: 0, text: '旧库记忆', " +
    "valid_at: '2026-01-01T00:00:00.000Z', recorded_at: '2026-01-01T00:00:00.000Z', source_refs: []})",
  ]
  const script = [
    "import { Database, Connection } from '@ladybugdb/core'",
    "const { mkdirSync } = await import('node:fs')",
    "const { dirname } = await import('node:path')",
    'const [path, ...stmts] = JSON.parse(process.env.OMW_TEST_STMTS)',
    'mkdirSync(dirname(path), { recursive: true })',
    'const db = new Database(path)',
    'const conn = new Connection(db)',
    "await conn.query('INSTALL vector')",
    "await conn.query('LOAD vector')",
    "await conn.query('INSTALL fts')",
    "await conn.query('LOAD fts')",
    'for (const s of stmts) await conn.query(s)',
    'process.stdout.write(String(stmts.length))',
    'await conn.close()',
    'await db.close()',
  ].join('\n')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, OMW_TEST_STMTS: JSON.stringify([dbPath, ...statements]) },
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`子进程建旧库失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
}

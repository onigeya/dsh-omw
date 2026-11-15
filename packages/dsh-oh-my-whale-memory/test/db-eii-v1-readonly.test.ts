/**
 * v1 旧库（缺 Story 4.2 两列）的**只读**实例必须仍能跑读路径（Story 4.2 评审 FIX-1）。
 *
 * 0.22.3 的事实：对未定义属性，binder 直接抛错，不会读成 NULL。v1 库被只读实例打开时
 * 不做迁移，因此任何引用 `memory.evidence_degraded` / `l0_raw.redacted_at` 的谓词都会
 * 把整条读路径打崩——`/memory status` 在 `computeEvidenceGap` 就抛，D-5 的「未知」分支
 * 永远到不了。本文件用**冻结的 v1 DDL**（无两列）且**建 EVIDENCE 表**的库证明：
 * EII / 漂移 / edge gap 都能出数，`countEvidenceDegraded` 返回 null。
 *
 * 本文件 1 次开库（只读），≤14。
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { openMemoryDatabase } from '../src/db/database'
import { computeEiiViolations, computeEvidenceDrift, computeEvidenceGap } from '../src/db/eii'
import { resolveMemoryDbPath } from '../src/db/paths'
import { countEvidenceDegraded } from '../src/db/redact'
import { queryRows } from '../src/db/rows'
import { META_KEYS, createMetaTableStatement } from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
const NOW = '2026-11-16T00:00:00.000Z'
const T0 = '2026-01-01T00:00:00.000Z'

/** 冻结的 v1 memory DDL：15 列，没有 evidence_degraded。 */
const V1_MEMORY =
  'CREATE NODE TABLE IF NOT EXISTS memory(id STRING, layer STRING, kind STRING, priority INT64, text STRING, ' +
  `embedding FLOAT[${DIM}], valid_at STRING, recorded_at STRING, invalid_at STRING, expired_at STRING, ` +
  'source_refs STRING[], embedding_model_id STRING, embedding_dim INT64, parent_id STRING, support INT64, PRIMARY KEY(id))'

/** 冻结的 v1 l0_raw DDL：4 列，没有 redacted_by / redacted_at。 */
const V1_L0 =
  'CREATE NODE TABLE IF NOT EXISTS l0_raw(id STRING, raw_text STRING, recorded_at STRING, actor STRING, PRIMARY KEY(id))'

const EVIDENCE =
  'CREATE REL TABLE GROUP IF NOT EXISTS EVIDENCE(FROM l0_raw TO memory, FROM memory TO memory, reason STRING)'

function createV1Db(dbPath: string): void {
  const statements = [
    createMetaTableStatement(),
    V1_MEMORY,
    V1_L0,
    // 关键：v1 库也可能已经有 EVIDENCE 表（任何被 Epic 2 之后写者打开过的库都有），
    // 于是 `hasEdgeTables` 为真、computeEvidenceGap 会真的去算 EII —— 这正是被打崩的路径。
    EVIDENCE,
    `MERGE (m:omw_meta {key: '${META_KEYS.schemaVersion}'}) ON CREATE SET m.value = '1' ON MATCH SET m.value = '1'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${DIM}' ON MATCH SET m.value = '${DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = '${MODEL}' ON MATCH SET m.value = '${MODEL}'`,
    `CREATE (:l0_raw {id: 'v1-l0', raw_text: '旧库原始观测', recorded_at: '${T0}', actor: 'test'})`,
    `CREATE (:memory {id: 'v1-m1', layer: 'L1', kind: '', priority: 0, text: '旧库记忆', ` +
      `valid_at: '${T0}', recorded_at: '${T0}', source_refs: ['v1-l0']})`,
    `MATCH (l:l0_raw {id: 'v1-l0'}), (m:memory {id: 'v1-m1'}) MERGE (l)-[:EVIDENCE]->(m)`,
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
    throw new Error(`子进程建 v1 库失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
}

async function columnNames(connection: lbug.Connection, table: string): Promise<string[]> {
  const rows = await queryRows(connection, `CALL table_info('${table}') RETURN name`)
  return rows.map((row) => String(row.name))
}

afterAll(cleanupTempDirs)

describe('FIX-1：v1 只读库（缺两列 + 有 EVIDENCE 表）读路径不崩', () => {
  it('EII / 漂移 / edge gap / countEvidenceDegraded 全部可用（不抛）', async () => {
    const dbPath = resolveMemoryDbPath(await makeTempDir('omw-eii-v1-ro-'))
    createV1Db(dbPath)

    const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL, readOnly: true })
    expect(store.readonly).toBe(true)

    // 前置：夹具确实是 v1 形态（缺两列），且边表在——否则这条回归测的是别的东西。
    expect(await columnNames(store.connection, 'memory')).not.toContain('evidence_degraded')
    expect(await columnNames(store.connection, 'l0_raw')).not.toContain('redacted_at')
    expect(await columnNames(store.connection, 'EVIDENCE')).toContain('reason')

    // 被打崩的三处：computeEvidenceGap 先跑 EII、再跑漂移；旧实现三条谓词都引用新列。
    await expect(computeEiiViolations(store.connection, NOW)).resolves.toEqual([])
    await expect(computeEvidenceDrift(store.connection, NOW)).resolves.toEqual({
      refsWithoutEdges: [],
      edgesWithoutRefs: [],
    })
    await expect(computeEvidenceGap(store.connection, NOW)).resolves.toEqual({
      eiiViolations: 0,
      drift: 0,
      total: 0,
    })

    // D-5：列缺失必须是 null（渲染成「未知」），不能退化成 0。
    await expect(countEvidenceDegraded(store.connection, NOW)).resolves.toBeNull()

    await store.close()
  }, 60_000)
})

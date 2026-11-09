/**
 * 维度不符 fail-loud 测试（Story 1.4 / AC5 / AD-14）。
 *
 * 场景：库已按 1024 维建好，用户把 embedding 模型换成 768 维后启动 →
 * 必须拒绝启动并提示"全量重嵌入 / 迁移新库"，绝不静默降级、绝不自动重建。
 *
 * 建库放在**子进程**里：LadybugDB 0.22.3 在 Windows 上 close() 后同进程立刻重开
 * 同一库文件会拿到 "IO exception: Could not set lock on file ... (Error: 33)"
 * （句柄要等 GC 才释放）。子进程退出后父进程打开则正常。
 *
 * DDL 不在子进程里重写一份：父进程从 src/schema.ts 取真实 DDL（CREATE TABLE
 * IF NOT EXISTS 不含 INSTALL/LOAD，且子进程只建表、不建索引，避免把 HNSW
 * 维度锁到 1024 让 AC5 的"仍以 1024 打开成功"断言失去意义），通过环境变量传给
 * 子进程逐条执行。这样 DDL 始终只有一份事实来源。
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import {
  createMemoryTableStatement,
  createL0RawTableStatement,
  createMetaTableStatement,
  META_KEYS,
} from '../src/db/schema'
import { injectOpenSslPath } from './openssl'

const BUILT_DIM = 1024
const CONFIGURED_DIM = 768

let dir: string
let dbPath: string

beforeAll(async () => {
  injectOpenSslPath()
  dir = await mkdtemp(join(tmpdir(), 'omw-dim-'))
  dbPath = resolveMemoryDbPath(dir)

  const statements = JSON.stringify([
    dbPath,
    createMemoryTableStatement(BUILT_DIM),
    createL0RawTableStatement(),
    createMetaTableStatement(),
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${BUILT_DIM}' ON MATCH SET m.value = '${BUILT_DIM}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = 'BAAI/bge-m3' ON MATCH SET m.value = 'BAAI/bge-m3'`,
  ])

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
    // 子进程必须显式 close：Windows 上不关就退出会让父进程拿到 "Could not set lock"。
    'await conn.close()',
    'await db.close()',
    'process.stdout.write(String(stmts.length))',
  ].join(';\n')

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, OMW_TEST_STMTS: statements },
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(`子进程建库失败（exit ${child.status}）：${child.stderr || child.stdout}`)
  }
}, 120_000)

afterAll(async () => {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('embedding 维度不符 fail-loud（AC5）', () => {
  it('库 pin 为 1024 而以 768 打开 → 抛 embedding_dim_mismatch 且提示迁移路径', async () => {
    await expect(openMemoryDatabase({ dbPath, dim: CONFIGURED_DIM, modelId: 'other-model' }))
      .rejects.toMatchObject({ code: 'embedding_dim_mismatch' })

    await expect(openMemoryDatabase({ dbPath, dim: CONFIGURED_DIM, modelId: 'other-model' }))
      .rejects.toThrow(/全量重嵌入/)
  })

  it('拒绝后库不被改写：仍以 1024 打开成功且元数据未变', async () => {
    const store = await openMemoryDatabase({ dbPath, dim: BUILT_DIM, modelId: 'BAAI/bge-m3' })
    expect(store.dim).toBe(BUILT_DIM)
    await store.close()
  })
})
describe('omw_meta 与表列维度不一致（schema_mismatch 分支）', () => {
  it('meta 改写成 8 而列仍为 FLOAT[4] → 重开抛 schema_mismatch 且指向维度不一致', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'omw-meta-dim-'))
    try {
      const dbPath2 = resolveMemoryDbPath(dir2)
      const store = await openMemoryDatabase({ dbPath: dbPath2, dim: 4, modelId: 'test-embed' })
      // close 只回收 facade，底层 connection 仍在 registry（Windows 上不可同进程重开，
      // 所以借同一条 connection 篡改元数据来模拟外部版本冲突）。
      const connection = store.connection
      await store.close()
      await connection.query(
        `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'})`
        + ` ON CREATE SET m.value = '8' ON MATCH SET m.value = '8'`,
      )
      // 表列仍是 FLOAT[4]，与 meta 的 8 冲突 → 抛 schema_mismatch 而非 dim_mismatch
      await expect(openMemoryDatabase({ dbPath: dbPath2, dim: 4, modelId: 'test-embed' }))
        .rejects.toMatchObject({ code: 'schema_mismatch' })
      await expect(openMemoryDatabase({ dbPath: dbPath2, dim: 4, modelId: 'test-embed' }))
        .rejects.toThrow(/omw_meta\.embedding_dim/)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })
})

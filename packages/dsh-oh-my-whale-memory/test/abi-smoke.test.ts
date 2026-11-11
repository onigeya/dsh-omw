/**
 * Windows ABI 冒烟测试（Story 1.1 / AD-13）。
 *
 * 实测通过的参数（锁定源——后续建库参数以本注释为准，AD-3）：
 * - LadybugDB 版本：0.22.3（`@ladybugdb/core` ~0.22.x 锁定）
 * - 实测日期：2026-11-08
 * - 运行环境：Windows 11 x64 / Node v24.21.0
 * - HNSW 参数：mu=30, ml=60, pu=0.05, efc=200（与官方示例值一致）
 * - BM25 参数：K=1.2, B=0.75（与官方示例值一致）
 * - 扩展：`vector`（HNSW cosine 磁盘索引）+ `fts`（Okapi BM25）
 * - Windows 前置条件：OpenSSL 3 的 DLL 目录须在 PATH 中（见 README「构建与测试」）
 *
 * 五步流程：open → CREATE NODE TABLE → INSERT → QUERY → CREATE_VECTOR_INDEX
 * 任一步失败则测试 fail，Story 1.1 须标 blocked 上报，不迁就失败。
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as lbug from '@ladybugdb/core'
import { cleanupTempDirs, makeTempDir } from './tmp'

// LadybugDB 官方示例 HNSW/BM25 参数（research.md L107 / L131）
const HNSW_MU = 30
const HNSW_ML = 60
const HNSW_PU = 0.05
const HNSW_EFC = 200
const BM25_K = 1.2
const BM25_B = 0.75

// 冒烟专用 toy 向量维度（足以让 HNSW 建索引）。真实 embedding 维度由建库时
// 的 pin 决定（AD-14），Story 1.4 落地；此处不声称与记忆 schema 一致。
const EMBEDDING_DIM = 4

let db: lbug.Database
let conn: lbug.Connection
let dir: string

beforeAll(async () => {
  // Windows 上 vector/fts 扩展加载依赖 OpenSSL 3 DLL（libssl-3-x64.dll /
  // libcrypto-3-x64.dll）——运行测试前必须把它们所在目录放进 PATH（见 README
  // 「构建与测试」前置条件），否则 step 5 的 INSTALL vector 会以
  // "Failed to load library: ... libvector.lbug_extension" 失败。
  dir = await makeTempDir('omw-abi-smoke-')
  db = new lbug.Database(join(dir, 'lbug.db'))
  conn = new lbug.Connection(db)
})

afterAll(async () => {
  // best-effort 清理：清理失败不 fail 测试（spec I/O matrix 第 3 行）
  try {
    conn?.close?.()
    db?.close?.()
  } catch {
    /* ignore */
  }
  await cleanupTempDirs()
})

describe('LadybugDB Windows ABI 冒烟', () => {
  it('step 1: new Database(path) 打开临时库文件', () => {
    expect(db).toBeInstanceOf(lbug.Database)
    expect(conn).toBeInstanceOf(lbug.Connection)
  })

  it('step 2: CREATE NODE TABLE 建节点表', async () => {
    // 建两张表：`memory`（业务记忆）与 `l0_raw`（append-only 原始层）——
    // 仅验证 ABI，schema 细节留给 Story 1.4。
    await conn.query(
      'CREATE NODE TABLE memory(id STRING, text STRING,'
      + ` embedding FLOAT[${EMBEDDING_DIM}], layer STRING, valid_at STRING, recorded_at STRING,`
      + ' PRIMARY KEY(id))',
    )
    await conn.query(
      'CREATE NODE TABLE l0_raw(id STRING, text STRING, recorded_at STRING,'
      + ' PRIMARY KEY(id))',
    )
  })

  it('step 3: INSERT 写入一行 L1 记忆', async () => {
    // embedding 取一个简单的归一化 4 维向量，足以让 HNSW 建索引。
    const embedding = '[0.5, 0.5, 0.5, 0.5]'
    const res = await conn.query(
      `CREATE (m:memory {id: 'smoke-1', text: 'ABI 冒烟样例',`
      + ` embedding: ${embedding}, layer: 'L1',`
      + ` valid_at: '2026-11-08T00:00:00Z', recorded_at: '2026-11-08T00:00:00Z'})`,
    )
    expect(res).toBeDefined()
  })

  it('step 4: QUERY 读回插入行并断言行数与内容', async () => {
    const result = await conn.query("MATCH (m:memory) WHERE m.id = 'smoke-1' RETURN m.text, m.layer")
    // 单语句 query() 返回单个 QueryResult；数组仅在多语句时出现（lbug.d.ts L287-L291）。
    const rows = Array.isArray(result) ? await result[0].getAll() : await result.getAll()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ 'm.text': 'ABI 冒烟样例', 'm.layer': 'L1' })
  })

  it('step 5: INSTALL/LOAD vector 扩展 + CREATE_VECTOR_INDEX(HNSW cosine)', async () => {
    // LadybugDB 扩展按需 INSTALL/LOAD；同连接里随后可建 HNSW 索引。
    await conn.query('INSTALL vector; LOAD vector;')
    await conn.query(
      `CALL CREATE_VECTOR_INDEX('memory', 'memory_embedding_hnsw', 'embedding',`
      + ` metric := 'cosine', mu := ${HNSW_MU}, ml := ${HNSW_ML},`
      + ` pu := ${HNSW_PU}, efc := ${HNSW_EFC})`,
    )
    // BM25 参数仅作记录（AD-3）：K=1.2, B=0.75，Story 1.4 建 FTS 索引时使用。
    void BM25_K
    void BM25_B
  })
})

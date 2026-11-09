/**
 * 记忆图 schema DDL（Story 1.4 / AD-4）。
 *
 * 列契约（AC2，与 ARCHITECTURE-SPINE ER 图一致）：
 * - memory：id/layer/kind/priority/text/embedding FLOAT[DIM]/
 *   valid_at/recorded_at/invalid_at/expired_at/source_refs[]/embedding_model_id/embedding_dim
 * - l0_raw：id/raw_text/recorded_at/actor（append-only，永不改写，AD-4）
 * - omw_meta：库级元数据（embedding_dim、embedding_model_id、schema_version、created_at）
 *
 * 时间列一律 UTC ISO-8601 字符串（ARCHITECTURE-SPINE 一致性约定）。
 * 建索引参数（AD-3）：HNSW mu=30 ml=60 pu=0.05 efc=200 metric=cosine；
 * BM25 K=1.2 B=0.75 是查询期参数（QUERY_FTS_INDEX），建库时使用官方默认。
 * 锁定来源：test/abi-smoke.test.ts 头注释（实测 2026-11-08）与 2026-11-09 建库探针。
 */
import { MemoryDbError } from './errors.js'

export const MEMORY_TABLE = 'memory'
export const L0_RAW_TABLE = 'l0_raw'
export const META_TABLE = 'omw_meta'

export const VECTOR_INDEX_NAME = 'memory_embedding_hnsw'
export const FTS_INDEX_NAME = 'memory_text_fts'

export const SCHEMA_VERSION = '1'

/** omw_meta 的 key 常量（避免散落的魔法字符串）。 */
export const META_KEYS = {
  schemaVersion: 'schema_version',
  embeddingDim: 'embedding_dim',
  embeddingModelId: 'embedding_model_id',
  createdAt: 'created_at',
} as const

/** 维度必须是 ≥1 的整数——直接拼进 DDL，越界即拒绝（不信任外部配置）。 */
export function assertEmbeddingDim(dim: number): number {
  if (!Number.isInteger(dim) || dim < 1 || dim > 65536) {
    throw new MemoryDbError('invalid_embedding_dim', `embedding 维度（期望 1..65536 的整数，实际 ${dim}）`)
  }
  return dim
}

export function createMemoryTableStatement(dim: number): string {
  const pinned = assertEmbeddingDim(dim)
  return [
    'CREATE NODE TABLE IF NOT EXISTS memory(',
    '  id STRING,',
    '  layer STRING,',
    '  kind STRING,',
    '  priority INT64,',
    '  text STRING,',
    `  embedding FLOAT[${pinned}],`,
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
}

export function createL0RawTableStatement(): string {
  return 'CREATE NODE TABLE IF NOT EXISTS l0_raw(id STRING, raw_text STRING, recorded_at STRING, actor STRING, PRIMARY KEY(id))'
}

export function createMetaTableStatement(): string {
  return 'CREATE NODE TABLE IF NOT EXISTS omw_meta(key STRING, value STRING, PRIMARY KEY(key))'
}

/** HNSW cosine 向量索引：CREATE_VECTOR_INDEX 不幂等，调用前必须查 show_indexes()。 */
export function createVectorIndexStatement(): string {
  return `CALL CREATE_VECTOR_INDEX('memory', 'memory_embedding_hnsw', 'embedding', metric := 'cosine', mu := 30, ml := 60, pu := 0.05, efc := 200)`
}

/** BM25 FTS 索引：同样不幂等；stopwords/stemmer 用官方默认（stopwords 是文件路径 STRING，非数组）。 */
export function createFtsIndexStatement(): string {
  return "CALL CREATE_FTS_INDEX('memory', 'memory_text_fts', ['text'])"
}

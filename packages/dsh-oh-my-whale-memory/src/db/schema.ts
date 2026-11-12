/**
 * 记忆图 schema DDL（Story 1.4 / AD-4）。
 *
 * 列契约（AC2，与 ARCHITECTURE-SPINE ER 图一致）：
 * - memory：id/layer/kind/priority/text/embedding FLOAT[DIM]/
 *   valid_at/recorded_at/invalid_at/expired_at/source_refs[]/embedding_model_id/embedding_dim/parent_id
 *
 * Epic 2 加列（Story 2.4 / U1）：memory.parent_id（STRING，被作废的旧版本节点 id，挂在新节点上）。
 * 新库由 createMemoryTableStatement 直接带上；旧库因 CREATE ... IF NOT EXISTS 是 no-op，
 * 由 database.ts 的唯一迁移点用幂等 `ALTER TABLE memory ADD parent_id STRING` 补列。
 * SCHEMA_VERSION 不变（它只被写、从不被读取，改它只会让新旧库版本串不一致）。
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
    '  parent_id STRING,',
    '  PRIMARY KEY(id)',
    ')',
  ].join('')
}

/** Epic 2 新增列（Story 2.4 / U1）：旧库补列的幂等迁移目标。 */
export const PARENT_ID_COLUMN = 'parent_id'

/**
 * 旧库补 parent_id 列（Story 2.4 / U1）。LadybugDB 0.22.3 实测可用；
 * 幂等性由调用方保证（先 readTableColumns 判列，缺列才执行）——重复执行会抛
 * "Binder exception: Property parent_id already exists"，故不做 IF NOT EXISTS。
 */
export function alterMemoryAddParentIdStatement(): string {
  return `ALTER TABLE ${MEMORY_TABLE} ADD ${PARENT_ID_COLUMN} STRING`
}

export function createL0RawTableStatement(): string {
  return 'CREATE NODE TABLE IF NOT EXISTS l0_raw(id STRING, raw_text STRING, recorded_at STRING, actor STRING, PRIMARY KEY(id))'
}

/**
 * INBOX 队列表（Story 2.2 / AD-6、NFR7）：采集到的条目 FIFO 排队，lease 状态机自愈。
 *
 * 表名 `l1_inbox` 与既有五张表同一 snake_case 约定（epic 原文的 "L1_INBOX" 指的是**队列**
 * 这个逻辑名；`memory.layer` 的历史取值 'L1_INBOX' 是另一回事，不同表不冲突）。
 * 列语义见 src/inbox/queue.ts（状态机与 lease 的唯一实现处）。
 */
export const L1_INBOX_TABLE = 'l1_inbox'

export function createL1InboxTableStatement(): string {
  return [
    'CREATE NODE TABLE IF NOT EXISTS ' + L1_INBOX_TABLE + ' (',
    '  id STRING,',
    '  session_id STRING,',
    '  kind STRING,',
    '  payload STRING,',
    '  status STRING,',
    '  attempts INT64,',
    '  lease_owner STRING,',
    '  lease_until STRING,',
    '  enqueued_at STRING,',
    '  updated_at STRING,',
    '  last_error STRING,',
    '  PRIMARY KEY(id)',
    ')',
  ].join('')
}

export function createMetaTableStatement(): string {
  return 'CREATE NODE TABLE IF NOT EXISTS omw_meta(key STRING, value STRING, PRIMARY KEY(key))'
}

/**
 * 审计账本：generation_log（Story 1.10 / AD-10、AD-21）。
 *
 * 一次迁移与 keyed_decision **同时**建（见 src/db/audit.ts 的 ensureAuditTables），
 * 此后不得再分叉。只 append、永不改写；redact 的墓碑保留 id + recorded_at。
 *
 * - actor / kind / action / policy：动作用语 capture|refine|verify|cascade|redact
 * - l0_refs：向下证据引用；outcome：FR-8 三档 success|failure|uncertain
 * - question_key / probability / threshold / passed：FR-8 核实结果（不新增表）
 * - cascade_depth（直接作废 = 0）/ trigger_id：级联记账（AD-19）
 */
export const GENERATION_LOG_TABLE = 'generation_log'

/**
 * 审计账本：keyed_decision（Story 1.10 / AD-18、AD-19、AD-21）。
 *
 * - judge_key：AD-18 内容键（uuid5('judge:' + policy + ':' + 排序后的 ids)），主键
 * - resolution_source：auto|review|user 三档（v1 只加字段不加流程）
 * - write_pending：中间态，崩溃恢复优先重放
 * - invalidated_by：MAP(STRING, STRING[]) 的多对一失效因果，键 source_id|target_id
 *   （有向：source = 新事实，target = 被失效者）
 */
export const KEYED_DECISION_TABLE = 'keyed_decision'

/** generation_log 建表 DDL：15 列，列序即语义分组（溯源 → 核实 → 级联）。 */
export function createGenerationLogTableStatement(): string {
  return [
    'CREATE NODE TABLE IF NOT EXISTS ' + GENERATION_LOG_TABLE + ' (',
    '  id STRING,',
    '  recorded_at STRING,',
    '  actor STRING,',
    '  kind STRING,',
    '  action STRING,',
    '  policy STRING,',
    '  l0_refs STRING[],',
    '  outcome STRING,',
    '  reason STRING,',
    '  question_key STRING,',
    '  probability DOUBLE,',
    '  threshold DOUBLE,',
    '  passed BOOL,',
    '  cascade_depth INT64,',
    '  trigger_id STRING,',
    '  PRIMARY KEY(id)',
    ')',
  ].join('')
}

/** keyed_decision 建表 DDL：10 列（judge_key 为主键）。 */
export function createKeyedDecisionTableStatement(): string {
  return [
    'CREATE NODE TABLE IF NOT EXISTS ' + KEYED_DECISION_TABLE + ' (',
    '  judge_key STRING,',
    '  new_id STRING,',
    '  old_id STRING,',
    '  action STRING,',
    '  policy STRING,',
    '  l0_refs STRING[],',
    '  resolution_source STRING,',
    '  write_pending BOOL,',
    '  invalidated_by MAP(STRING, STRING[]),',
    '  ts STRING,',
    '  PRIMARY KEY(judge_key)',
    ')',
  ].join('')
}

/** HNSW cosine 向量索引：CREATE_VECTOR_INDEX 不幂等，调用前必须查 show_indexes()。 */
export function createVectorIndexStatement(): string {
  return `CALL CREATE_VECTOR_INDEX('memory', 'memory_embedding_hnsw', 'embedding', metric := 'cosine', mu := 30, ml := 60, pu := 0.05, efc := 200)`
}

/** BM25 FTS 索引：同样不幂等；stopwords/stemmer 用官方默认（stopwords 是文件路径 STRING，非数组）。 */
export function createFtsIndexStatement(): string {
  return "CALL CREATE_FTS_INDEX('memory', 'memory_text_fts', ['text'])"
}

/**
 * 类型化边表（Story 2.6 / AD-4、AD-19、AD-21）。
 *
 * EVIDENCE 必须是 **REL TABLE GROUP**：单条 `*1..4` 变长递归要能跨
 * `l0_raw→memory` 与 `memory→memory` 两段走完「L2→L1→L0」；拆成两张单对边表时
 * 跨表递归不可用，相关子查询会给出错判（brief-2-6-readiness.md §2.3 N1 实测）。
 * GROUP 的两对表**共享属性集**（`CALL table_info('EVIDENCE')` 只返回 reason），
 * 故边上只留 `reason`，不加时间列（brief §5.1 U6，Lead 已批准）。
 *
 * RELATED 是普通 REL TABLE：同层语义关联，由关系识别 LLM 提议、应用层校验后写入。
 *
 * 方向：被引用者 → 引用者（低层 → 高层）。同层禁止 EVIDENCE（U5，同层走 RELATED）。
 */
export const EVIDENCE_TABLE = 'EVIDENCE'
export const RELATED_TABLE = 'RELATED'

/**
 * 闭包深度固定 4（AD-19：常量、不来自配置、不随 FR-12 的 depth 漂移）。
 * L3 已退役（AD-17），现实证据链最长 2 跳（L0→L1→L2），4 是余量而非必需。
 */
export const EVIDENCE_CLOSURE_DEPTH = 4

/** EVIDENCE 建表 DDL：GROUP 挂两对表（l0_raw→memory、memory→memory）。 */
export function createEvidenceTableStatement(): string {
  return (
    'CREATE REL TABLE GROUP IF NOT EXISTS ' + EVIDENCE_TABLE + '(' +
    'FROM ' + L0_RAW_TABLE + ' TO ' + MEMORY_TABLE + ', ' +
    'FROM ' + MEMORY_TABLE + ' TO ' + MEMORY_TABLE + ', ' +
    'reason STRING)'
  )
}

/** RELATED 建表 DDL：同层（memory→memory）。 */
export function createRelatedTableStatement(): string {
  return (
    'CREATE REL TABLE IF NOT EXISTS ' + RELATED_TABLE + '(' +
    'FROM ' + MEMORY_TABLE + ' TO ' + MEMORY_TABLE + ', reason STRING)'
  )
}

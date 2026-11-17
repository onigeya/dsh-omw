/**
 * 记忆图 schema DDL（Story 1.4 / AD-4）。
 *
 * 列契约（AC2，与 ARCHITECTURE-SPINE ER 图一致）：
 * - memory：id/layer/kind/priority/text/embedding FLOAT[DIM]/
 *   valid_at/recorded_at/invalid_at/expired_at/source_refs[]/embedding_model_id/embedding_dim/parent_id/support
 *
 * Epic 2 加列（Story 2.4 / U1）：memory.parent_id（STRING，被作废的旧版本节点 id，挂在新节点上）。
 * Epic 2 加列（Story 2.5 / U16）：memory.support（INT64，直接支撑该节点的存活 L0 观测条数；
 * AD-4 Rule / epics.md:328 本就列了此列，Epic 1 建表时漏落，2.5 的质量门判据③ 要写入它）。
 * 新库由 createMemoryTableStatement 直接带上；旧库此前由 database.ts 的幂等
 * `ALTER TABLE memory ADD parent_id STRING` 补列（Story 4.2 起新列一律只走迁移 0002）。
 * SCHEMA_VERSION 从 Story 4.2 起被真正读取（迁移运行器比较版本），现在是 '9'（迁移 0009）。
 * - l0_raw：id/raw_text/recorded_at/actor（append-only，永不改写，AD-4）；
 *   唯一例外是 Story 4.2 的 redact 墓碑（redacted_by/redacted_at 记录改写者与时刻）。
 *   Story 10.1 / AD-36 起该表分两型：inline（`raw_text` 非空）与 pointer
 *   （`raw_text` NULL、`seq` 非空、`event_type` 记事件类型）；墓碑 = 两者皆空。
 * - generation_log：detail（Story 4.2 只加列，写入方留给后续 story）
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

/**
 * 目标 schema 版本（Story 4.2 / AD-34）：必须等于 `src/db/migrations/` 的最大迁移号，
 * `scripts/check-migrations.mjs` 在 `pnpm verify` 里强制这条一致性。
 */
export const SCHEMA_VERSION = '9'

/** omw_meta 的 key 常量（避免散落的魔法字符串）。 */
export const META_KEYS = {
  schemaVersion: 'schema_version',
  embeddingDim: 'embedding_dim',
  embeddingModelId: 'embedding_model_id',
  createdAt: 'created_at',
  /** Story 2.6 / X1：EVIDENCE 历史回填的断点游标（纯逻辑水位，不新增存储）。 */
  evidenceBackfillCursor: 'evidence_backfill_cursor',
  /** Story 2.5 / 评审 P1（T1）：L1→L2 提升候选的断点游标，形态 `"<recorded_at>|<id>"`。 */
  l2PromotionCursor: 'l2_promotion_cursor',
  /**
   * Story 10.1：token 触发账本的每会话游标前缀（key = `${prefix}<sessionId>`，
   * value = `{"lastSeq":n,"accumTokens":m}`）。会话数上限由宿主会话数决定，不做清理：
   * 游标是幂等重放的唯一水位，删它会把已采集区间重新算一遍。
   */
  captureLedgerPrefix: 'capture_ledger:',
} as const

/** 维度必须是 ≥1 的整数，直接拼进 DDL，越界即拒绝（不信任外部配置）。 */
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
    '  support INT64,',
    // AC:1053 逐字要求 DEFAULT false（0.22.3 的 CREATE 与 ALTER 都接受 DEFAULT，实测）。
    '  evidence_degraded BOOL DEFAULT false,',
    // Story 8.4 / FR-29：句柄 / 摘要节点的展开计数与链深（迁移 0008 给旧库补列）。
    '  expand_count INT64 DEFAULT 0,',
    '  chain_depth INT64 DEFAULT 0,',
    '  last_expanded_at STRING,',
    '  PRIMARY KEY(id)',
    ')',
  ].join('')
}

/** Story 4.2：证据被用户授权抹除的标记列（BOOL，缺省 NULL = 未降级）。 */
export const EVIDENCE_DEGRADED_COLUMN = 'evidence_degraded'

/** Story 4.2：L0 墓碑的改写者 / 改写时刻列。 */
export const REDACTED_BY_COLUMN = 'redacted_by'
export const REDACTED_AT_COLUMN = 'redacted_at'

/** Story 4.2：generation_log 的净化明细列（本 story 只加列，无写入方）。 */
export const GENERATION_LOG_DETAIL_COLUMN = 'detail'

/**
 * 0.22.3 上 BOOL 列只接受 `true`/`false` 或 JS boolean 参数：`= 1` 直接抛
 * "Binder exception: Type Mismatch: Cannot compare types BOOL and INT64"（2026-11-15 实测）。
 * 故判定「已降级」的唯一写法是 `IS NOT NULL AND = true` 的等价式，见下面两个 helper。
 */
export function evidenceDegradedPredicate(alias: string): string {
  return `${alias}.${EVIDENCE_DEGRADED_COLUMN} = true`
}

/**
 * 未降级：NULL（迁移前写入的旧行）或 false（`DEFAULT false` 之后写入的行）。
 *
 * ⚠️ 只能在**确认该列存在**的连接上使用：0.22.3 对未定义属性不是读成 NULL，而是 binder
 * 直接抛 `Cannot find property evidence_degraded`。调用方必须先经
 * `db/column-presence.ts` 的 `schemaColumnPresence()` 判列，缺列时用不含本列的旧谓词。
 */
export function notEvidenceDegradedPredicate(alias: string): string {
  return `(${alias}.${EVIDENCE_DEGRADED_COLUMN} IS NULL OR ${alias}.${EVIDENCE_DEGRADED_COLUMN} = false)`
}

/**
 * L0「仍有原文」谓词（Story 4.2 单一实现，替换全仓三处手写 `raw_text IS NOT NULL`）。
 *
 * 墓碑判据从 AD-36 的「指针行 `raw_text IS NULL` 且 `seq IS NULL`」扩展：redact 过的
 * inline 行保留 `raw_text` 列但落墓碑文本，必须靠 `redacted_at IS NULL` 才能与真实原文区分。
 *
 * ⚠️ 0.22.3 对未定义属性直接抛 binder 异常（实测 `Invalid struct field name: redacted_at`），
 * 不会退化成 NULL。所以本谓词只用于**已确认有该列**的连接；v1 旧库（只读、未迁移）请改用
 * {@link l0RawTextPredicate}，选择逻辑在 `db/column-presence.ts`。
 */
export function l0EvidencePredicate(alias: string): string {
  return `${alias}.raw_text IS NOT NULL AND ${alias}.${REDACTED_AT_COLUMN} IS NULL`
}

/** 缺 `redacted_at` 列的旧库用的 L0 存活谓词（等价 Story 4.2 之前的行为）。 */
export function l0RawTextPredicate(alias: string): string {
  return `${alias}.raw_text IS NOT NULL`
}

/**
 * Story 10.1 / AD-36：`l0_raw` 分两型的列契约。
 *
 * - inline 行：`raw_text` 非空、`seq` NULL（Epic 2 起的整段快照，迁移 0009 只加列不改行）；
 * - pointer 行：`raw_text` NULL、`seq` + `event_type` 非空（每消息事件一行，正文按需解析）。
 *
 * 墓碑判据因此从「`raw_text IS NULL`」改成「两者皆空」——redact 仍然只改 `raw_text`
 * （把 inline 行替换成墓碑文本），所以指针行永远不会被 redact 选中（见 `db/redact.ts`）。
 */
export const SEQ_COLUMN = 'seq'
export const EVENT_TYPE_COLUMN = 'event_type'

/**
 * 「这一行仍是可达 L0」谓词（Story 10.1 的单一实现，EII / 存活计数共用）：
 * `(raw_text IS NOT NULL OR seq IS NOT NULL) AND redacted_at IS NULL`。
 *
 * ⚠️ 同 {@link l0EvidencePredicate}：0.22.3 对未定义属性直接抛 binder 异常，所以只在
 * **确认 `seq` 与 `redacted_at` 两列都存在**的连接上使用；选择逻辑在
 * `db/column-presence.ts` 的 `l0LivePredicate()`（禁止调用方各写一份三元表达式）。
 */
export function l0PointerAwarePredicate(alias: string): string {
  return `(${alias}.raw_text IS NOT NULL OR ${alias}.${SEQ_COLUMN} IS NOT NULL) ` +
    `AND ${alias}.${REDACTED_AT_COLUMN} IS NULL`
}

/**
 * 墓碑文本（D-4 逐字可断言）：`[REDACTED <l0id> @<ISO8601>]`。
 *
 * 不含任何原文片段，也不含记忆 id 以外的语义；`id`/`recorded_at`/`actor` 保持原值，
 * 于是墓碑行仍能被 `source_refs` 与 EVIDENCE 边找回（AC:1045 的「不删行」）。
 */
export function l0TombstoneText(l0Id: string, redactedAt: string): string {
  return `[REDACTED ${l0Id} @${redactedAt}]`
}

/** 迁移账本表（Story 4.2 / AD-34）：只 append，重放幂等。 */
export const SCHEMA_MIGRATION_TABLE = 'schema_migration'

export function createSchemaMigrationTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS ' + SCHEMA_MIGRATION_TABLE + '(' +
    'version INT64, applied_at STRING, checksum STRING, PRIMARY KEY(version))'
  )
}
/**
 * 待裁决冲突（Story 7.1 / FR-20、AD-18 的 `await-confirmation` 载体）。
 *
 * 为什么必须新建表（AD-34：加表要 bump SCHEMA_VERSION 并写迁移）：`keyed_decision` 按 AD-21 只存
 * id / 策略 / 结果枚举，**不存正文**（NFR9），而候选正文必须活到用户裁决那一刻——放进程内存态
 * 一重启就丢。`id` 直接取 keyed 裁决的 `judge_key`（内容键），于是「一条 pending 行 ↔ 一条
 * await-confirmation 裁决」是一一对应的，resolve 时两边能对得上。
 *
 * 生命周期：写入路径（persona 冲突）INSERT；`/memory resolve` 在同一事务里写入新节点 + 写
 * supersede/merge 的 keyed 行 + DELETE 本行。`payload` 是记忆正文（用户自己写的内容）。
 */
export const PENDING_DECISION_TABLE = 'pending_decision'

export function createPendingDecisionTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS ' + PENDING_DECISION_TABLE + '(' +
    'id STRING, old_id STRING, new_id STRING, payload STRING, kind STRING, priority INT64, ' +
    'actor STRING, created_at STRING, PRIMARY KEY(id))'
  )
}

/** Epic 2 新增列（Story 2.4 / U1）：旧库补列的幂等迁移目标。 */
export const PARENT_ID_COLUMN = 'parent_id'

/**
 * 旧库补 parent_id 列（Story 2.4 / U1）。LadybugDB 0.22.3 实测可用；
 * 幂等性由调用方保证（先 readTableColumns 判列，缺列才执行），重复执行会抛
 * "Binder exception: Property parent_id already exists"，故不做 IF NOT EXISTS。
 */
export function alterMemoryAddParentIdStatement(): string {
  return `ALTER TABLE ${MEMORY_TABLE} ADD ${PARENT_ID_COLUMN} STRING`
}

/**
 * Epic 2 新增列（Story 2.5 / U16）：support 的旧库补列目标（与 parent_id 同一模式）。
 *
 * **取值契约（Story 5.4 / AC:1319-1321 的显式声明）**：
 * - **L2**：提升写入时算一次 = 其来源 L1 各自「存活 L0 集」的并集去重计数（`promotion.ts` 的
 *   `countSupport`）；合并语义取较大者且单调不减（`memory.ts` 的 ON MATCH 子句）。
 * - **L1：该列恒为 NULL，且不适用**。L1 的支撑本来就是它自己 `source_refs` 里存活 L0 的条数，
 *   读侧必须**现算**（`countSupport([detail])`），**不得把 NULL 读成 0**——0 的含义是「有来源但全
 *   不可达」，与「没算过 / 不适用」完全不同。
 * - **重算时机**：只有 L2 提升那一刻算一次；redact 之后存活 L0 会变化，但本列不后台重算（避免与
 *   墓碑重写竞争）。需要最新值的读侧一律用 `countSupport` 现算，本列只作写入时的历史快照。
 */

export const SUPPORT_COLUMN = 'support'

/**
 * 旧库补 support 列（Story 2.5 / U16）。幂等性由调用方保证（先 readTableColumns 判列），
 * 重复执行会抛 "Binder exception: Property support already exists"，故不做 IF NOT EXISTS。
 */
export function alterMemoryAddSupportStatement(): string {
  return `ALTER TABLE ${MEMORY_TABLE} ADD ${SUPPORT_COLUMN} INT64`
}

export function createL0RawTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS l0_raw(id STRING, raw_text STRING, recorded_at STRING, actor STRING, ' +
    REDACTED_BY_COLUMN + ' STRING, ' + REDACTED_AT_COLUMN + ' STRING, ' +
    // Story 10.1 / AD-36：pointer 行的两列（迁移 0009 给旧库补列；旧 inline 行读 null）。
    SEQ_COLUMN + ' INT64, ' + EVENT_TYPE_COLUMN + ' STRING, PRIMARY KEY(id))'
  )
}

/**
 * INBOX 队列表（Story 2.2 / AD-6、NFR7）：采集到的条目 FIFO 排队，lease 状态机自愈。
 *
 * 表名 `l1_inbox` 与既有五张表同一 snake_case 约定（epic 原文的 "L1_INBOX" 指的是队列
 * 这个逻辑名；`memory.layer` 的历史取值 'L1_INBOX' 是另一回事，不同表不冲突）。
 * 列语义见 src/inbox/queue.ts（状态机与 lease 的唯一实现处）。
 */
export const L1_INBOX_TABLE = 'l1_inbox'

/**
 * Story 2.5 / U1：L2 提升队列（与 l1_inbox 同列、同状态机，只有表名不同）。
 * 泛化的语句生成在 src/inbox/queue.ts 的 createInboxQueue(table)；
 * 表名只能是本文件导出的常量，绝不接受外部输入（不把用户数据拼进 DDL）。
 */
export const L2_INBOX_TABLE = 'l2_inbox'

/** 队列 DDL（按表名生成，列契约的唯一来源）。 */
export function createInboxTableStatement(table: string): string {
  return [
    'CREATE NODE TABLE IF NOT EXISTS ' + table + ' (',
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

export function createL1InboxTableStatement(): string {
  return createInboxTableStatement(L1_INBOX_TABLE)
}

export function createL2InboxTableStatement(): string {
  return createInboxTableStatement(L2_INBOX_TABLE)
}

export function createMetaTableStatement(): string {
  return 'CREATE NODE TABLE IF NOT EXISTS omw_meta(key STRING, value STRING, PRIMARY KEY(key))'
}

/**
 * 审计账本：generation_log（Story 1.10 / AD-10、AD-21）。
 *
 * 一次迁移与 keyed_decision 同时建（见 src/db/audit.ts 的 ensureAuditTables），
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
 * - judge_key：AD-18 内容键（Story 5.4 起**含 action**：`uuid5('judge:' + policy + ':' + action + ':' + 排序后的 ids)`），主键；迁移 0003 已把旧键行就地重算
 * - resolution_source：auto|review|user 三档（v1 只加字段不加流程）
 * - write_pending：中间态，崩溃恢复优先重放
 * - invalidated_by：MAP(STRING, STRING[]) 的多对一失效因果，键 source_id|target_id
 *   （有向：source = 新事实，target = 被失效者）
 */
export const KEYED_DECISION_TABLE = 'keyed_decision'

/** generation_log 建表 DDL：16 列，列序即语义分组（溯源 → 核实 → 级联 → 净化明细）。 */
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
    '  detail STRING,',
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
  return `CALL CREATE_VECTOR_INDEX('${MEMORY_TABLE}', '${VECTOR_INDEX_NAME}', 'embedding', metric := 'cosine', mu := 30, ml := 60, pu := 0.05, efc := 200)`
}

/** BM25 FTS 索引：同样不幂等；stopwords/stemmer 用官方默认（stopwords 是文件路径 STRING，非数组）。 */
export function createFtsIndexStatement(): string {
  return `CALL CREATE_FTS_INDEX('${MEMORY_TABLE}', '${FTS_INDEX_NAME}', ['text'])`
}

/**
 * 类型化边表（Story 2.6 / AD-4、AD-19、AD-21）。
 *
 * EVIDENCE 必须是 REL TABLE GROUP：单条 `*1..4` 变长递归要能跨
 * `l0_raw→memory` 与 `memory→memory` 两段走完「L2→L1→L0」；拆成两张单对边表时
 * 跨表递归不可用，相关子查询会给出错判（brief-2-6-readiness.md §2.3 N1 实测）。
 * GROUP 的两对表共享属性集（`CALL table_info('EVIDENCE')` 只返回 reason），
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
/**
 * 慢路径任务队列（Story 7.2 / AD-6 的「慢路径独立队列与预算」、AD-20、Q-4）。
 *
 * 为什么单独一张表而不是复用 `l2_inbox`：AD-6 明确慢路径**不共用**快路径 FIFO（lease 60s / 重试 3 次 /
 * 24h stale 只约束快路径），混用会让慢任务的 15–45min 级回测把采集/精炼挤住。反思（本 story）是它的
 * 第一个生产者，7.3 的策略候选与 champion-challenger 回测复用它。
 *
 * 状态机：`pending → processing(lease_owner, lease_until) → done | failed`（与 AD-6 同形，但取自本表）。
 * `attempts` 计单任务已重试次数（上限 3）；`window_round` 记整窗重扫已发生轮次（上限 2）。
 */
export const SLOW_TASK_TABLE = 'slow_task'

export function createSlowTaskTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS ' + SLOW_TASK_TABLE + '(' +
    'id STRING, kind STRING, payload STRING, state STRING, attempts INT64, window_round INT64, ' +
    'lease_owner STRING, lease_until STRING, last_error STRING, created_at STRING, updated_at STRING, ' +
    'PRIMARY KEY(id))'
  )
}
/**
 * 策略候选区（Story 7.3 / AD-20）。
 *
 * AD-20 逐字：「队列落 `strategy_candidate` 表 `{id, strategy_id, payload, created_at, expires_at, outcome}`，
 * `(strategy_id, state)` 计 pending」。本 story 在其上加 `state`（pending/adopted/rejected/expired）、
 * `rewrites`（最多 2 次重写，改写对象仅限候选本身）与 `score`（采纳门分数，便于 status 与审计）。
 *
 * **禁止整体重写正文**：`payload` 只在 `rewrites < 2` 时由 `rewriteCandidate` 改写；
 * 已入正式区的策略是 `memory` 节点，本表永远不会动它。
 */
export const STRATEGY_CANDIDATE_TABLE = 'strategy_candidate'

export function createStrategyCandidateTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS ' + STRATEGY_CANDIDATE_TABLE + '(' +
    'id STRING, strategy_id STRING, payload STRING, state STRING, rewrites INT64, score DOUBLE, ' +
    // AC:1458：候选必须能回溯到产生它的轨迹 / 反思（可回溯到 L0）——没有这列就是口头满足。
    'outcome STRING, reasons STRING, source_refs STRING[], created_at STRING, expires_at STRING, ' +
    'updated_at STRING, ' +
    'PRIMARY KEY(id))'
  )
}
/**
 * 压缩运行账本（Story 8.1 / AD-26、AD-21、INV-22）：每次 compaction 的 Config 快照。
 *
 * Epic 8 的首张新表，owner = `context/`。为什么必须落表：压缩行为随配置漂移，事后要能回答
 * 「那次压缩是在什么配置下做的」——只存当前 Config 无法回答历史问题。
 *
 * `(session_id, compaction_id)` 是业务唯一键（AC:1532 的幂等判据），但 LadybugDB 的复合唯一约束不可靠，
 * 故唯一性由写路径（先查后写、同事务）保证，本表只声明 PRIMARY KEY(id)。
 */
export const COMPACTION_RUN_TABLE = 'compaction_run'

export function createCompactionRunTableStatement(): string {
  return (
    'CREATE NODE TABLE IF NOT EXISTS ' + COMPACTION_RUN_TABLE + '(' +
    'id STRING, compaction_id STRING, session_id STRING, config_snapshot_json STRING, started_at STRING, ' +
    // AC:1535：被折叠的 seq 列表与区间必须可回溯（JSON 字符串，不引入结构化列）。
    'shadowed_seqs_json STRING, shadowed_range_json STRING, ' +
    // Story 8.4：档位落账（迁移 0008 给旧库补这三列；缺 plan 时留 NULL，不编造）。
    'plan_json STRING, tier STRING, delegate STRING, ' +
    'PRIMARY KEY(id))'
  )
}

/** Story 8.4 / T1：`compaction_run` 的三列（档位判定证据，全部可空）。 */
export const COMPACTION_PLAN_JSON_COLUMN = 'plan_json'
export const COMPACTION_TIER_COLUMN = 'tier'
export const COMPACTION_DELEGATE_COLUMN = 'delegate'

/** Story 8.4 / T1：`memory` 的句柄展开统计三列（迁移 0008 给旧库补列）。 */
export const EXPAND_COUNT_COLUMN = 'expand_count'
export const CHAIN_DEPTH_COLUMN = 'chain_depth'
export const LAST_EXPANDED_AT_COLUMN = 'last_expanded_at'

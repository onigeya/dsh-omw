/**
 * 审计账本（Story 1.10 / AD-10、AD-18、AD-19、AD-21）。
 *
 * 一次迁移建两张可加表（DDL 在 ./schema.ts，迁移由本文件的 ensureAuditTables 用单事务
 * 执行，因此 all-or-nothing）：
 *
 * - generation_log：溯源行（recorded_at / actor / kind / action / policy / l0_refs[] /
 *   outcome / reason）＋ 级联记账（cascade_depth / trigger_id）＋ FR-8 核实结果
 *   （question_key / probability / threshold / passed）。只 append、永不改写（与 L0 同
 *   精神，AD-21）。
 * - keyed_decision：keyed 裁决记录（judge_key / new_id / old_id / action / policy /
 *   l0_refs[] / resolution_source / write_pending）＋ 失效因果（invalidated_by，
 *   MAP(STRING, STRING[])，AD-18 / AD-19）。
 *
 * 引擎事实（2026-11-11 实测，@ladybugdb/core）：
 * - MAP(STRING, STRING[]) 列可用；写参数必须是 JS Map（传普通对象报
 *   "Unsupported casting function from STRUCT to MAP"），读回是普通对象。
 * - 没有 MAP_CONCAT，故「追加触发 id」只能是「读现值 → JS 合并 → SET 回写」。
 * - 审计表不存在时报 "Binder exception: Table ... does not exist."。
 *
 * 凭据纪律（NFR9 / AD-9）：本文件的任何列都只放 id、引用、策略名与结果枚举；调用方
 * 不得把记忆原文、向量或凭据值传进账本列。
 */
import { randomUUID } from 'node:crypto'
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from './errors.js'
import { uuid5 } from './id.js'
import { collectRows, queryAll } from './rows.js'
import {
  GENERATION_LOG_TABLE,
  KEYED_DECISION_TABLE,
  MEMORY_TABLE,
  createGenerationLogTableStatement,
  createKeyedDecisionTableStatement,
} from './schema.js'
import { runInTransaction } from './transaction.js'

/** 写入主体三档（AD-21）。 */
export type MemoryActor = 'user' | 'agent' | 'system'

/** generation_log.outcome 三档（FR-8 / AD-21）。 */
export type GenerationLogOutcome = 'success' | 'failure' | 'uncertain'

/** keyed 裁决的动作三档（AD-18）。 */
export type KeyedDecisionAction = 'supersede' | 'merge' | 'await-confirmation'

/** 裁决来源三档（AD-18 / A-11：v1 只加字段、不加流程）。 */
export type ResolutionSource = 'auto' | 'review' | 'user'

/** 采集写路径的 kind 取值——Epic 1 唯一接线的写路径。 */
export const CAPTURE_KIND = 'capture'

/** 采集写路径的 action 取值。 */
export const UPSERT_MEMORY_ACTION = 'upsert_memory'

/**
 * 采集写路径的 policy 取值：capture 不做冲突裁决，按 AD-18 三档缺省的末档记账；
 * 真出现版本写入时由裁决方显式给出 policy。
 */
export const DEFAULT_CAPTURE_POLICY = 'last-writer-wins'

/** 直接作废（非级联）的级联深度 = 0（AD-19）。 */
export const DIRECT_CASCADE_DEPTH = 0

/** 一条溯源 / 级联 / 核实记账行。缺省值一律落 null，不落空串。 */
export interface GenerationLogEntry {
  /** 缺省由本层生成 UUIDv4。崩溃重放要幂等时由调用方给**确定性** id。 */
  id?: string
  /** 本次**操作**时间（UTC ISO-8601），不是节点最终 recorded_at。 */
  recordedAt: string
  actor: MemoryActor
  /** capture | refine | verify | cascade | redact（AD-21）。 */
  kind: string
  /** 该写路径的动作用语，如 upsert_memory。 */
  action: string
  policy?: string | null
  /** 向下证据引用（消息 id / L0 段落 id）。 */
  l0Refs?: readonly string[]
  outcome?: GenerationLogOutcome | null
  reason?: string | null
  /** FR-8 核实：question key / 概率 / 阈值 / 判定。 */
  questionKey?: string | null
  probability?: number | null
  threshold?: number | null
  passed?: boolean | null
  /** 级联记账：被波及记忆的级联深度，直接作废为 DIRECT_CASCADE_DEPTH。 */
  cascadeDepth?: number | null
  /** 级联记账：触发源 generation_log 行 id。 */
  triggerId?: string | null
}

/** 一条 keyed 裁决记录（写入用）。 */
export interface KeyedDecisionEntry {
  /** AD-18 键式，见 buildJudgeKey。 */
  judgeKey: string
  newId: string
  oldId: string
  action: KeyedDecisionAction
  policy: string
  l0Refs?: readonly string[]
  resolutionSource: ResolutionSource
  /** 中间态标记：true 表示裁决已落、发布点未完成，崩溃恢复优先重放。 */
  writePending?: boolean
  /** 失效因果，键见 buildInvalidatedByKey。 */
  invalidatedBy?: ReadonlyMap<string, readonly string[]>
  ts: string
}

/** 回填一次失效因果所需的最小信息。 */
export interface InvalidationCauseInput {
  /** keyed_decision 主键（AD-18 键式）。 */
  judgeKey: string
  /** 有向边对的 source：**新事实**（触发者）。 */
  sourceId: string
  /** 有向边对的 target：**被失效者**。 */
  targetId: string
  /** 触发 id（通常是对应 generation_log 行的 id）。 */
  triggerId: string
}

const INSERT_GENERATION_LOG = [
  'CREATE (:' + GENERATION_LOG_TABLE + ' {',
  '  id: $id, recorded_at: $recorded_at, actor: $actor, kind: $kind, action: $action,',
  '  policy: $policy, l0_refs: $l0_refs, outcome: $outcome, reason: $reason,',
  '  question_key: $question_key, probability: $probability, threshold: $threshold,',
  '  passed: $passed, cascade_depth: $cascade_depth, trigger_id: $trigger_id',
  '})',
].join('\n')

const MERGE_KEYED_DECISION = [
  'MERGE (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key})',
  '  ON CREATE SET k.new_id = $new_id, k.old_id = $old_id, k.action = $action,',
  '    k.policy = $policy, k.l0_refs = $l0_refs, k.resolution_source = $resolution_source,',
  '    k.write_pending = $write_pending, k.invalidated_by = $invalidated_by, k.ts = $ts',
].join('\n')

const MARK_KEYED_DECISION_PUBLISHED = [
  'MATCH (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key})',
  '  SET k.write_pending = false',
  '  RETURN k.judge_key AS judge_key',
].join('\n')

const LIST_PENDING_KEYED_DECISIONS = [
  'MATCH (k:' + KEYED_DECISION_TABLE + ')',
  '  WHERE k.write_pending = true',
  '  RETURN k.judge_key AS judge_key',
  '  ORDER BY k.ts',
].join('\n')

const READ_INVALIDATED_BY = [
  'MATCH (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key})',
  '  RETURN k.invalidated_by AS invalidated_by',
].join('\n')

const SET_INVALIDATED_BY = [
  'MATCH (k:' + KEYED_DECISION_TABLE + ' {judge_key: $judge_key})',
  '  SET k.invalidated_by = $invalidated_by',
  '  RETURN k.judge_key AS judge_key',
].join('\n')

/**
 * v1 只读校验器口径：audit_gap 的**可计算子集**——已失效（invalid_at 或 expired_at）
 * 却没有 keyed 裁决记录可重建的版本写入（AC :441 / AD-21 三集之一）。另两集
 * （EII 违例、EVIDENCE 边与 source_refs[] 漂移）依赖类型化边表，Epic 4 才建。
 */
const AUDIT_GAP_STATEMENT = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  '  WHERE m.invalid_at IS NOT NULL OR m.expired_at IS NOT NULL',
  '  OPTIONAL MATCH (k:' + KEYED_DECISION_TABLE + ') WHERE k.old_id = m.id',
  '  WITH m, k WHERE k IS NULL',
  '  RETURN count(DISTINCT m) AS gap',
].join('\n')

/** 审计表存在性探针：任一张缺失即按「算不出来」处理（矩阵行「审计表缺失」）。 */
const GENERATION_LOG_PROBE = `CALL table_info('${GENERATION_LOG_TABLE}') RETURN name`
const KEYED_DECISION_PROBE = `CALL table_info('${KEYED_DECISION_TABLE}') RETURN name`

/**
 * AD-18 键式，逐字：uuid5('judge:' + policy + ':' + [old_id, new_id].sort().join(':'))。
 * 键与新旧 id 的先后无关，重放/重裁决得到同一个键。
 */
export function buildJudgeKey(policy: string, oldId: string, newId: string): string {
  return uuid5('judge:' + policy + ':' + [oldId, newId].sort().join(':'))
}

/**
 * AD-18 / AD-19 的 invalidated_by 键形态，有向：source = 新事实、target = 被失效者。
 * 同一对边被多次触发时在**同一个键**下追加触发 id 列表，故键只含 id 对、不含触发 id。
 */
export function buildInvalidatedByKey(sourceId: string, targetId: string): string {
  return sourceId + '|' + targetId
}

/**
 * 建两张审计表。只应在建库/打开库的迁移点调用一次；DDL 在事务内执行，任一失败则两张
 * 表都回滚（实测：事务内第二条 DDL 失败会连带回滚第一条已建的表）。
 */
export async function ensureAuditTables(connection: lbug.Connection): Promise<void> {
  await runInTransaction(connection, async () => {
    await connection.query(createGenerationLogTableStatement())
    await connection.query(createKeyedDecisionTableStatement())
  })
}

/**
 * 追加一条 generation_log 行，返回其 id。只 append，绝不改写既有行。
 * 15 列全部显式绑定（缺省值绑 null／空列表），避免"列没出现在语句里"这种隐式行为。
 */
export async function insertGenerationLog(
  connection: lbug.Connection,
  entry: GenerationLogEntry,
): Promise<string> {
  const id = entry.id ?? randomUUID()
  const statement = await connection.prepare(INSERT_GENERATION_LOG)
  await connection.execute(statement, {
    id,
    recorded_at: entry.recordedAt,
    actor: entry.actor,
    kind: entry.kind,
    action: entry.action,
    policy: entry.policy ?? null,
    l0_refs: entry.l0Refs === undefined ? [] : entry.l0Refs.map(String),
    outcome: entry.outcome ?? null,
    reason: entry.reason ?? null,
    question_key: entry.questionKey ?? null,
    probability: entry.probability ?? null,
    threshold: entry.threshold ?? null,
    passed: entry.passed ?? null,
    cascade_depth: entry.cascadeDepth ?? null,
    trigger_id: entry.triggerId ?? null,
  })
  return id
}

/**
 * 落一条 keyed 裁决记录，返回 judge_key。
 *
 * 用 MERGE 而非 CREATE：judge_key 是内容键（AD-18），崩溃重放同一裁决必须幂等——
 * CREATE 撞主键会报错并让整个写事务回滚。既有键的字段保持首次写入的值。
 */
export async function insertKeyedDecision(
  connection: lbug.Connection,
  entry: KeyedDecisionEntry,
): Promise<string> {
  const statement = await connection.prepare(MERGE_KEYED_DECISION)
  await connection.execute(statement, {
    judge_key: entry.judgeKey,
    new_id: entry.newId,
    old_id: entry.oldId,
    action: entry.action,
    policy: entry.policy,
    l0_refs: entry.l0Refs === undefined ? [] : entry.l0Refs.map(String),
    resolution_source: entry.resolutionSource,
    write_pending: entry.writePending ?? false,
    invalidated_by: toValueMap(entry.invalidatedBy),
    ts: entry.ts,
  })
  return entry.judgeKey
}

/**
 * 把 write_pending 翻回 false——崩溃恢复在「先重放 write_pending」之后调它。
 * key 不存在时报 audit_record_missing（不静默 no-op）。
 */
export async function markKeyedDecisionPublished(
  connection: lbug.Connection,
  judgeKey: string,
): Promise<void> {
  const statement = await connection.prepare(MARK_KEYED_DECISION_PUBLISHED)
  const rows = await collectRows(await connection.execute(statement, { judge_key: judgeKey }))
  if (rows.length === 0) {
    throw new MemoryDbError('audit_record_missing', '裁决记录不存在（judge_key=' + judgeKey + '）：无法标记 write_pending=false')
  }
}

/** 待重放的裁决键，按 ts 升序（崩溃恢复优先重放这批）。 */
export async function listPendingKeyedDecisions(connection: lbug.Connection): Promise<readonly string[]> {
  const rows = await queryAll(connection, LIST_PENDING_KEYED_DECISIONS)
  return rows.map((row) => String(row.judge_key))
}

/**
 * 回填一次失效因果：在 (source, target) 边对的键下**追加**触发 id。
 *
 * 追加、不覆盖（graphiti 的 dict[str, list[str]] 形态）；同一触发 id 已在列则原样返回，
 * 使重放幂等。级联行本身由 insertGenerationLog 写（带 cascadeDepth / triggerId），
 * 与主操作同事务。
 *
 * 本函数是「读-复制-写整个 MAP 列」，自己不开事务：**必须由调用方在自己的
 * runInTransaction 内调用**（连同级联行一起提交），否则并发追加会互相覆盖。
 */
export async function appendInvalidationCause(
  connection: lbug.Connection,
  input: InvalidationCauseInput,
): Promise<readonly string[]> {
  const readStatement = await connection.prepare(READ_INVALIDATED_BY)
  const rows = await collectRows(await connection.execute(readStatement, { judge_key: input.judgeKey }))
  const row = rows[0]
  if (row === undefined) {
    throw new MemoryDbError('audit_record_missing', '裁决记录不存在（judge_key=' + input.judgeKey + '）：无法回填失效因果')
  }

  const causes = toListMap(row.invalidated_by)
  const key = buildInvalidatedByKey(input.sourceId, input.targetId)
  const existing = causes.get(key) ?? []
  const next = existing.includes(input.triggerId) ? existing : [...existing, input.triggerId]
  causes.set(key, next)

  const writeStatement = await connection.prepare(SET_INVALIDATED_BY)
  const written = await collectRows(await connection.execute(writeStatement, {
    judge_key: input.judgeKey,
    invalidated_by: causes,
  }))
  if (written.length === 0) {
    throw new MemoryDbError('audit_record_missing', '裁决记录不存在（judge_key=' + input.judgeKey + '）：失效因果回填未生效')
  }
  return next
}

/**
 * audit_gap 计数：已失效却没有 keyed 裁决记录的版本写入条数。
 *
 * 返回 null 表示**算不出来**（审计表不存在）——调用方必须显式展示「未知」，绝不静默报 0。
 * 其它错误照抛。
 */
export async function computeAuditGap(connection: lbug.Connection): Promise<number | null> {
  try {
    // 账本不完整（任一张审计表缺失）时差额算不出来，绝不静默报 0。
    await queryAll(connection, GENERATION_LOG_PROBE)
    await queryAll(connection, KEYED_DECISION_PROBE)
    const rows = await queryAll(connection, AUDIT_GAP_STATEMENT)
    const value = rows[0]?.gap
    return typeof value === 'number' ? value : Number(value ?? 0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 实测文案："Binder exception: Table generation_log does not exist."（T41）
    if (/does not exist/i.test(message)) return null
    throw error
  }
}

/** 读回的 invalidated_by 是普通对象（也兼容 Map），统一成 Map<string, string[]>。 */
function toListMap(value: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (value === null || value === undefined) return out
  const entries: Iterable<[unknown, unknown]> =
    value instanceof Map ? value.entries() : Object.entries(value as Record<string, unknown>)
  for (const [key, list] of entries) {
    out.set(String(key), Array.isArray(list) ? list.map(String) : [])
  }
  return out
}

/** 写参数只接受 JS Map；缺省为空 Map（实测空 Map 往返为 {}）。 */
function toValueMap(value: ReadonlyMap<string, readonly string[]> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (value === undefined) return out
  for (const [key, list] of value) out.set(key, [...list])
  return out
}

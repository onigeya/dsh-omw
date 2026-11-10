/**
 * memory 节点写入（AC3 / AC6）。
 *
 * 同一 (layer, 归一化 text) 重复写入命中同一 id（FR-15 路径①）：
 * - ON CREATE 建节点；
 * - ON MATCH 合并 source_refs（`list_distinct(list_concat(...))` 去重并集）、
 *   保留最早 recorded_at（`CASE WHEN ... THEN ... END`，ISO-8601 UTC 可字典序比较）、
 *   不改 text/layer/kind/priority/embedding（首次写入者的内容为准）。
 *
 * 2026-11-09 实测：MERGE ON CREATE/ON MATCH、list_distinct、CASE 表达式、prepare/execute
 * 参数绑定在 LadybugDB 0.22.3 上均可用。
 *
 * Story 1.6：embedding 可缺省（memory_remember 直写 L1 时不产向量，Epic 2 补齐）。
 * 缺省走 UPSERT_STATEMENT_WITHOUT_EMBEDDING——ON CREATE 完全不触碰
 * embedding / embedding_model_id / embedding_dim 三列（保持 NULL，绝不写零向量），
 * 且不绑定这三个参数；ON MATCH 语义与带向量版本完全一致。
 *
 * Story 1.7：显式 `embedding: null`（手动写入无 embedding 客户端）与缺省走同一条
 * 无向量路径——两条 story 的"无向量"语义必须一致，否则同指纹节点会因写法不同而分叉。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import { MEMORY_TABLE } from './schema.js'

export type MemoryConnection = lbug.Connection

export interface UpsertMemoryInput {
  /**
   * 记忆层：spine 枚举 `L0|L1|L2|L3`；禁空、禁冒号。
   * 注意 `'L1_INBOX'` 不是本表 layer 的取值——INBOX 是 Epic 2 引入的另一张表。
   */
  layer: string
  /** 记忆原文；参与指纹，归一化后为空即拒绝。 */
  text: string
  /**
   * 向量；长度必须等于库 pin 的 dim。省略或传 `null` 表示本次无向量（Story 1.6
   * memory_remember 直写 L1 / Story 1.7 手动写入，Epic 1 无 embedding 客户端）——
   * 写入节点时三列 embedding / embedding_model_id / embedding_dim 全部保持 NULL，
   * 绝不写零向量污染 HNSW（Story 2.3 引入客户端后回填）。
   */
  embedding?: readonly number[] | null
  /** 该向量使用的模型 id（写入节点列）；无向量时必须一并缺省或为 null。 */
  embeddingModelId?: string | null
  /** 记忆类型，可选（如 note / summary）。 */
  kind?: string
  /** 优先级，默认 0。 */
  priority?: number
  /** 生效时间，默认 now。 */
  validAt?: string
  /** 记录时间，默认 now；同指纹冲突时保留更早值。 */
  recordedAt?: string
  /** 来源引用（消息 id / 卡片 id），默认 []。 */
  sourceRefs?: readonly string[]
}

export interface UpsertMemoryResult {
  id: string
  /** 该节点最终的 recorded_at（可能比本次写入更早）。 */
  recordedAt: string
}

/**
 * ON MATCH 子句：带/不带向量的两条 MERGE 逐字共用。
 * 抽成常量是为了避免只改一条语句导致合并语义静默分叉（Story 1.6 新增了第二条语句）。
 */
const UPSERT_ON_MATCH_CLAUSE = [
  '  ON MATCH SET m.source_refs = list_distinct(list_concat(m.source_refs, $source_refs)),',
  '    m.recorded_at = CASE WHEN $recorded_at < m.recorded_at THEN $recorded_at ELSE m.recorded_at END',
].join('')

const UPSERT_STATEMENT = [
  `MERGE (m:${MEMORY_TABLE} {id: $id})`,
  '  ON CREATE SET m.layer = $layer, m.kind = $kind, m.priority = $priority, m.text = $text,',
  '    m.embedding = $embedding, m.valid_at = $valid_at, m.recorded_at = $recorded_at,',
  '    m.source_refs = $source_refs, m.embedding_model_id = $embedding_model_id, m.embedding_dim = $embedding_dim',
  UPSERT_ON_MATCH_CLAUSE,
  '  RETURN m.id AS id, m.recorded_at AS recorded_at',
].join('')

/**
 * 无向量写入变体：ON CREATE 不写 embedding 三列（保持 NULL），也不绑定对应参数。
 * ON MATCH 与带向量版本逐字一致，保证同指纹二次写入仍只合并 source_refs / 保留最早 recorded_at。
 */
const UPSERT_STATEMENT_WITHOUT_EMBEDDING = [
  `MERGE (m:${MEMORY_TABLE} {id: $id})`,
  '  ON CREATE SET m.layer = $layer, m.kind = $kind, m.priority = $priority, m.text = $text,',
  '    m.valid_at = $valid_at, m.recorded_at = $recorded_at, m.source_refs = $source_refs',
  UPSERT_ON_MATCH_CLAUSE,
  '  RETURN m.id AS id, m.recorded_at AS recorded_at',
].join('')

/** 单条 query() 的结果归一为行数组（多语句才返回数组，见 lbug.d.ts）。 */
export async function queryAll(connection: MemoryConnection, statement: string): Promise<Record<string, unknown>[]> {
  const result = await connection.query(statement)
  const single = Array.isArray(result) ? result[0]! : result
  const rows = await single.getAll()
  return rows as Record<string, unknown>[]
}

/** 写入/合并一条记忆。返回节点 id 与最终 recorded_at。 */
export async function upsertMemory(
  connection: MemoryConnection,
  input: UpsertMemoryInput,
  options?: { now?: () => Date },
): Promise<UpsertMemoryResult> {
  const id = memoryNodeId(input.layer, input.text)
  const now = (options?.now ?? (() => new Date())).call(undefined)
  const recordedAt = input.recordedAt ?? now.toISOString()
  const validAt = input.validAt ?? now.toISOString()
  const sourceRefs = (input.sourceRefs ?? []).map(String)
  // 省略 / null = 本次无向量（Story 1.6 工具直写、Story 1.7 手动写入）：不构造、也不绑定
  // embedding 参数（LadybugDB 对未绑定参数直接报错），改走 UPSERT_STATEMENT_WITHOUT_EMBEDDING，
  // 三列保持 NULL。禁止用零向量占位——会污染 HNSW 近邻。
  const embedding = input.embedding == null ? undefined : Array.from(input.embedding, (value) => Number(value))

  const statement = await connection.prepare(
    embedding === undefined ? UPSERT_STATEMENT_WITHOUT_EMBEDDING : UPSERT_STATEMENT,
  )
  const params: Record<string, lbug.LbugValue> = {
    id,
    layer: input.layer.trim(),
    kind: input.kind ?? '',
    priority: Math.trunc(input.priority ?? 0),
    text: input.text,
    valid_at: validAt,
    recorded_at: recordedAt,
    source_refs: sourceRefs,
  }
  if (embedding !== undefined) {
    params.embedding = embedding
    params.embedding_model_id = input.embeddingModelId ?? ''
    params.embedding_dim = embedding.length
  }
  const result = await connection.execute(statement, params)
  const single = Array.isArray(result) ? result[0]! : result
  const rows = (await single.getAll()) as Record<string, unknown>[]
  const row = rows[0]
  if (!row) {
    throw new MemoryDbError('db_open_failed', `记忆写入未返回结果（id=${id}）：${JSON.stringify(input.sourceRefs ?? [])}`)
  }
  return { id: String(row.id), recordedAt: String(row.recorded_at) }
}

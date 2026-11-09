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
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import { MEMORY_TABLE } from './schema.js'

export type MemoryConnection = lbug.Connection

export interface UpsertMemoryInput {
  /** 记忆层，如 'L1_INBOX' / 'L2_WIKI'；禁空、禁冒号。 */
  layer: string
  /** 记忆原文；参与指纹，归一化后为空即拒绝。 */
  text: string
  /** 向量；长度必须等于库 pin 的 dim。 */
  embedding: readonly number[]
  /** 该向量使用的模型 id（写入节点列）。 */
  embeddingModelId: string
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

const UPSERT_STATEMENT = [
  `MERGE (m:${MEMORY_TABLE} {id: $id})`,
  '  ON CREATE SET m.layer = $layer, m.kind = $kind, m.priority = $priority, m.text = $text,',
  '    m.embedding = $embedding, m.valid_at = $valid_at, m.recorded_at = $recorded_at,',
  '    m.source_refs = $source_refs, m.embedding_model_id = $embedding_model_id, m.embedding_dim = $embedding_dim',
  '  ON MATCH SET m.source_refs = list_distinct(list_concat(m.source_refs, $source_refs)),',
  '    m.recorded_at = CASE WHEN $recorded_at < m.recorded_at THEN $recorded_at ELSE m.recorded_at END',
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
  const embedding = Array.from(input.embedding, (value) => Number(value))

  const statement = await connection.prepare(UPSERT_STATEMENT)
  const result = await connection.execute(statement, {
    id,
    layer: input.layer.trim(),
    kind: input.kind ?? '',
    priority: Math.trunc(input.priority ?? 0),
    text: input.text,
    embedding,
    valid_at: validAt,
    recorded_at: recordedAt,
    source_refs: sourceRefs,
    embedding_model_id: input.embeddingModelId,
    embedding_dim: embedding.length,
  })
  const single = Array.isArray(result) ? result[0]! : result
  const rows = (await single.getAll()) as Record<string, unknown>[]
  const row = rows[0]
  if (!row) {
    throw new MemoryDbError('db_open_failed', `记忆写入未返回结果（id=${id}）：${JSON.stringify(input.sourceRefs ?? [])}`)
  }
  return { id: String(row.id), recordedAt: String(row.recorded_at) }
}

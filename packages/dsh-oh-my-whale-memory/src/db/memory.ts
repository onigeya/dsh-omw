/**
 * memory 节点写入（AC3 / AC6）。
 *
 * 同一 (layer, 归一化 text) 重复写入命中同一 id（FR-15 路径①）：
 * - ON CREATE 建节点；
 * - ON MATCH 合并 source_refs（`list_distinct(list_concat(...))` 去重并集）、
 *   保留最早 recorded_at（`CASE WHEN ... THEN ... END`，ISO-8601 UTC 可字典序比较）、
 *   以**最新写入的分类为准**更新 kind/priority（Story 1.11 AC4——同文本不同分类仍是同一条）；
 *   text/layer/embedding 仍以首次写入者的内容为准（指纹不含 kind/priority，见 `./id.js`）。
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
 *
 * Story 1.8：本文件同时承载**只读**浏览路径（`listMemories` / `getMemoryById`）——
 * 过滤/排序/截断全部在库侧完成，参数一律 prepare+execute 绑定，见文件末尾。
 */
import type * as lbug from '@ladybugdb/core'
import {
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  UPSERT_MEMORY_ACTION,
  insertGenerationLog,
  type MemoryActor,
} from './audit.js'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import { collectRows, queryAll } from './rows.js'
import { MEMORY_TABLE } from './schema.js'
import { runInTransaction } from './transaction.js'

/** 行归一 helper 已移到 ./rows.ts（审计层同样要用，避免模块环）；这里保留同名 re-export 不动既有导入面。 */
export { queryAll } from './rows.js'

export type MemoryConnection = lbug.Connection

export interface UpsertMemoryInput {
  /**
   * 记忆层：spine 枚举 `L0|L1|L2|L3`；禁空、禁冒号。
   * Story 1.11 已收敛写路径：`src/index.ts` 的 `writeL1Inbox` 与 `memory_remember` 都写 `'L1'`
   * （= `MEMORY_REMEMBER_LAYER`）；`'L1_INBOX'` 从此只是 INBOX 队列标识/表名，不再是本表 layer 取值。
   * 读路径仍不做 layer 白名单——Story 1.7 存量 `'L1_INBOX'` 行必须照常可见（Story 1.8）。
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
  /**
   * 记忆类型，可选。FR-15 七类：`persona | episodic | instruction | work_fact |
   * work_task | work_method | work_artifact`；缺省落库空串。不参与指纹。
   */
  kind?: string
  /** 优先级，默认 0；FR-15 取值 `-1..100`（-1 = 全局强规则 / 恒置顶）。不参与指纹。 */
  priority?: number
  /** 生效时间，默认 now。 */
  validAt?: string
  /** 记录时间，默认 now；同指纹冲突时保留更早值。 */
  recordedAt?: string
  /** 来源引用（消息 id / 卡片 id），默认 []。 */
  sourceRefs?: readonly string[]
  /** 发起写入的主体（AD-21 三档），只进 generation_log 的 actor 列，不参与节点指纹；缺省 system。 */
  actor?: MemoryActor
}

export interface UpsertMemoryResult {
  id: string
  /** 该节点最终的 recorded_at（可能比本次写入更早）。 */
  recordedAt: string
}

/**
 * ON MATCH 子句：带/不带向量的两条 MERGE 逐字共用。
 * 抽成常量是为了避免只改一条语句导致合并语义静默分叉（Story 1.6 新增了第二条语句）。
 *
 * Story 1.11（AC4）：kind / priority 以**最新写入**为准（`m.kind = $kind` / `m.priority = $priority`），
 * 与 text / layer / embedding（首次写入者为准）有意不同——同文本换分类仍命中同一 id。
 */
const UPSERT_ON_MATCH_CLAUSE = [
  '  ON MATCH SET m.source_refs = list_distinct(list_concat(m.source_refs, $source_refs)),',
  '    m.kind = $kind, m.priority = $priority,',
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
 * ON MATCH 与带向量版本逐字一致，保证同指纹二次写入仍只合并 source_refs / 保留最早 recorded_at，
 * 并同样以最新写入更新 kind / priority（Story 1.11 AC4）。
 */
const UPSERT_STATEMENT_WITHOUT_EMBEDDING = [
  `MERGE (m:${MEMORY_TABLE} {id: $id})`,
  '  ON CREATE SET m.layer = $layer, m.kind = $kind, m.priority = $priority, m.text = $text,',
  '    m.valid_at = $valid_at, m.recorded_at = $recorded_at, m.source_refs = $source_refs',
  UPSERT_ON_MATCH_CLAUSE,
  '  RETURN m.id AS id, m.recorded_at AS recorded_at',
].join('')

/**
 * 写入/合并一条记忆，并在**同一事务**内追加一条溯源行（AD-10）。
 * 返回节点 id 与最终 recorded_at。
 */
export async function upsertMemory(
  connection: MemoryConnection,
  input: UpsertMemoryInput,
  options?: { now?: () => Date },
): Promise<UpsertMemoryResult> {
  return runInTransaction(connection, () => writeMemoryVersion(connection, input, options))
}

/**
 * 在**调用方已开启的事务**内写入一次记忆版本：MERGE 节点 + 追加 generation_log 溯源行。
 *
 * 单独导出是因为 AD-10 的置序要求（先写从属记录、后写指针/发布点）只对**多步**操作有
 * 意义：L1→L2 精炼、版本替换、级联作废等下游路径要在自己的事务里把本步骤与其它从属写
 * 放在一起。闭环写路径（upsertMemory）只是它包一层事务的退化情形。
 *
 * 记账行只承载 id / 引用 / 策略 / 结果枚举——**绝不写记忆原文、向量或任何凭据**（NFR9）。
 * 行时间用本次**操作时间**，不是节点最终 recorded_at：同指纹二次写入时节点保留更早的
 * recorded_at，而账本记的是「这次操作发生在何时」。
 */
export async function writeMemoryVersion(
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
  const rows = await collectRows(result)
  const row = rows[0]
  if (!row) {
    throw new MemoryDbError('db_open_failed', `记忆写入未返回结果（id=${id}）：${JSON.stringify(input.sourceRefs ?? [])}`)
  }
  // AD-10 置序：节点的 source_refs 是「从属记录」、随上面的 MERGE 一起落齐；本行是同
  // 一事务里的账目追加。写日志失败 → 引擎回滚整个事务，节点也留不下。
  await insertGenerationLog(connection, {
    recordedAt: now.toISOString(),
    actor: input.actor ?? 'system',
    kind: CAPTURE_KIND,
    action: UPSERT_MEMORY_ACTION,
    policy: DEFAULT_CAPTURE_POLICY,
    l0Refs: sourceRefs,
    outcome: 'success',
  })
  return { id: String(row.id), recordedAt: String(row.recorded_at) }
}

/**
 * Story 1.8 读路径：列表 / 详情。
 *
 * 与写路径共用连接与表，但**只读**：
 * - 列表过滤 `invalid_at IS NULL AND expired_at IS NULL`（当前快照语义，FR-14）；`layer`
 *   不做白名单过滤——Story 1.7 存量 `'L1_INBOX'` 行与其它非枚举值也照常列出；
 * - 排序 `recorded_at DESC` + `$limit` 截断全在库侧完成（LadybugDB 0.22.3 已实测
 *   `ORDER BY`、参数化 `LIMIT`、`lower(...) CONTAINS lower(...)` 均可用）；
 * - 关键词是**字面包含**匹配（两侧小写化），不是语义检索 / 向量 / FTS / RRF；
 * - 详情 `getMemoryById` **不做有效性过滤**：已失效/已过期的墓碑也要能 show 出来，
 *   与列表的隐藏语义不对称是有意的（Story 1.8 AC3）。
 *
 * 参数（关键词 / id / limit）一律经 prepare+execute 绑定，绝不把用户输入拼进语句。
 */
const LIST_MEMORIES_PROJECTION = [
  'RETURN m.id AS id, m.layer AS layer, m.text AS text',
  'ORDER BY m.recorded_at DESC',
  'LIMIT $limit',
].join(' ')

const LIST_MEMORIES_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.invalid_at IS NULL AND m.expired_at IS NULL',
  LIST_MEMORIES_PROJECTION,
].join(' ')

const LIST_MEMORIES_WITH_KEYWORD_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.invalid_at IS NULL AND m.expired_at IS NULL AND lower(m.text) CONTAINS lower($query)',
  LIST_MEMORIES_PROJECTION,
].join(' ')

/** 详情投影：显式列出字段，**不含 `m.embedding`**（向量列不回显给命令层）。 */
const GET_MEMORY_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  'WHERE m.id = $id',
  'RETURN m.id AS id, m.layer AS layer, m.kind AS kind, m.priority AS priority, m.text AS text,',
  'm.valid_at AS valid_at, m.recorded_at AS recorded_at, m.invalid_at AS invalid_at,',
  'm.expired_at AS expired_at, m.source_refs AS source_refs, m.embedding_model_id AS embedding_model_id',
].join(' ')

/** 参数化读查询：绑定值一律走 prepare+execute（与写路径同一套 execute 形态）。 */
async function queryRows(
  connection: MemoryConnection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/** NULL/undefined 归一为 null（列里的 null 是「未设置」，与空串不同）。 */
function nullishToString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** STRING[] 列归一为字符串数组；NULL 归一为 `[]`。 */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

export interface ListMemoriesOptions {
  /** 关键词（字面包含匹配，两侧小写化）；省略 = 不过滤。 */
  query?: string
  /** 返回条数上限（非负整数；命令层传 `MEMORY_LIST_DEFAULT_LIMIT`）。 */
  limit: number
}

/** 列表项：只取渲染需要的三列（排序与截断已在库侧完成）。 */
export interface MemoryListEntry {
  id: string
  layer: string
  text: string
}

/** 单条记忆详情（字段顺序即 `show` 渲染顺序；不含 embedding 向量列）。 */
export interface MemoryDetail {
  id: string
  layer: string
  kind: string
  priority: number
  text: string
  validAt: string | null
  recordedAt: string
  invalidAt: string | null
  expiredAt: string | null
  sourceRefs: string[]
  embeddingModelId: string | null
}

/**
 * 最近未失效的记忆（`recorded_at` 倒序、最多 `limit` 条，含 Story 1.7 存量 `'L1_INBOX'` 行）。
 * 只读：不写库、不改任何行。关键词做两侧小写化的字面包含匹配。
 */
export async function listMemories(
  connection: MemoryConnection,
  options: ListMemoriesOptions,
): Promise<MemoryListEntry[]> {
  const limit = Math.max(0, Math.trunc(options.limit))
  const keyword = options.query?.trim()
  const rows = keyword
    ? await queryRows(connection, LIST_MEMORIES_WITH_KEYWORD_STATEMENT, { query: keyword, limit })
    : await queryRows(connection, LIST_MEMORIES_STATEMENT, { limit })
  return rows.map((row) => ({
    id: String(row.id),
    layer: String(row.layer ?? ''),
    text: String(row.text ?? ''),
  }))
}

/**
 * 按 id 取一条记忆的完整字段；不存在返回 `null`（不抛错，由命令层渲染「未找到」）。
 * 不做有效性过滤——已失效 / 已过期的墓碑照样返回，且 `invalid_at` / `expired_at` 原样带回。
 */
export async function getMemoryById(connection: MemoryConnection, id: string): Promise<MemoryDetail | null> {
  const rows = await queryRows(connection, GET_MEMORY_STATEMENT, { id })
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    layer: String(row.layer ?? ''),
    kind: String(row.kind ?? ''),
    priority: Number(row.priority ?? 0),
    text: String(row.text ?? ''),
    validAt: nullishToString(row.valid_at),
    recordedAt: String(row.recorded_at ?? ''),
    invalidAt: nullishToString(row.invalid_at),
    expiredAt: nullishToString(row.expired_at),
    sourceRefs: toStringArray(row.source_refs),
    embeddingModelId: nullishToString(row.embedding_model_id),
  }
}

/**
 * Story 1.9 读路径：`/memory status` 的层计数。
 *
 * 计数事实源只有 `memory` 表的 `layer` 列——Epic 1 无 INBOX 表、无 failed 存储
 * （`schema.ts` 只有 memory / l0_raw / omw_meta），队列与状态机属 Epic 2 Story 2.2。
 * 口径（spec Design Notes）：按 `layer` 聚合**全部行**，不套 `invalid_at` / `expired_at`
 * 过滤——status 回答「系统规模 / 占用量」，与 list 的「当前有效快照」是不同问题。
 *
 * 只展示四个已知层（spec 钉死的展示集合）；未知 `layer` 值不参与展示，也不入返回——
 * 出现即说明有未登记的写路径。Story 1.11 已把写路径收敛到 `'L1'`；`'L1_INBOX'` / `'L2_INBOX'`
 * 现在只作 INBOX 队列标识/表名的历史计数位保留（Story 1.7 存量行仍会命中 `L1_INBOX` 计数）。
 */
export const COUNTED_MEMORY_LAYERS = ['L1', 'L2', 'L1_INBOX', 'L2_INBOX'] as const
export type CountedMemoryLayer = (typeof COUNTED_MEMORY_LAYERS)[number]
export type MemoryLayerCounts = Record<CountedMemoryLayer, number>

/**
 * 库侧聚合：一条语句同时给出四层，避免 4 次查询。
 * 2026-11-11 实测 @ladybugdb/core 0.22.3 支持 `RETURN m.layer AS layer, count(m) AS total`
 * （按非聚合投影列分组，`total` 为 number）。但聚合支持度属数据库实现细节，故仍保留
 * `LIST_MEMORY_LAYERS_STATEMENT` 的 JS 侧退化路径——两条路径返回同一形状。
 */
const COUNT_MEMORIES_BY_LAYER_STATEMENT = `MATCH (m:${MEMORY_TABLE}) RETURN m.layer AS layer, count(m) AS total`
const LIST_MEMORY_LAYERS_STATEMENT = `MATCH (m:${MEMORY_TABLE}) RETURN m.layer AS layer`

/** 四个已知层的零值基座（缺省补 0，绝不出现 `undefined`）。 */
function emptyMemoryLayerCounts(): MemoryLayerCounts {
  return { L1: 0, L2: 0, L1_INBOX: 0, L2_INBOX: 0 }
}

function isCountedMemoryLayer(value: unknown): value is CountedMemoryLayer {
  return typeof value === 'string' && (COUNTED_MEMORY_LAYERS as readonly string[]).includes(value)
}

/** 累加一个层计数：未知层与非有限 total 一律忽略（不生成未登记的口径）。 */
function addLayerCount(counts: MemoryLayerCounts, layer: unknown, amount: number): void {
  if (!isCountedMemoryLayer(layer)) return
  if (!Number.isFinite(amount)) return
  counts[layer] += amount
}

/**
 * 按 `layer` 统计四个已知层的行数。**先探针**库侧聚合；聚合不可用时退化为
 * `RETURN m.layer AS layer` + JS 侧 tally。两路径返回同一形状（已知层缺省补 0）。
 * 只读：不写库、不加写语句。
 */
export async function countMemoriesByLayer(connection: MemoryConnection): Promise<MemoryLayerCounts> {
  const counts = emptyMemoryLayerCounts()
  let rows: Record<string, unknown>[]
  try {
    rows = await queryAll(connection, COUNT_MEMORIES_BY_LAYER_STATEMENT)
  } catch {
    // 库侧聚合不可用：退化为逐行取 layer，再在 JS 侧累加（同一返回形状）。
    rows = await queryAll(connection, LIST_MEMORY_LAYERS_STATEMENT)
    for (const row of rows) addLayerCount(counts, row.layer, 1)
    return counts
  }
  for (const row of rows) addLayerCount(counts, row.layer, Number(row.total))
  return counts
}

/**
 * INBOX 精炼处理器（Story 2.3）：`ctx.llm` 单通道精炼 → 写时嵌入 → 单事务落 L1 + 记账。
 *
 * 顺序（AD-10 置序 / N9）：**先在同一个事务里**把条目标 done（`markInboxItemDone`，
 * 条件转换 processing→done 即 at-most-once，R1），再写 L1 节点，最后写精炼 outcome 审计行；
 * 三者要么一起落、要么一起回滚，崩溃重放不会重复产出（U12）。
 *
 * 失败路径：审计行必须在事务回滚**之后另开事务**写，然后抛 {@link InboxRefineError} 让消费者
 * 记队列失败（attempts+1 + 退避；`fatal` 时直接进死信，AC:581）。
 */
import type * as lbug from '@ladybugdb/core'
import { REFINE_INBOX_ACTION, REFINE_KIND, insertGenerationLog } from '../db/audit.js'
import { memoryNodeId } from '../db/id.js'
import { getMemoryById, writeMemoryVersion } from '../db/memory.js'
import { runInTransaction } from '../db/transaction.js'
import { EMBEDDING_MAX_BATCH, type EmbedClient } from '../embedding/client.js'
import { InboxRefineError, type InboxProcessResult } from '../inbox/consumer.js'
import {
  INBOX_STATUS_PENDING,
  INBOX_STATUS_PROCESSING,
  markInboxItemDone,
  readInboxItemStatus,
  type InboxItem,
  type InboxStatus,
} from '../inbox/queue.js'
import { MEMORY_REMEMBER_LAYER } from '../tools/memory-remember.js'
import { refineTranscript, type LlmPort, type RefineFailure, type RefineRoute } from './llm-refine.js'

/** 单次 `process` 的硬上界（R2：一次尝试 ≤30s，含 embedding；重试不在同一次尝试内）。 */
export const INBOX_PROCESS_TIMEOUT_MS = 30_000

/**
 * LLM 调用的子预算（评审 T13）：把总上界 30s 里的后 10s 留给 embedding
 * （客户端自带 EMBEDDING_TIMEOUT_MS = 10s），即「LLM ≤20s + embedding ≤10s ≤ 30s」。
 */
export const INBOX_LLM_TIMEOUT_MS = 20_000

/** 无路由的降级理由（N5 逐字要求）。 */
export const NO_PROVIDER_ROUTE_REASON = 'no-provider-route'

/** embedding 失败时记在精炼审计行 reason 里的前缀（N4）。 */
export const EMBEDDING_FAILED_REASON = 'embedding-failed'

/** LLM 给了非法/缺失 kind 或 priority、已收敛为缺省常量（N10）。 */
export const COERCED_CLASSIFICATION_REASON = 'coerced-kind-or-priority'

export interface InboxProcessorDeps {
  /** 惰性取连接（与消费者同一 accessor）。 */
  readonly connection: () => lbug.Connection | null
  /** 宿主 LLM 单通道（apply 期间不得求值，N2）。 */
  readonly llm: LlmPort
  /**
   * 路由解析：Config 的 llmProvider/llmModel 优先，缺省从 session model/selection 解析
   * （AC:567）。返回 null = 解析失败 ⇒ 直接降级、**不调 LLM**（N5）。
   */
  readonly resolveRoute: (sessionId: string) => RefineRoute | null
  /** embeddings 客户端；缺省或未给 model 则本次不产向量（L1 照常写入）。 */
  readonly embedding?: EmbedClient | null
  readonly embeddingModel?: string | null
  /** 写入 embedding_model_id 列的值（N4：失败时该列与 dim 留空）。 */
  readonly embeddingModelId?: string | null
  readonly timeoutMs?: number
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
}

interface EmbedFactsResult {
  readonly vectors: readonly (readonly number[] | null)[]
  readonly failure: { readonly reason: string; readonly message: string } | null
}

/**
 * 写时嵌入（N4 / AC:589）：写库事务**之前**取向量。任一批次失败都不阻塞 L1 写入，
 * 只把该批记成无向量（三列留空），并把失败摘要交给审计行。
 */
async function embedFacts(
  deps: InboxProcessorDeps,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<EmbedFactsResult> {
  const vectors: (readonly number[] | null)[] = texts.map(() => null)
  const client = deps.embedding
  const model = deps.embeddingModel
  if (!client || !model || texts.length === 0) return { vectors, failure: null }
  let failure: { reason: string; message: string } | null = null
  for (let start = 0; start < texts.length; start += EMBEDDING_MAX_BATCH) {
    const chunk = texts.slice(start, start + EMBEDDING_MAX_BATCH)
    const result = await client.embed(model, chunk, signal)
    if (!result.ok) {
      failure = failure ?? { reason: result.reason, message: result.message }
      continue
    }
    for (let i = 0; i < chunk.length; i += 1) vectors[start + i] = result.vectors[i] ?? null
  }
  return { vectors, failure }
}

/** 入口守卫判据：pending（直接调用/未 claim）与 processing（消费者已 claim）都继续；其余一律短路。 */
function isProcessableStatus(status: InboxStatus | null): boolean {
  return status === INBOX_STATUS_PENDING || status === INBOX_STATUS_PROCESSING
}

/** 失败审计行：必须**另开事务**写（调用方的事务已回滚），否则随回滚一起消失（N9）。 */
async function recordRefineFailure(
  connection: lbug.Connection,
  item: InboxItem,
  failure: RefineFailure,
  now: () => Date,
): Promise<void> {
  await runInTransaction(connection, () =>
    insertGenerationLog(connection, {
      recordedAt: now().toISOString(),
      actor: 'system',
      kind: REFINE_KIND,
      action: REFINE_INBOX_ACTION,
      outcome: failure.retryable ? 'uncertain' : 'failure',
      reason: failure.reason,
      l0Refs: [item.id],
    }),
  )
}

/**
 * 组装 2.3 的精炼处理器：交给 `createInboxConsumer({ process })` 注入（R4）。
 * 返回的处理器已完成全部队列记账（标 done / 抛错交给消费者记失败），调用方无需再包装。
 */
export function createInboxProcessor(deps: InboxProcessorDeps): (item: InboxItem) => Promise<InboxProcessResult> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? INBOX_PROCESS_TIMEOUT_MS

  return async (item: InboxItem): Promise<InboxProcessResult> => {
    const connection = deps.connection()
    if (!connection) throw new Error('INBOX 精炼时数据库连接不可用（id=' + item.id + '）')

    // ⓪ 入口状态守卫（评审 T7）：只有还「待处理」的条目才值得精炼。
    // 消费者已把它 claim 成 processing（正常路径）；直接对 done/failed/缺失的条目调 process 时
    // 立刻返回，**不写审计、不调 LLM**——否则会在 markInboxItemDone 守卫之前多写一行 refine 审计。
    const status = await readInboxItemStatus(connection, item.id)
    if (!isProcessableStatus(status)) return { completed: true, kinds: [] }

    // ① 路由解析闸门（AC:568）：解析失败直接降级，绝不调 LLM。
    const route = deps.resolveRoute(item.sessionId)
    if (!route) {
      const failure: RefineFailure = {
        reason: NO_PROVIDER_ROUTE_REASON,
        message: '未解析到可用的 provider/model 路由（session=' + item.sessionId + '）',
        retryable: true,
      }
      await recordRefineFailure(connection, item, failure, now)
      throw new InboxRefineError(failure.message, { reason: failure.reason, fatal: false })
    }

    // ② 一次尝试 = 一次 ctx.llm.stream（R2：重试不在同一次尝试内）；总上界 30s，LLM 只吃 20s（T13）。
    const signal = AbortSignal.timeout(timeoutMs)
    const llmSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, INBOX_LLM_TIMEOUT_MS))])
    const refined = await refineTranscript({
      llm: deps.llm,
      route,
      transcript: item.payload,
      signal: llmSignal,
    })
    if (!refined.ok) {
      await recordRefineFailure(connection, item, refined.failure, now)
      throw new InboxRefineError(
        'LLM 精炼失败（' + refined.failure.reason + '）：' + refined.failure.message,
        { reason: refined.failure.reason, fatal: !refined.failure.retryable },
      )
    }

    // ③ 写时嵌入：在写库事务之前（AC:589）。
    const embedded = await embedFacts(deps, refined.facts.map((fact) => fact.text), signal)
    if (embedded.failure) {
      deps.logger?.warn(
        'INBOX 写时嵌入失败（id=' + item.id + '，reason=' + embedded.failure.reason + '）：' +
        embedded.failure.message + '——L1 照常写入，embedding 两列留空',
      )
    }

    // ④ 单事务：条件转 done → 写 L1 → 写 outcome 审计行（R1 / N9）。
    let marked = false
    await runInTransaction(connection, async () => {
      marked = await markInboxItemDone(connection, item.id, { now: now() })
      if (!marked) return
      for (let i = 0; i < refined.facts.length; i += 1) {
        const fact = refined.facts[i]!
        const vector = embedded.vectors[i] ?? null
        // 评审 T3：coerced 表示「模型没判定」，不是一次重新分类。
        // UPSERT_ON_MATCH 无条件以最新写入为准（Story 1.11 AC4），若直接把缺省值写下去，
        // 会把先前 memory_remember 写在同指纹节点上的 kind（如 'persona'）静默清空。
        // 故 coerced 时沿用既有节点的分类；同事务内读，节点不存在才用缺省。
        const existing = fact.coerced
          ? await getMemoryById(connection, memoryNodeId(MEMORY_REMEMBER_LAYER, fact.text))
          : null
        await writeMemoryVersion(
          connection,
          {
            layer: MEMORY_REMEMBER_LAYER,
            text: fact.text,
            embedding: vector,
            embeddingModelId: vector ? (deps.embeddingModelId ?? null) : null,
            kind: existing ? existing.kind : fact.kind,
            priority: existing ? existing.priority : fact.priority,
            sourceRefs: [item.id],
            actor: 'system',
          },
          { now },
        )
      }
      await insertGenerationLog(connection, {
        recordedAt: now().toISOString(),
        actor: 'system',
        kind: REFINE_KIND,
        action: REFINE_INBOX_ACTION,
        outcome: 'success',
        reason: null,
        l0Refs: [item.id],
      })
      if (embedded.failure) {
        await insertGenerationLog(connection, {
          recordedAt: now().toISOString(),
          actor: 'system',
          kind: REFINE_KIND,
          action: REFINE_INBOX_ACTION,
          outcome: 'uncertain',
          reason: EMBEDDING_FAILED_REASON + ': ' + embedded.failure.reason,
          l0Refs: [item.id],
        })
      }
      if (refined.facts.some((fact) => fact.coerced)) {
        await insertGenerationLog(connection, {
          recordedAt: now().toISOString(),
          actor: 'system',
          kind: REFINE_KIND,
          action: REFINE_INBOX_ACTION,
          outcome: 'uncertain',
          reason: COERCED_CLASSIFICATION_REASON,
          l0Refs: [item.id],
        })
      }
    })

    // marked=false：条目已被处理过（R1 的 at-most-once 命中），本次不写任何产出。
    if (!marked) return { completed: true, kinds: [] }
    return { completed: true, kinds: refined.facts.map((fact) => fact.kind) }
  }
}

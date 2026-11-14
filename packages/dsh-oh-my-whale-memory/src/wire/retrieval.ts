/**
 * 召回域装配（Story 3.1 / 3.2、F-01/F-02/F-05/F-07/F-09）。
 *
 * 一个 `retrieval` 单元同时服务命令面（`/memory recall|related`，**不计**配额）与工具面
 * （`memory_recall` / `memory_related`，共享同一个 turn 配额实例）。所有依赖惰性读库句柄：
 * 注册发生在建库之前，库未就绪时命令层收敛为 error、工具面返回 `db_unavailable`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCommandDependencies } from '../command.js'
import type { RuntimeConfig } from '../config.js'
import type { MemoryDatabase } from '../db/database.js'
import { traverseRelated } from '../db/edges.js'
import { createEmbeddingClient, type EmbedClient } from '../embedding/client.js'
import { runRecallCore, type RecallCoreResult } from '../recall/core.js'
import type { MemoryRecallStore } from '../tools/memory-recall.js'
import { RELATED_TRAVERSAL_TIMEOUT_MS, type MemoryRelatedStore } from '../tools/memory-related.js'
import { createQuotaResetListener, createRecallTurnQuota, type RecallQuota } from '../tools/recall-quota.js'
import { toRelatedSuccessView } from '../tools/related-shared.js'
import type { SessionEventHost } from './host.js'

/**
 * 召回查询向量的超时预算（Story 3.1）：召回是软目标 ≤500ms，网络等待必须短——
 * 超时即降级为关键词单路（结果标 `degraded: true`，绝不静默）。
 * embedding 客户端自身另有 10s 硬超时，这里取更短的值让降级尽快发生。
 */
const RECALL_EMBED_TIMEOUT_MS = 4_000

export interface RetrievalOptions {
  readonly ctx: Context
  readonly getDb: () => MemoryDatabase | undefined
  readonly readConnection: () => MemoryDatabase
  readonly resolved: RuntimeConfig
}

export interface RetrievalWiring {
  readonly recallStore: MemoryRecallStore
  readonly relatedStore: MemoryRelatedStore
  /** 每轮召回配额（memory_recall / memory_related 共享同一实例，同轮合计 3 次）。 */
  readonly quota: RecallQuota
  readonly recallMemories: MemoryCommandDependencies['recallMemories']
  readonly relatedMemories: MemoryCommandDependencies['relatedMemories']
  /**
   * 注册 `turn/start` / `turn/end` 双点配额重置（spec D7）。
   * `ctx.on` 自动挂 disposer，故**不新增 ctx.effect**（entry-exports 钉死 closer 数）。
   */
  readonly wireQuotaReset: () => void
}

export function createRetrievalWiring(options: RetrievalOptions): RetrievalWiring {
  const { ctx, getDb, readConnection, resolved } = options

  /**
   * 混合检索内核的调用点（命令面与工具面共用，不复制第二份参数装配）。
   * 库内 pin 的 embedding 模型 id 取 `db.modelId`——模型不符的节点不进向量路。
   */
  const runRecall = async (input: {
    readonly query: string
    readonly queryVector: readonly number[] | null
    readonly limit: number
    readonly layer?: string
    /** F-09：宿主取消信号，透传进内核在每条语句边界检查。 */
    readonly signal?: AbortSignal
  }): Promise<RecallCoreResult> => {
    const database = readConnection()
    return runRecallCore({
      connection: database.connection,
      query: input.query,
      queryVector: input.queryVector,
      embeddingModelId: database.modelId,
      rrfK: resolved.rrfK,
      retrievalTopK: resolved.retrievalTopK,
      layerWeights: resolved.layerWeights,
      priorityWeight: resolved.priorityWeight,
      limit: input.limit,
      layer: input.layer ?? null,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  /**
   * recall 的 embedding 客户端——**惰性**构造（只读实例也构造：它不写向量，但召回需要查询
   * 向量；写者路径的 embeddingClient 在只读早退之后，这里不能依赖它）。
   * dim 用库内实际 pin 的 `db.dim`（与节点向量同源，AD-14）。
   */
  let recallEmbeddingClient: EmbedClient | null | undefined
  const getRecallEmbeddingClient = (dim: number): EmbedClient | null => {
    if (recallEmbeddingClient !== undefined) return recallEmbeddingClient
    recallEmbeddingClient =
      resolved.embeddingMode === 'enabled' && resolved.embedding.endpoint
        ? createEmbeddingClient({
          endpoint: resolved.embedding.endpoint,
          token: resolved.embedding.token ?? '',
          dim,
        })
        : null
    return recallEmbeddingClient
  }

  const recallStore: MemoryRecallStore = {
    get embeddingEnabled() {
      return getDb() !== undefined && resolved.embeddingMode === 'enabled'
    },
    async embedQuery(query, signal) {
      const database = getDb()
      if (!database) return null
      // F-02 / AD-14：查询向量与节点向量必须同一模型。写者模式开库时会把库内 pin 改写成本次
      // 配置的模型（database.ts），只读模式不改写——此时若配置与 pin 不一致，用配置模型取
      // 查询向量、再对库内异模型向量算余弦，结果排序是噪声。直接跳过向量路（degraded + warn）。
      const configuredModel = resolved.embedding.model
      if (configuredModel !== undefined && configuredModel !== database.modelId) {
        ctx.logger.warn(
          `召回跳过语义向量路：配置 embedding.model=${configuredModel} 与库内 pin=${database.modelId} 不一致` +
          '（异模型向量不可比对）；只读实例不修改库级元数据，本次仅关键词单路。',
        )
        return null
      }
      const client = getRecallEmbeddingClient(database.dim)
      if (!client) return null
      // F-09：宿主取消信号与本地 4s 超时任一触发即中止 embed（any 取先到者）。
      const timeout = AbortSignal.timeout(RECALL_EMBED_TIMEOUT_MS)
      const combinedSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const result = await client.embed(
        configuredModel ?? database.modelId,
        [query],
        combinedSignal,
      )
      if (!result.ok) {
        // 降级必须可见（FR-11）：日志可见 + 结果标 degraded。
        ctx.logger.warn(`召回查询向量失败，降级为关键词单路：${result.reason}`)
        return null
      }
      return result.vectors[0] ?? null
    },
    async recall(input) {
      const result = await runRecall(input)
      // F-01：向量路查询异常已由内核降级（关键词路照常），这里把原因记一次 warn——
      // 配置态降级（本来就没有查询向量）不重复告警，它由 embedding 配置告警覆盖。
      if (result.degraded && input.queryVector !== null) {
        ctx.logger.warn(
          `召回向量路查询失败，已降级为关键词单路：${result.vectorError ?? '未知原因'}`,
        )
      }
      return result
    },
  }

  /**
   * `/memory recall` 的 dep：手动召回**不计入** turn 配额（配额只在 memory_recall 工具面消耗）。
   * 降级语义与工具一致：embed 失败 → 关键词单路。
   */
  const recallMemories: RetrievalWiring['recallMemories'] = async (input) => {
    const queryVector = await recallStore.embedQuery(input.query)
    const core = await recallStore.recall({ query: input.query, queryVector, limit: input.limit })
    // F-07：total（截断前命中数）必须透传到命令面，否则「共 N 条」只会报显示条数。
    return { total: core.total, results: core.results, degraded: core.degraded, hint: core.hint }
  }

  /**
   * Story 3.2：关联遍历能力（命令面 + B4 的工具面共用同一 store）。
   * `traverse` 直接转发 `db/edges.ts` 的 `traverseRelated`；超时预算取工具面同一常量。
   */
  const relatedStore: MemoryRelatedStore = {
    traverse: (input) => traverseRelated(readConnection().connection, {
      id: input.id,
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      timeoutMs: input.timeoutMs ?? RELATED_TRAVERSAL_TIMEOUT_MS,
    }),
  }

  /**
   * `/memory related` 的 dep：手动遍历**不计入** turn 配额（与 recall 同口径）。
   * D4/D5 判定、hint 与 256-token 截断统一走 `tools/related-shared.ts`（F-05：与工具面同口径，
   * 命令面**不**引入 depth=1 重试——spec D8 有意为之，超时由 handler 收敛为 error 结果）。
   */
  const relatedMemories: RetrievalWiring['relatedMemories'] = async (input) => {
    const result = await relatedStore.traverse({
      id: input.id,
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      timeoutMs: RELATED_TRAVERSAL_TIMEOUT_MS,
    })
    return toRelatedSuccessView(result)
  }

  const quota = createRecallTurnQuota()

  return {
    recallStore,
    relatedStore,
    quota,
    recallMemories,
    relatedMemories,
    // `turn/start` 与 `turn/end` 双点重置；监听必须在只读早退**之前**注册——
    // 只读实例同样提供 memory_recall。裸 ctx（单测）没有 `on` 时降级为不监听。
    wireQuotaReset: () => {
      ;(ctx as unknown as SessionEventHost).on?.('session/event', createQuotaResetListener(quota))
    },
  }
}

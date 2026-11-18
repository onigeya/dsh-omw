/**
 * 召回域装配（Story 3.1 / 3.2、F-01/F-02/F-05/F-07/F-09；Story 9.3 / T6 处境链路）。
 *
 * 一个 `retrieval` 单元同时服务命令面（`/memory recall|related`，不计配额）与工具面
 * （`memory_recall` / `memory_related`，共享同一个 turn 配额实例）。所有依赖惰性读库句柄：
 * 注册发生在建库之前，库未就绪时命令层收敛为 error、工具面返回 `db_unavailable`。
 *
 * Story 9.3 只给 `memory_recall` 工具加新链路（`recallSituated`）：命令面、注入面与
 * `memory_related` 一律继续走 v1，AD-8 的注入预算与 v1 默认召回不受影响。新链路的所有
 * 依赖（LLM / reranker / System One / 指标 / 账本）都在这里装配，开关关闭时不构造网络客户端。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCommandDependencies, MemorySituatedRecallView } from '../command.js'
import type { RuntimeConfig } from '../config.js'
import { createSystemOneClient, type SystemOneClient } from '../distill/system-one.js'
import { routeFromSession } from '../distill/session-route.js'
import type { MemoryDatabase } from '../db/database.js'
import { traverseRelated } from '../db/edges.js'
import { createEmbeddingClient, type EmbedClient } from '../embedding/client.js'
import { runRecallCore, type RecallCoreResult } from '../recall/core.js'
import type { RewriteLlmPort, RewriteRoute } from '../recall/query-rewrite.js'
import {
  createRerankerClient,
  type RerankerPort,
  type SystemOneRerankPort,
} from '../recall/rerank.js'
import { createSituatedRecall } from '../recall/situated-recall.js'
import { createSituatedRecallLedger } from '../recall/situated-ledger.js'
import { createSituatedMetrics } from '../recall/situated-metrics.js'
import type { MemoryRecallStore } from '../tools/memory-recall.js'
import { RELATED_TRAVERSAL_TIMEOUT_MS, type MemoryRelatedStore } from '../tools/memory-related.js'
import { createQuotaResetListener, createRecallTurnQuota, type RecallQuota } from '../tools/recall-quota.js'
import { toRelatedSuccessView } from '../tools/related-shared.js'
import type { SessionEventHost } from './host.js'

/**
 * 召回查询向量的超时预算（Story 3.1）：召回是软目标 ≤500ms，网络等待必须短：
 * 超时即降级为关键词单路（结果标 `degraded: true`，不静默）。
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
   * `ctx.on` 自动挂 disposer，故不新增 ctx.effect（entry-exports 钉死 closer 数）。
   */
  readonly wireQuotaReset: () => void
  /** Story 9.3 / T7：`/memory status` 的 `situated_recall:` 行数据源（进程内指标）。 */
  readonly situatedRecallView: () => MemorySituatedRecallView
}

export function createRetrievalWiring(options: RetrievalOptions): RetrievalWiring {
  const { ctx, getDb, readConnection, resolved } = options

  /**
   * 混合检索内核的调用点（命令面与工具面共用，不复制第二份参数装配）。
   * 库内 pin 的 embedding 模型 id 取 `db.modelId`，模型不符的节点不进向量路。
   */
  const runRecall = async (input: {
    readonly query: string
    readonly queryVector: readonly number[] | null
    readonly limit: number
    readonly layer?: string
    /** Story 9.3 / AD-16：内部候选池上限（处境链路用；v1 不传）。 */
    readonly poolLimit?: number
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
      ...(input.poolLimit === undefined ? {} : { poolLimit: input.poolLimit }),
      layer: input.layer ?? null,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }

  /**
   * recall 的 embedding 客户端，惰性构造（只读实例也构造：它不写向量，但召回需要查询
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

  const embedQuery = async (
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly number[] | null> => {
    const database = getDb()
    if (!database) return null
    // F-02 / AD-14：查询向量与节点向量必须同一模型。写者模式开库时会把库内 pin 改写成本次
    // 配置的模型（database.ts），只读模式不改写，此时若配置与 pin 不一致，用配置模型取
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
  }

  /* ----------------------------------------------------------------------- *
   * Story 9.3：处境条件化召回的装配（只在开关打开时构造网络客户端）。
   * ----------------------------------------------------------------------- */

  const situatedMetrics = createSituatedMetrics()
  const situatedLedger = createSituatedRecallLedger({
    connection: () => {
      const database = getDb()
      // 只读实例不开账本写入（不产生只读失败的噪音；召回结果不受影响）。
      return database === undefined || database.readonly ? null : database.connection
    },
    logger: ctx.logger,
  })
  /** 惰性 LLM 端口：apply 阶段不 eval `ctx.llm`（N2），调用期解引用；缺失时改写降级。 */
  const llmPort: RewriteLlmPort = {
    stream: (streamOptions) => (ctx as unknown as { llm: RewriteLlmPort }).llm.stream(streamOptions),
  }
  const configuredRoute: RewriteRoute | null =
    resolved.llmProvider && resolved.llmModel
      ? { provider: resolved.llmProvider, model: resolved.llmModel }
      : null
  const routeFor = (sessionId?: string): RewriteRoute | null => {
    if (configuredRoute !== null) return configuredRoute
    if (sessionId === undefined || sessionId === '') return null
    const sessions = (ctx as unknown as { sessions?: { get?: (id: string) => unknown } }).sessions
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    return routeFromSession(session)
  }

  const reranker: RerankerPort | null =
    resolved.situatedRecallEnabled && resolved.rerank !== undefined && resolved.rerank.endpoint !== ''
      ? createRerankerClient({
        endpoint: resolved.rerank.endpoint,
        model: resolved.rerank.model,
        timeoutMs: resolved.rerank.timeoutMs,
        ...(resolved.rerank.token === undefined ? {} : { token: resolved.rerank.token }),
      })
      : null

  let systemOneRerankClient: SystemOneClient | null = null
  const getSystemOneRerankPort = (): SystemOneRerankPort | null => {
    if (!resolved.situatedRecallEnabled || !resolved.systemOneRerankEnabled || !resolved.systemOne.enabled) {
      return null
    }
    if (systemOneRerankClient === null) {
      systemOneRerankClient = createSystemOneClient({
        endpoint: resolved.systemOne.endpoint,
        model: resolved.systemOne.model,
        token: resolved.systemOne.token,
      })
    }
    const client = systemOneRerankClient
    return {
      judge: (state, questions, signal) => client.judge(state, questions, signal),
    }
  }

  const situatedRecall = createSituatedRecall({
    embedQuery: (query, signal) => embedQuery(query, signal),
    recallLane: (input) => runRecall({
      query: input.query,
      queryVector: input.queryVector,
      limit: input.limit,
      ...(input.poolLimit === undefined ? {} : { poolLimit: input.poolLimit }),
      ...(input.layer === undefined ? {} : { layer: input.layer }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    llm: llmPort,
    routeFor,
    reranker,
    systemOne: getSystemOneRerankPort(),
    systemOneRerankEnabled: resolved.systemOneRerankEnabled,
    rerankTopN: resolved.rerank?.topN ?? 20,
    rerankTimeoutMs: resolved.rerank?.timeoutMs ?? 1_200,
    rrfK: resolved.rrfK,
    priorityWeight: resolved.priorityWeight,
  })

  const recallStore: MemoryRecallStore = {
    get embeddingEnabled() {
      return getDb() !== undefined && resolved.embeddingMode === 'enabled'
    },
    // Story 9.3：开关来自 Config（默认 false），关闭时工具完全走 v1 `recall`。
    get situatedRecallEnabled() {
      return resolved.situatedRecallEnabled
    },
    embedQuery,
    async recall(input) {
      const result = await runRecall(input)
      // F-01：向量路查询异常已由内核降级（关键词路照常），这里把原因记一次 warn，
      // 配置态降级（本来就没有查询向量）不重复告警，它由 embedding 配置告警覆盖。
      if (result.degraded && input.queryVector !== null) {
        ctx.logger.warn(
          `召回向量路查询失败，已降级为关键词单路：${result.vectorError ?? '未知原因'}`,
        )
      }
      return result
    },
    async recallSituated(input) {
      const database = getDb()
      if (!database) throw new Error('记忆库未就绪（无 profile 归属或库句柄缺失），本次未检索')
      const outcome = await situatedRecall({
        query: input.query,
        limit: input.limit,
        ...(input.layer === undefined ? {} : { layer: input.layer }),
        descriptor: input.descriptor,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const { audit } = outcome
      situatedMetrics.record({
        latencyMs: audit.latencyMs,
        degraded: audit.degraded,
        overSoftTarget: audit.overSoftTarget,
        mode: audit.mode,
        ...(audit.degradedReason === undefined ? {} : { degradedReason: audit.degradedReason }),
      })
      // T7：描述符/改写结果只写封闭词表字段（账本内部再投影一次，fail-open）。
      await situatedLedger(audit)
      if (outcome.core.degraded) {
        ctx.logger.warn(`处境条件化召回降级（${audit.degradedReason ?? '未知原因'}），已按可用排序返回`)
      }
      return outcome.core
    },
  }

  const situatedRecallView = (): MemorySituatedRecallView => {
    const snapshot = situatedMetrics.snapshot()
    return {
      enabled: resolved.situatedRecallEnabled,
      degraded: snapshot.lastDegradedReason !== null,
      ...(snapshot.lastDegradedReason === null ? {} : { reason: snapshot.lastDegradedReason }),
      ...(snapshot.lastMode === null ? {} : { mode: snapshot.lastMode }),
      p50Ms: snapshot.p50Ms,
      p95Ms: snapshot.p95Ms,
      degradeRate: snapshot.degradeRate,
      slowRate: snapshot.slowRate,
      samples: snapshot.samples,
    }
  }

  /**
   * `/memory recall` 的 dep：手动召回不计入 turn 配额（配额只在 memory_recall 工具面消耗）。
   * 降级语义与工具一致：embed 失败 → 关键词单路。
   */
  const recallMemories: RetrievalWiring['recallMemories'] = async (input) => {
    const queryVector = await embedQuery(input.query)
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
   * `/memory related` 的 dep：手动遍历不计入 turn 配额（与 recall 同口径）。
   * D4/D5 判定、hint 与 256-token 截断统一走 `tools/related-shared.ts`（F-05：与工具面同口径，
   * 命令面不引入 depth=1 重试，spec D8 有意为之，超时由 handler 收敛为 error 结果）。
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
    situatedRecallView,
    // `turn/start` 与 `turn/end` 双点重置；监听必须在只读早退之前注册，
    // 只读实例同样提供 memory_recall。裸 ctx（单测）没有 `on` 时降级为不监听。
    wireQuotaReset: () => {
      ;(ctx as unknown as SessionEventHost).on?.('session/event', createQuotaResetListener(quota))
    },
  }
}

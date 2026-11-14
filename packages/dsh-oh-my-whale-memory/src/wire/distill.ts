/**
 * 精炼域装配（Story 2.3 / 2.4 / 2.5 / 2.6：R4①、U5、U1、X1）。
 *
 * 这里只构造**处理器与回填器**，不创建消费者、不注册任何 effect/定时器：
 * - embedding 客户端只在配置齐全时构造（FR-18 降级）；它的失败只记审计、不阻塞 L1 写入（N4）；
 * - 路由：Config 的 llmProvider/llmModel 优先，缺省从 session 的已记录请求目标解析（AC:567）；
 * - N2：apply 期间**不得求值** ctx.llm —— 用惰性端口，真正取用发生在消费轮次里；
 *   裸 ctx（单测）没有 llm/sessions 时也不会在 apply 阶段抛错；
 * - 回填挂消费者的 maintenance 钩子（空闲窗口），不新增 ctx.effect/定时器。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeConfig } from '../config.js'
import type { MemoryDatabase } from '../db/database.js'
import type { EmbeddingProfile } from '../db/embedding-profile.js'
import { createEmbeddingBackfill } from '../embedding/backfill.js'
import { createEmbeddingClient, type EmbedClient } from '../embedding/client.js'
import { createInboxProcessor } from '../distill/processor.js'
import { routeFromSession } from '../distill/session-route.js'
import type { LlmPort, RefineRoute } from '../distill/llm-refine.js'
import { createL2PromotionProcessor } from '../distill/promotion.js'
import { createSystemOneClient } from '../distill/system-one.js'
import { createEvidenceBackfill } from '../wiki/evidence-backfill.js'
import { createRelationRunner } from '../wiki/relations.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import type { MemoryRuntimeSlots } from './runtime.js'

/** 两个 L1/L2 处理器同形：`(item) => Promise<InboxProcessResult>`。 */
export type InboxProcessor = ReturnType<typeof createInboxProcessor>

export interface DistillWiringOptions {
  readonly ctx: Context
  readonly getDb: () => MemoryDatabase | undefined
  readonly resolved: RuntimeConfig
  /** 库级 pin 的 embedding 档案（dim + modelId）。 */
  readonly embedding: EmbeddingProfile
  readonly gate: IdleGate
  readonly slots: MemoryRuntimeSlots
}

export interface DistillWiring {
  readonly l1Processor: InboxProcessor
  readonly l2Processor: InboxProcessor
  /**
   * L1 消费者的维护钩子：向量回填（有客户端才跑）+ EVIDENCE 回填（恒跑）。
   * 评审 P18a（T19）：**串行**跑两个回填——两者都在事务外做裸 prepare/execute，
   * 并发会在同一条连接上交错（语句可能落进对方未结算的连接级事务）。
   */
  readonly maintenance: () => Promise<number>
}

export function createDistillWiring(options: DistillWiringOptions): DistillWiring {
  const { ctx, getDb, resolved, embedding, gate, slots } = options

  const embeddingClient: EmbedClient | null =
    resolved.embeddingMode === 'enabled' && resolved.embedding.endpoint
      ? createEmbeddingClient({
        endpoint: resolved.embedding.endpoint,
        token: resolved.embedding.token ?? '',
        dim: embedding.dim,
      })
      : null
  const llmPort: LlmPort = {
    stream: (streamOptions) => (ctx as unknown as { llm: LlmPort }).llm.stream(streamOptions),
  }
  const configuredRoute: RefineRoute | null =
    resolved.llmProvider && resolved.llmModel
      ? { provider: resolved.llmProvider, model: resolved.llmModel }
      : null
  // 回退链与解析规则在 distill/session-route.ts（纯函数，评审 T21 要求可单测）。
  const sessionRoute = (sessionId: string): RefineRoute | null => {
    const sessions = (ctx as unknown as {
      sessions?: { get?: (id: string) => unknown }
    }).sessions
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    return routeFromSession(session)
  }
  const resolveRoute = (sessionId: string): RefineRoute | null =>
    configuredRoute ?? sessionRoute(sessionId)

  // Story 2.6：关系维护跑者——在每个新 L1 节点上跑一次 KNN + 一次 ctx.llm 识别 + 应用层
  // 校验 + 写 RELATED 边。调用点在精炼事务之外（AC:779-782：关系失败不影响记忆进库）。
  // embedding 禁用 ⇒ 整体跳过 RELATED（记忆照常进库）并落一条 skip 审计供 status 可见。
  const relationRunner = createRelationRunner({
    connection: () => getDb()?.connection ?? null,
    llm: llmPort,
    embeddingEnabled: embeddingClient !== null,
    logger: ctx.logger,
  })

  const l1Processor: InboxProcessor = createInboxProcessor({
    connection: () => getDb()?.connection ?? null,
    llm: llmPort,
    relations: relationRunner,
    resolveRoute,
    embedding: embeddingClient,
    embeddingModel: resolved.embedding.model ?? null,
    embeddingModelId: embedding.modelId,
    logger: ctx.logger,
  })

  // Story 2.4 / U5：NULL 向量有界回填——只在 embedding 客户端存在时接线，挂消费者的
  // maintenance 钩子（空闲窗口、每轮 ≤50、不新增 ctx.effect/定时器；dispose 由既有 drain 覆盖）。
  const embeddingBackfill = embeddingClient
    ? createEmbeddingBackfill({
      connection: () => getDb()?.connection ?? null,
      gate,
      client: embeddingClient,
      model: resolved.embedding.model ?? '',
      modelId: embedding.modelId,
      logger: ctx.logger,
    })
    : null
  // Story 2.6 / X1：EVIDENCE 边历史回填（建表前的 L1/L2 没有边）——与向量回填共用同一个
  // maintenance 钩子与空闲闸门，不新增 ctx.effect/定时器。
  const evidenceBackfill = createEvidenceBackfill({
    connection: () => getDb()?.connection ?? null,
    gate,
    logger: ctx.logger,
  })

  // Story 2.5：System One 客户端只在配置开启时构造（评审 P3 后端点/模型/凭据都可经 Config
  // 覆盖，缺省仍是 AD-15 的模块常量）；配置关闭时就整体回落 ctx.llm 单次检查（AC:674）。
  // 只读实例不构造客户端（保持 null ⇒ 状态按配置渲染）。
  slots.systemOneClient = resolved.systemOne.enabled
    ? createSystemOneClient({
      endpoint: resolved.systemOne.endpoint,
      model: resolved.systemOne.model,
      token: resolved.systemOne.token,
    })
    : null

  // Story 2.5：L1→L2 提升的第二条消费链的处理器。
  const l2Processor: InboxProcessor = createL2PromotionProcessor({
    connection: () => getDb()?.connection ?? null,
    llm: llmPort,
    resolveRoute,
    systemOne: slots.systemOneClient,
    embedding: embeddingClient,
    embeddingModel: resolved.embedding.model ?? null,
    embeddingModelId: embedding.modelId,
    logger: ctx.logger,
  })

  return {
    l1Processor,
    l2Processor,
    maintenance: async () => {
      const embedded = embeddingBackfill ? await embeddingBackfill.runOnce() : 0
      const evidenced = await evidenceBackfill.runOnce()
      return embedded + evidenced
    },
  }
}

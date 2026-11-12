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
import {
  REFINE_INBOX_ACTION,
  REFINE_KIND,
  WRITE_EVIDENCE_ACTION,
  WRITE_EVIDENCE_SKIPPED_ACTION,
  insertGenerationLog,
  type GenerationLogOutcome,
} from '../db/audit.js'
import { memoryNodeId } from '../db/id.js'
import { SemanticScanError, writeDeduplicatedMemory } from '../db/dedup.js'
import { L0_LAYER, writeEvidenceEdges } from '../db/edges.js'
import { getMemoryById } from '../db/memory.js'
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
import type { RelationRunner } from '../wiki/relations.js'

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

/**
 * 语义去重扫描失败、本次改为「只走指纹路径」写入的降级理由（评审补钉 P20）。
 *
 * 背景：LadybugDB 0.22.3 里事务内任一语句报错即**中止整个事务**（后续语句被静默丢弃），
 * 所以「在事务里吞掉 ANN 失败继续写」是假降级——写入全丢、COMMIT 还会抛
 * 'No active transaction for COMMIT.'。正确做法是让首次尝试干净回滚（scanFailure: 'throw'），
 * 再跳过语义去重把整段重写一遍；降级事实必须留痕（AD-21）。
 */
export const SEMANTIC_SCAN_DEGRADED_REASON = 'semantic-scan-degraded'

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
  /** 测试接缝：LLM 子预算（评审 P11/P18），缺省 INBOX_LLM_TIMEOUT_MS。 */
  readonly llmTimeoutMs?: number
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
  /**
   * 关系识别跑者（Story 2.6 / FR-17）。在 L1 事务**提交之后**调用：LLM 不可用 / 超时 /
   * embedding 缺失都只跳过关系写入，**记忆照常进库**（AC:779-782）。不传即完全不跑关系。
   */
  readonly relations?: RelationRunner | null
}

export interface EmbedFactsResult {
  readonly vectors: readonly (readonly number[] | null)[]
  readonly failure: { readonly reason: string; readonly message: string } | null
}

/**
 * 写时嵌入的通用实现（N4 / AC:589 / Story 2.5 AC:755）：写库事务**之前**取向量。
 * 任一批次失败都不阻塞节点写入，只把该批记成无向量（三列留空），并把失败摘要交给审计行。
 * L1（本文件）与 L2（distill/promotion.ts）共用——两处的分批与失败语义必须一致。
 */
export async function embedTexts(
  client: EmbedClient | null | undefined,
  model: string | null | undefined,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<EmbedFactsResult> {
  const vectors: (readonly number[] | null)[] = texts.map(() => null)
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

/**
 * 入口守卫判据：pending（直接调用/未 claim）与 processing（消费者已 claim）都继续；其余一律短路。
 * 导出给 Story 2.5 的 L2 提升处理器复用（同一套「只有待处理条目才值得干活」纪律）。
 */
export function isProcessableStatus(status: InboxStatus | null): boolean {
  return status === INBOX_STATUS_PENDING || status === INBOX_STATUS_PROCESSING
}

/**
 * 写一行 refine 审计（N9）。**不开事务**：事务边界由调用方决定——失败路径另开事务写，
 * 成功路径与产出同事务写。四处记账的字段原本逐字重复，这里收敛为唯一实现。
 */
function insertRefineAudit(
  connection: lbug.Connection,
  itemId: string,
  outcome: GenerationLogOutcome,
  reason: string | null,
  now: () => Date,
  /**
   * action 缺省 refine_inbox。**降级可见性**（P16/T18）要把某些行落到独立 action 上——
   * countRelatedSkips（/memory status 的降级计数）按 action 白名单统计，只改 reason 文本
   * 是统计不到的（曾经就是这样：reason 前缀写了 write_evidence_skipped，action 仍是 refine_inbox）。
   */
  action: string = REFINE_INBOX_ACTION,
): Promise<string> {
  return insertGenerationLog(connection, {
    recordedAt: now().toISOString(),
    actor: 'system',
    kind: REFINE_KIND,
    action,
    outcome,
    reason,
    l0Refs: [itemId],
  })
}

/** 失败审计行：必须**另开事务**写（调用方的事务已回滚），否则随回滚一起消失（N9）。 */
async function recordRefineFailure(
  connection: lbug.Connection,
  item: InboxItem,
  failure: RefineFailure,
  now: () => Date,
): Promise<void> {
  await runInTransaction(connection, () =>
    insertRefineAudit(connection, item.id, failure.retryable ? 'uncertain' : 'failure', failure.reason, now),
  )
}

/**
 * 组装 2.3 的精炼处理器：交给 `createInboxConsumer({ process })` 注入（R4）。
 * 返回的处理器已完成全部队列记账（标 done / 抛错交给消费者记失败），调用方无需再包装。
 */
export function createInboxProcessor(deps: InboxProcessorDeps): (item: InboxItem) => Promise<InboxProcessResult> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? INBOX_PROCESS_TIMEOUT_MS
  const llmTimeoutMs = deps.llmTimeoutMs ?? INBOX_LLM_TIMEOUT_MS

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
    const llmSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, llmTimeoutMs))])
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
    const embedded = await embedTexts(
      deps.embedding,
      deps.embeddingModel,
      refined.facts.map((fact) => fact.text),
      signal,
    )
    if (embedded.failure) {
      deps.logger?.warn(
        'INBOX 写时嵌入失败（id=' + item.id + '，reason=' + embedded.failure.reason + '）：' +
        embedded.failure.message + '——L1 照常写入，embedding 两列留空',
      )
    }

    // ④ 单事务：条件转 done → 经**去重原语**写 L1（Story 2.4：指纹/语义/版本三路）
    //    → 按 source_refs 建 EVIDENCE 边（Story 2.6 / AD-10：精炼结构是 EVIDENCE 唯一写者）
    //    → 写 outcome 审计行（R1 / N9）。
    // item.id 就是 l0_raw 行 id（2.3 P1 已把 L0 与 INBOX 统一成同一身份），故它的层是 L0，
    // 与刚写的 L1 节点构成 l0_raw→memory 的 EVIDENCE 边（2.5 判据②的链头）。
    let marked = false
    // 事务外仍需这份清单（关系识别在事务提交后跑），故声明在闭包之外。
    // writtenL1Ids = 本次**每个**产出节点 id（含指纹合并 / 语义合并 / 版本作废命中既有节点）：
    //   它们都新增了 source_refs，需要物化成 EVIDENCE 边（X1 语义）。建边只用到 id。
    // relationEntries = **只含新节点**（outcome === 'created' | 'version-invalidated'）：
    //   评审 P2（T2）——关系是一次性决定（AC4）。合并命中既有节点时它早已跑过关系识别，
    //   再跑一次会突破「每条新记忆 ≤5 条 RELATED」并产生噪声边。
    const writtenL1Ids: string[] = []
    const relationEntries: { readonly id: string, readonly text: string, readonly kind: string, readonly vector: readonly number[] | null }[] = []
    // 评审补钉 P20：若本轮因语义扫描失败而退化成「只走指纹」，在**成功那次事务内**留一条痕迹。
    let scanDegraded: string | null = null

    /**
     * 一次完整的写入事务（可整体重跑）。
     *
     * `skipSemanticScan=true` 用于「上一轮扫描把事务搞中止」后的降级重试：
     * LadybugDB 0.22.3 中事务内任一语句报错即中止整个事务（COMMIT 抛 'No active transaction
     * for COMMIT.'），因此那一次尝试的写入全部作废、必须整体重来；只有换一条不碰 ANN 的路径
     * 才能真正把数据写进去，同时靠这次成功提交让失效的向量索引自愈。
     */
    const writeL1 = async (skipSemanticScan: boolean): Promise<void> => {
      // 重跑前把闭包状态复位（首轮失败时可能已推进到一半）。
      marked = false
      writtenL1Ids.length = 0
      relationEntries.length = 0
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
          const result = await writeDeduplicatedMemory(
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
            { now, logger: deps.logger, scanFailure: 'throw', skipSemanticScan },
          )
          writtenL1Ids.push(result.id)
          if (result.outcome === 'created' || result.outcome === 'version-invalidated') {
            relationEntries.push({ id: result.id, text: fact.text, kind: existing ? existing.kind : fact.kind, vector })
          }
        }
        // EVIDENCE 结构写者：为本次新写/命中的每个 L1 节点建 l0_raw→memory 边（MERGE 幂等）。
        // 层序由 writeEvidenceEdges 内判：item.id 属 L0、to 属 L1，低→高成立。
        const edgeResult = await writeEvidenceEdges(
          connection,
          writtenL1Ids.map((id) => ({
            fromId: item.id,
            fromLayer: L0_LAYER,
            toId: id,
            toLayer: MEMORY_REMEMBER_LAYER,
            reason: 'refine',
          })),
        )
        await insertRefineAudit(connection, item.id, 'success', null, now)
        if (edgeResult.skipped.length > 0) {
          // 评审 P16（T18）：落**独立 action**（不是 refine_inbox 的 reason 文本）——
          // countRelatedSkips 按 action 白名单计数，只改 reason 统计不到（AD-21 降级必须可见）。
          await insertRefineAudit(
            connection,
            item.id,
            'uncertain',
            'skipped=' + String(edgeResult.skipped.length),
            now,
            WRITE_EVIDENCE_SKIPPED_ACTION,
          )
        }
        if (embedded.failure) {
          await insertRefineAudit(
            connection,
            item.id,
            'uncertain',
            EMBEDDING_FAILED_REASON + ': ' + embedded.failure.reason,
            now,
          )
        }
        if (refined.facts.some((fact) => fact.coerced)) {
          await insertRefineAudit(connection, item.id, 'uncertain', COERCED_CLASSIFICATION_REASON, now)
        }
        if (scanDegraded !== null) {
          await insertRefineAudit(
            connection,
            item.id,
            'uncertain',
            SEMANTIC_SCAN_DEGRADED_REASON + ': ' + scanDegraded,
            now,
          )
        }
      })
    }

    try {
      await writeL1(false)
    } catch (error) {
      if (!(error instanceof SemanticScanError)) throw error
      // 语义去重不可用（索引失效/扩展未装载）：首轮已整体回滚，这里换一条不碰 ANN 的路重跑。
      scanDegraded = error.message
      deps.logger?.warn(
        'INBOX 语义去重降级为指纹路径（id=' + item.id + '）：' + error.message,
      )
      await writeL1(true)
    }

    // marked=false：条目已被处理过（R1 的 at-most-once 命中），本次不写任何产出。
    if (!marked) return { completed: true, kinds: [] }

    // ⑤ 关系识别（Story 2.6 / FR-17）：在 L1 事务之外 best-effort 执行——AC:779-782 明确
    // 「LLM 不可用或关系识别超时 ⇒ 跳过关系写入、记忆仍进库」。复用写时已算的 embedding，
    // 不重算、不新增 ctx.effect；跟随精炼任务的总预算 signal。
    if (deps.relations) {
      try {
        await deps.relations({
          itemId: item.id,
          route,
          entries: relationEntries.map((node) => ({
            id: node.id,
            layer: MEMORY_REMEMBER_LAYER,
            kind: node.kind,
            text: node.text,
            embedding: node.vector,
          })),
          now: now().toISOString(),
          signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.logger?.warn('关系识别跑者异常（id=' + item.id + '）：' + message + '——记忆已入库，关系跳过')
      }
    }
    return { completed: true, kinds: refined.facts.map((fact) => fact.kind) }
  }
}

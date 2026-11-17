/**
 * 摘要重写消费者（Story 8.4 / T6、FR-29、INV-13、矩阵行 10–12）。
 *
 * 触发：`memory_expand` 让某个句柄的 `expand_count` / `chain_depth` 达到阈值（T5 入队
 * `kind='summary-rewrite'` 的 L1 INBOX 条目）。本处理器消费它：
 * - **成功**：append 新版本节点（新 id = 新摘要正文的指纹，`parent_id` 指向旧版本），
 *   再把旧版本置 `invalid_at`——**不原地改写**任何历史文本（INV-13）；
 * - **失败**（LLM 5xx/空输出/解析失败）：保留旧摘要不动，条目回 pending 走退避（矩阵行 11）；
 * - **连续两轮失败**：进死信并 `warn`，不再重试（矩阵行 12：防无限重写）；
 * - **链深已到阈值**：即使又收到条目也不再重写（否则每次重写都 +1，永远追不上），
 *   标记完成并 `warn`（同一条「停止」纪律的可观测形式）。
 *
 * 「复用 FR-5 精炼管线」= 复用同一条 INBOX 队列/消费者/退避/审计与同一个 LLM 调用层
 * （`rewriteSummaryText` 与 `refineTranscript` 共用 `foldStream` 与失败分类），不新造一条管线。
 */
import type * as lbug from '@ladybugdb/core'
import {
  REFINE_KIND,
  auditWriter,
} from '../db/audit.js'
import { memoryNodeId } from '../db/id.js'
import { writeMemoryVersion } from '../db/memory.js'
import { queryRows } from '../db/rows.js'
import { MEMORY_TABLE } from '../db/schema.js'
import { runInTransaction } from '../db/transaction.js'
import {
  parseHandleRewritePayload,
  type HandleRewritePayload,
} from '../context/handle-stats.js'
import { HANDLE_KIND, readHandle, type HandleRecord } from '../context/handles.js'
import { InboxRefineError, type InboxProcessResult } from '../inbox/consumer.js'
import {
  markInboxItemDone,
  readInboxItemStatus,
  type InboxItem,
} from '../inbox/queue.js'
import { MEMORY_REMEMBER_LAYER } from '../shared/memory-vocab.js'
import {
  rewriteSummaryText,
  type LlmPort,
  type RefineFailure,
  type RefineRoute,
} from './llm-refine.js'
import { isProcessableStatus } from './processor.js'

/** 连续失败上限：第 2 次失败即停止并告警（AC:1811-1813 的「两轮」）。 */
export const MAX_SUMMARY_REWRITE_ATTEMPTS = 2

/** 单次重写尝试的硬上界（与 L1 精炼的 LLM 子预算同量级）。 */
export const SUMMARY_REWRITE_TIMEOUT_MS = 20_000

/** 审计 action（`/memory status` 与账本都能按它统计）。 */
export const SUMMARY_REWRITE_APPLIED_ACTION = 'summary_rewrite_applied'
export const SUMMARY_REWRITE_FAILED_ACTION = 'summary_rewrite_failed'
export const SUMMARY_REWRITE_STOPPED_ACTION = 'summary_rewrite_stopped'

export interface SummaryRewriteDeps {
  readonly connection: () => lbug.Connection | null
  readonly llm: LlmPort
  readonly resolveRoute: (sessionId: string) => RefineRoute | null
  /** Config 的 `chainDepthThreshold`：新版本链深达到它就不再重写（防无限追链）。 */
  readonly chainDepthThreshold: number
  /** 与 `memory_expand` 条目里的 `chain_depth` 比对用；缺省从节点列读。 */
  readonly timeoutMs?: number
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
}

const INVALIDATE_OLD = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'WHERE m.invalid_at IS NULL',
  'SET m.invalid_at = $invalid_at',
  'RETURN m.id AS id',
].join('\n')

/** 新版本的链深单调不减（同文本命中既有节点时不把已有深链改浅）。 */
const BUMP_CHAIN_DEPTH = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'SET m.chain_depth = CASE WHEN m.chain_depth IS NULL OR m.chain_depth < $depth THEN $depth ELSE m.chain_depth END',
  'RETURN m.id AS id',
].join('\n')

/** 失败审计行：必须在事务回滚之后另开事务写（与 L1 精炼同一纪律）。 */
async function recordRewriteFailure(
  connection: lbug.Connection,
  item: InboxItem,
  failure: RefineFailure,
  now: () => Date,
): Promise<void> {
  await runInTransaction(connection, () =>
    auditWriter(connection, {
      recordedAt: now().toISOString(),
      actor: 'system',
      kind: REFINE_KIND,
      l0Refs: [item.id],
    })({
      action: SUMMARY_REWRITE_FAILED_ACTION,
      outcome: failure.retryable ? 'uncertain' : 'failure',
      reason: failure.reason,
    }),
  )
}

export interface SummaryRewriteOutcome {
  readonly rewritten: boolean
  readonly oldHandleId: string
  readonly newVersionId: string | null
}

/**
 * 组装「摘要重写」处理器（形状与 `createInboxProcessor` 一致，交给消费链路由）。
 *
 * 返回值实现 `completed: true`（在自身事务里把条目转 done），因此消费者不会再 complete。
 */
export function createSummaryRewriteProcessor(
  deps: SummaryRewriteDeps,
): (item: InboxItem) => Promise<InboxProcessResult> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? SUMMARY_REWRITE_TIMEOUT_MS

  return async (item: InboxItem): Promise<InboxProcessResult> => {
    const connection = deps.connection()
    if (!connection) throw new Error('摘要重写时数据库连接不可用（id=' + item.id + '）')

    // ⓪ 入口状态守卫（与 L1 精炼同一纪律）：只有还「待处理」的条目才值得跑。
    const status = await readInboxItemStatus(connection, item.id)
    if (!isProcessableStatus(status)) return { completed: true, kinds: [] }

    // ① 载荷必须合法：非法载荷重试也不会好 ⇒ 直接进死信（fatal）。
    const payload: HandleRewritePayload | null = parseHandleRewritePayload(item.payload)
    if (payload === null) {
      throw new InboxRefineError('摘要重写条目载荷非法（缺 rewrite 标记 / handleId）', {
        reason: 'summary_rewrite_payload_invalid',
        fatal: true,
      })
    }

    // ② 句柄必须还在：不存在 ⇒ 没有可重写的内容，重试无意义（fatal）。
    const handle: HandleRecord | null = await readHandle(connection, payload.handleId)
    if (handle === null) {
      throw new InboxRefineError('摘要重写目标句柄不存在（id=' + payload.handleId + '）', {
        reason: 'summary_rewrite_handle_missing',
        fatal: true,
      })
    }

    // ③ 链深护栏：再重写只会让链更深，直接停止并留账（矩阵行 12 的「停止」语义）。
    if (handle.chainDepth >= deps.chainDepthThreshold) {
      deps.logger?.warn(
        '摘要重写停止：句柄 ' + handle.id + ' 的 chain_depth=' + String(handle.chainDepth) +
        ' 已达阈值 ' + String(deps.chainDepthThreshold) + '（不再继续改写，防无限重写）',
      )
      await runInTransaction(connection, async () => {
        const marked = await markInboxItemDone(connection, item.id, { now: now() })
        if (!marked) return
        await auditWriter(connection, {
          recordedAt: now().toISOString(),
          actor: 'system',
          kind: REFINE_KIND,
          l0Refs: [item.id],
        })({
          action: SUMMARY_REWRITE_STOPPED_ACTION,
          outcome: 'uncertain',
          reason: 'chain-depth=' + String(handle.chainDepth) + ' threshold=' + String(deps.chainDepthThreshold),
        })
      })
      return { completed: true, kinds: [] }
    }

    // ④ 路由解析（与 L1 精炼同一闸门）：解析不到 ⇒ 可重试失败，不调 LLM。
    const route = deps.resolveRoute(item.sessionId)
    if (!route) {
      const failure: RefineFailure = {
        reason: 'no-provider-route',
        message: '未解析到可用的 provider/model 路由（session=' + item.sessionId + '）',
        retryable: true,
      }
      await recordRewriteFailure(connection, item, failure, now)
      throw failOrStop(item, failure, deps.logger)
    }

    // ⑤ 一次尝试 = 一次 ctx.llm.stream；失败保留旧摘要（矩阵行 11）。
    const signal = AbortSignal.timeout(timeoutMs)
    const rewritten = await rewriteSummaryText({ llm: deps.llm, route, text: handle.text, signal })
    if (!rewritten.ok) {
      await recordRewriteFailure(connection, item, rewritten.failure, now)
      throw failOrStop(item, rewritten.failure, deps.logger)
    }

    // ⑥ 单事务：标 done → append 新版本 → 旧版本置 invalid_at（INV-13）。
    const newDepth = handle.chainDepth + 1
    const newId = memoryNodeId(MEMORY_REMEMBER_LAYER, rewritten.summary)
    if (newId === handle.id) {
      // 模型把原文原样还回来（或只差归一化空白）：没有新版本可 append，保留旧摘要并留账。
      await runInTransaction(connection, async () => {
        const marked = await markInboxItemDone(connection, item.id, { now: now() })
        if (!marked) return
        await auditWriter(connection, {
          recordedAt: now().toISOString(),
          actor: 'system',
          kind: REFINE_KIND,
          l0Refs: [item.id],
        })({
          action: SUMMARY_REWRITE_STOPPED_ACTION,
          outcome: 'uncertain',
          reason: 'same-version-text',
        })
      })
      deps.logger?.warn('摘要重写停止：模型产出的摘要与旧版本同指纹（不原地改写，INV-13）')
      return { completed: true, kinds: [] }
    }

    let marked = false
    await runInTransaction(connection, async () => {
      marked = await markInboxItemDone(connection, item.id, { now: now() })
      if (!marked) return
      const at = now().toISOString()
      const written = await writeMemoryVersion(connection, {
        layer: MEMORY_REMEMBER_LAYER,
        text: rewritten.summary,
        kind: HANDLE_KIND,
        priority: 0,
        validAt: at,
        recordedAt: at,
        // 溯源到旧版本（重写链的上一环）：`rewrite:` 前缀与 T5 的幂等键同一词表。
        sourceRefs: ['rewrite:' + handle.id, 'session:' + item.sessionId],
        parentId: handle.id,
        actor: 'system',
      }, { now })
      await queryRows(connection, BUMP_CHAIN_DEPTH, { id: written.id, depth: newDepth })
      // 旧版本只在**新版本写成功之后**失效：写失败时旧摘要仍是当前快照（INV-13 的失败侧）。
      await queryRows(connection, INVALIDATE_OLD, { id: handle.id, invalid_at: at })
      await auditWriter(connection, {
        recordedAt: at,
        actor: 'system',
        kind: REFINE_KIND,
        l0Refs: [item.id],
      })({
        action: SUMMARY_REWRITE_APPLIED_ACTION,
        outcome: 'success',
        reason: 'old=' + handle.id + ' new=' + written.id + ' chain-depth=' + String(newDepth),
      })
    })
    if (!marked) return { completed: true, kinds: [] }
    // 不记 L1 提升信号：重写产出的是摘要版本（kind='handle'），不是可提升的原子事实；
    // 句柄本来也不经 INBOX 计数（8.3 起由压缩引擎直接写），这里保持同一口径。
    return { completed: true, kinds: [] }
  }
}

/**
 * 失败升级：连续 `MAX_SUMMARY_REWRITE_ATTEMPTS` 次失败 ⇒ 致命（进死信、停止重试）+ warn；
 * 否则可重试（回 pending 走退避）。`item.attempts` 是**本次失败前**已累计的次数。
 */
function failOrStop(
  item: InboxItem,
  failure: RefineFailure,
  logger?: { warn(message: string): void },
): InboxRefineError {
  const nextAttempt = item.attempts + 1
  const stop = !failure.retryable || nextAttempt >= MAX_SUMMARY_REWRITE_ATTEMPTS
  if (stop) {
    logger?.warn(
      '摘要重写停止（第 ' + String(nextAttempt) + ' 次失败）：' + failure.reason +
      '——保留旧摘要，不再重试（防无限重写）',
    )
  }
  return new InboxRefineError('摘要重写失败（' + failure.reason + '）：' + failure.message, {
    reason: failure.reason,
    fatal: stop,
  })
}

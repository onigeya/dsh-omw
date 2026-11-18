/**
 * 处境条件化召回的审计账本（Story 9.3 / T7、矩阵 3、AD-21）。
 *
 * 一次 `memory_recall`（开关打开时）记一行 `generation_log`：
 * `kind='recall'`、`action='situated_recall'`，明细写既有 `detail` 列（不新增表 / 列）。
 *
 * 三条纪律：
 * 1. **只写封闭词表字段**（矩阵 3）：描述符只记 `goalPresent / goalChars / tools / files /
 *    errors / recentUserTurns` 计数与标识，**不记原始正文**（用户回合、改写文本、候选正文
 *    一律不落），也不记任何凭据（NFR9）；改写只记 lane 名与降级原因封闭值。
 * 2. **只读 / 未就绪只 warn 一次**：账本失败绝不改变召回结果（fail-open），也绝不重试。
 * 3. 写入方按实例构造（闭包持有 `connection` 取法），不落模块级全局状态——同进程第二次
 *    apply 不会覆盖第一实例的库句柄（与 System One 运行态槽同款教训）。
 */
import type * as lbug from '@ladybugdb/core'
import { insertGenerationLog } from '../db/audit.js'
import type { SituationDescriptor } from './situation.js'
import { situatedEvalLogDetail, SITUATED_EVAL_ACTION, SITUATED_EVAL_KIND, type SituatedEvalResult } from './situated-eval.js'

/** 账本行的 kind（审计动作语汇里的召回侧；不是写路径）。 */
export const SITUATED_RECALL_KIND = 'recall'
/** 账本行的 action。 */
export const SITUATED_RECALL_ACTION = 'situated_recall'

/** 一次处境条件化召回的审计素材（只含可进日志的投影来源，不含候选正文）。 */
export interface SituatedRecallAudit {
  readonly descriptor: SituationDescriptor | null
  readonly rewrite: {
    readonly lanes: readonly string[]
    readonly degraded: boolean
    readonly reason?: string
  }
  /** 重排模式（`RerankMode` 或 `fallback-v1`）；封闭词表。 */
  readonly mode: string
  readonly degraded: boolean
  readonly degradedReason?: string
  readonly latencyMs: number
  readonly overSoftTarget: boolean
  readonly counts: {
    readonly original: number
    readonly rewritten: number
    readonly merged: number
    readonly pinned: number
  }
}

/** 描述符的日志投影（矩阵 3：只留封闭词表字段与计数，不落 goal 原文）。 */
function descriptorLogProjection(descriptor: SituationDescriptor | null): unknown {
  if (descriptor === null) return null
  return {
    goalPresent: descriptor.goal.length > 0,
    goalChars: Array.from(descriptor.goal).length,
    tools: [...descriptor.tools],
    files: [...descriptor.files],
    errors: [...descriptor.errors],
    recentUserTurns: descriptor.recentUserTurns.length,
  }
}

/** `generation_log.detail`（JSON 串）：字段集封闭，不含原文/凭据（矩阵 3 / NFR9）。 */
export function buildSituatedRecallDetail(audit: SituatedRecallAudit): string {
  return JSON.stringify({
    descriptor: descriptorLogProjection(audit.descriptor),
    rewrite: {
      lanes: [...audit.rewrite.lanes],
      degraded: audit.rewrite.degraded,
      ...(audit.rewrite.reason === undefined ? {} : { reason: audit.rewrite.reason }),
    },
    mode: audit.mode,
    degraded: audit.degraded,
    ...(audit.degradedReason === undefined ? {} : { reason: audit.degradedReason }),
    latencyMs: Math.max(0, Math.round(audit.latencyMs)),
    overSoftTarget: audit.overSoftTarget,
    counts: {
      original: audit.counts.original,
      rewritten: audit.counts.rewritten,
      merged: audit.counts.merged,
      pinned: audit.counts.pinned,
    },
  })
}

/** 账本写入端口（生产实现写 `generation_log`；测试可注入假实现）。 */
export interface SituatedRecallLedgerOptions {
  readonly connection: () => lbug.Connection | null
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
}

/**
 * 构造一个实例级账本写入方（fail-open）：未就绪 / 只读 / 缺表 / 写失败都只 warn 一次。
 * 返回函数恒 resolve（不 throw），调用方不需要 `.catch()`。
 */
export function createSituatedRecallLedger(
  options: SituatedRecallLedgerOptions,
): (audit: SituatedRecallAudit) => Promise<boolean> {
  const now = options.now ?? (() => new Date())
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    options.logger?.warn(message)
  }
  return async (audit) => {
    const connection = options.connection()
    if (connection === null) {
      warnOnce('处境召回账本跳过：记忆库未就绪或只读（召回结果不受影响）')
      return false
    }
    try {
      await insertGenerationLog(connection, {
        recordedAt: now().toISOString(),
        actor: 'system',
        kind: SITUATED_RECALL_KIND,
        action: SITUATED_RECALL_ACTION,
        // 降级是「可感知但不算失败」的中间态：outcome 记 uncertain，不当 failure。
        outcome: audit.degraded ? 'uncertain' : 'success',
        reason: audit.degradedReason ?? null,
        detail: buildSituatedRecallDetail(audit),
      })
      return true
    } catch (error) {
      warnOnce(
        '处境召回账本写入失败（召回结果不受影响）：' +
        (error instanceof Error ? error.message : String(error)),
      )
      return false
    }
  }
}

/**
 * 写一条 A/B 评估记录（T8「评估记录写 generation_log/结论文档」）。
 * 明细由 {@link situatedEvalLogDetail} 给出（只含 id 与数值）。
 */
export async function recordSituatedEval(
  connection: lbug.Connection,
  result: SituatedEvalResult,
  options: { readonly now?: () => Date } = {},
): Promise<void> {
  const now = options.now ?? (() => new Date())
  await insertGenerationLog(connection, {
    recordedAt: now().toISOString(),
    actor: 'system',
    kind: SITUATED_EVAL_KIND,
    action: SITUATED_EVAL_ACTION,
    outcome: 'success',
    ...(result.lift === null ? { reason: result.reason ?? 'no-lift' } : {}),
    detail: situatedEvalLogDetail(result),
  })
}

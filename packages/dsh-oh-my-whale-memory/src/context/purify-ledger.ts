/**
 * 净化账本（Story 8.6 / T5、AC:1890-1892）。
 *
 * 每次**真的改动了文本**的净化记一行：`{sessionId, rangeStart, rangeEnd, ruleHits,
 * removedChars, removedTokens}` 落 `generation_log.detail`（JSON 串；列由迁移 0002 加过）。
 * 账本只记**分布事实**（命中了哪些规则、省了多少字符/tokens），不记任何原文/凭据（NFR9）。
 *
 * 三条纪律：
 * 1. **不新增表**：复用 `generation_log` 的既有 detail 列（AC 明确允许「detail JSON 或既有审计列」）；
 * 2. **缺表 / 只读只 warn**：账本失败绝不改变净化结果（fail-open，INV-3），也绝不重试；
 * 3. 写入方经模块级注册（压缩 provider 由宿主构造，拿不到 apply 的库句柄）；未注册时
 *    （只读实例 / 裸 ctx）记一次 warn 后静默。
 */
import type * as lbug from '@ladybugdb/core'
import { insertGenerationLog } from '../db/audit.js'
import type { PurifyRule } from './purify.js'

/** 账本行的 kind（AD-21 的写路径分类；净化是执行期动作，不产生记忆节点）。 */
export const PURIFY_LEDGER_KIND = 'purify'
/** 账本行的 action。 */
export const PURIFY_LEDGER_ACTION = 'purify_text'

/** 一行净化账本的明细形状（AC:1892 逐字要求这六个字段）。 */
export interface PurifyLedgerEntry {
  /** 会话 id（取不到时 ''，此时不记账：不可归属的行没有检索价值）。 */
  readonly sessionId: string
  /** 被净化文本区间的起始字符偏移（区间口径见调用方：消息级 pass 为 0）。 */
  readonly rangeStart: number
  /** 被净化文本区间的结束字符偏移（原文长度）。 */
  readonly rangeEnd: number
  /** 命中的规则（R1/R2/R3）。 */
  readonly ruleHits: readonly PurifyRule[]
  /** 少掉的字符数。 */
  readonly removedChars: number
  /** 少掉的 tokens（与判据同一估算口径）。 */
  readonly removedTokens: number
}

/** 账本写入端口（生产实现写 `generation_log`；测试可注入假实现）。 */
export type PurifyLedgerWriter = (entry: PurifyLedgerEntry) => Promise<unknown>

let writer: PurifyLedgerWriter | null = null
/** 未注册/写失败只 warn 一次：每步都刷屏的日志等于没有日志。 */
let warned = false

/** `apply` 注册账本写入方；`null` = 撤销（teardown / 只读实例）。 */
export function registerPurifyLedgerWriter(next: PurifyLedgerWriter | null): void {
  writer = next
  warned = false
}

/** 当前账本写入方（未注册 = null）。 */
export function getPurifyLedgerWriter(): PurifyLedgerWriter | null {
  return writer
}

/** 复位（teardown / 测试清理）。 */
export function resetPurifyLedgerWriter(): void {
  writer = null
  warned = false
}

export interface RecordPurifyOptions {
  readonly logger?: { warn(message: string): void }
}

/**
 * 记一行净化账本（fail-open）：未注册写入方 / 写失败 / 缺表 / 只读 —— 一律只 warn。
 * 返回是否写入成功（调用方不需要据此改行为，仅供测试断言）。
 */
export async function recordPurifyRun(
  entry: PurifyLedgerEntry,
  options: RecordPurifyOptions = {},
): Promise<boolean> {
  if (entry.sessionId === '') return false
  if (entry.removedChars <= 0 && entry.ruleHits.length === 0) return false
  const target = writer
  if (target === null) {
    warnOnce(options.logger, '净化账本跳过：无账本写入方（只读实例 / 库未就绪），净化结果不受影响')
    return false
  }
  try {
    await target(entry)
    return true
  } catch (error) {
    warnOnce(
      options.logger,
      '净化账本写入失败（不影响净化结果）：' + (error instanceof Error ? error.message : String(error)),
    )
    return false
  }
}

function warnOnce(logger: { warn(message: string): void } | undefined, message: string): void {
  if (warned) return
  warned = true
  logger?.warn(message)
}

/**
 * 生产写入方：一次净化一行 `generation_log`（`kind=purify`、`action=purify_text`）。
 * 明细的六个字段全进 `detail`；`reason` 只放规则名，便于按列快速筛（不含原文）。
 */
export function createPurifyLedgerWriter(options: {
  readonly connection: () => lbug.Connection | null
  readonly now?: () => Date
}): PurifyLedgerWriter {
  const now = options.now ?? (() => new Date())
  return async (entry) => {
    const connection = options.connection()
    if (connection === null) throw new Error('记忆库未就绪（缺表 / 只读）')
    await insertGenerationLog(connection, {
      recordedAt: now().toISOString(),
      actor: 'system',
      kind: PURIFY_LEDGER_KIND,
      action: PURIFY_LEDGER_ACTION,
      outcome: 'success',
      reason: entry.ruleHits.join(',') || null,
      detail: JSON.stringify({
        sessionId: entry.sessionId,
        rangeStart: entry.rangeStart,
        rangeEnd: entry.rangeEnd,
        ruleHits: [...entry.ruleHits],
        removedChars: entry.removedChars,
        removedTokens: entry.removedTokens,
      }),
    })
  }
}

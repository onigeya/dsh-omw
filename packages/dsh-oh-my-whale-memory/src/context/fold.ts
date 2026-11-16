/**
 * 折叠判定与执行（Story 8.2 / FR-23、AC:1607-1614、1624-1626、INV-3）。
 *
 * 范围：**接缝 (i)** —— 只折叠本插件自己工具结果里超预算的长文本。宿主级结果裁剪（接缝 (ii)
 * `ctx.toolResultPruner`）按 AC:1640-1642 等 spike-3 结案后再评估，本模块不碰。
 *
 * 三条纪律：
 * 1. **阈值内原样返回**（不做无谓折叠，句柄不是装饰）；
 * 2. **折叠成功后表面只剩句柄块**，全文入图（由调用方注入 `write`，通常是 `writeHandle`）；
 * 3. **fail-open**（INV-3）：写图失败时**返回原文**（不折叠、不删、不改），只记日志——
 *    宁可多花 token，也不让证据消失。
 */
import { formatHandleBlock } from './handle.js'

/** 折叠阈值（tokens）。默认 2000：与本仓的注入预算量级一致，避免长工具结果独占上下文。 */
export const DEFAULT_FOLD_THRESHOLD_TOKENS = 2000

export interface FoldOutcome {
  /** 实际返回给模型的表面文本（未折叠 = 原文）。 */
  readonly text: string
  readonly folded: boolean
  /** 折叠时的句柄 id；未折叠为 null。 */
  readonly handle: string | null
  /** 折叠失败的原因（fail-open 时为 `write-failed`）。 */
  readonly note: string | null
}

export interface FoldInput {
  readonly text: string
  readonly sessionId: string
  readonly seq: number
  readonly thresholdTokens: number
  /** 写入句柄（全文入图）；抛错即 fail-open。 */
  readonly write: (input: { readonly sessionId: string, readonly seq: number, readonly text: string, readonly tokens: number }) => Promise<{ readonly id: string }>
  readonly logger?: { warn(message: string): void }
}

/** 粗估 token：中英混排下 1 token ≈ 2 字符（不比宿主计量更权威，只用于「要不要折叠」的判定）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

/**
 * 折叠判定 + 执行。
 *
 * 注意：`seq` 由调用方给（同一工具结果的稳定标识）；幂等由 `write`（`writeHandle` 的
 * `(session, seq)` 先查后写）保证（INV-6），本模块不重复实现。
 */
export async function foldIfOversized(input: FoldInput): Promise<FoldOutcome> {
  const tokens = estimateTokens(input.text)
  const threshold = Number.isFinite(input.thresholdTokens) && input.thresholdTokens > 0
    ? Math.trunc(input.thresholdTokens)
    : DEFAULT_FOLD_THRESHOLD_TOKENS
  if (tokens <= threshold) {
    return { text: input.text, folded: false, handle: null, note: null }
  }
  try {
    const record = await input.write({
      sessionId: input.sessionId,
      seq: input.seq,
      text: input.text,
      tokens,
    })
    return {
      text: formatHandleBlock(record.id, tokens),
      folded: true,
      handle: record.id,
      note: null,
    }
  } catch (error) {
    // INV-3 fail-open：不折叠、不删、不改；把原文原样交回，只记日志。
    input.logger?.warn('工具结果折叠失败（fail-open，保留原文）：' + String(error))
    return { text: input.text, folded: false, handle: null, note: 'write-failed' }
  }
}

/**
 * readOnly 实例的折叠判定（INV-7）：只读实例**不执行折叠**（不写句柄、不写图、不写账本）。
 * 返回 `false` 的调用方应原样返回文本。
 */
export function shouldFoldInReadonly(readonly: boolean): boolean {
  return !readonly
}

/**
 * 工具结果的折叠入口（带 readOnly 判定）：只读实例**原样返回、不调用 write**（INV-7 可执行断言）。
 * 调用方（各工具）只需传 `readonly` 与 `write`，不必各自重复这条 if。
 */
export async function foldToolResult(
  input: FoldInput & { readonly readonly: boolean },
): Promise<FoldOutcome> {
  if (!shouldFoldInReadonly(input.readonly)) {
    return { text: input.text, folded: false, handle: null, note: 'readonly' }
  }
  return foldIfOversized(input)
}

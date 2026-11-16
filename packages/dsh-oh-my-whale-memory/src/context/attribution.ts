/**
 * 上下文归因账本（Story 8.1 / FR-22、INV-5、INV-9）。
 *
 * 目的：回答「每一轮究竟是谁在烧上下文」。输入是宿主 `ctx.tokenMeter.measure()` 的结果，输出是
 * 五类计数（系统提示 / 用户原话 / 工具结果 / 助手正文与推理 / 兜底 unknown）。
 *
 * 三条硬约束：
 * 1. **恒等于总量**：五类之和必须 === `measure.totalTokens`。缺口进 `unknown`，**不丢弃、不摊派**；
 * 2. **按 nodes 数组位置顺序遍历，不得按 seq 排序**（AC:1564）：数组是权威，seq 只是标签；
 * 3. **只认 measure()**：模型在正文里自称「已折叠」不构成状态（INV-9），本模块没有任何文本解析。
 *
 * 纯函数：不读时钟、不读库、不调宿主，因此可以直接单测边界。
 */

/** 归因来源四类 + 兜底（AC:1563）。 */
export type AttributionSource = 'system' | 'user' | 'tool' | 'assistant' | 'unknown'

export const ATTRIBUTION_SOURCES: readonly AttributionSource[] = [
  'system',
  'user',
  'tool',
  'assistant',
  'unknown',
]

/**
 * 宿主 `TokenSurfaceNode` 的最小形态（AD-26 引用的宿主契约）。
 * 刻意只声明本模块用到的字段：宿主多给字段不影响，少给/改名会在此显式失败。
 */
export interface TokenSurfaceNode {
  readonly seq: number
  /** 精确 token 数（宿主给出时优先）。 */
  readonly tokens?: number | null
  /** 启发式估算（`tokens` 缺失时兜底）。 */
  readonly heuristicTokens?: number | null
}

/** `measure()` 的最小形态。 */
export interface TokenMeasure {
  readonly totalTokens: number
  readonly nodes: readonly TokenSurfaceNode[]
}

/** seq → 来源索引（模块自建，宿主节点没有来源标签——spike-4 已结案）。 */
export type SeqSourceIndex = ReadonlyMap<number, AttributionSource>;

export interface AttributionLedger {
  readonly totalTokens: number
  /** 五类计数，key 恒为 `ATTRIBUTION_SOURCES` 的全部成员（缺省 0）。 */
  readonly bySource: Readonly<Record<AttributionSource, number>>
  /** 各类之和（应恒等于 `totalTokens`）。 */
  readonly attributedTokens: number
  /** 归因到 `unknown` 的节点数（用于 status 的「索引缺口」提示）。 */
  readonly unknownNodes: number
  /** 节点和超过 `totalTokens` 的溢出量（>0 说明宿主两个口径不一致，应告警）。 */
  readonly overflowTokens: number
}

/** 单个节点的计量：优先 `tokens`，否则 `heuristicTokens`，都缺失按 0（不猜）。 */
export function nodeTokens(node: TokenSurfaceNode): number {
  const exact = node.tokens
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) return exact
  const heuristic = node.heuristicTokens
  if (typeof heuristic === 'number' && Number.isFinite(heuristic) && heuristic >= 0) return heuristic
  return 0
}

/**
 * 归因主函数。
 *
 * 差额处理（`totalTokens` 与节点之和不等时）——**恒等式双向成立**（评审 R81 第 1 条）：
 * - 节点和 **<** total：差额计入 `unknown`（索引缺口，**不摊派**给四类）；
 * - 节点和 **>** total：按 `nodes` **数组顺序**计到总量为止，超出部分计入 `overflowTokens`
 *   （不静默丢弃、也不负调整四类）。宿主计量与节点和矛盾时以 `totalTokens` 为权威。
 * 两种情况下 `五类之和 === totalTokens` 都成立。
 */
export function attributeSurface(measure: TokenMeasure, seqIndex: SeqSourceIndex): AttributionLedger {
  const bySource: Record<AttributionSource, number> = { system: 0, user: 0, tool: 0, assistant: 0, unknown: 0 }
  let unknownNodes = 0
  const total = Number.isFinite(measure.totalTokens) && measure.totalTokens > 0 ? measure.totalTokens : 0
  // 计量预算：以 totalTokens 为权威，按数组顺序计到总量为止（评审 R81：节点和 > total 时不能放大总量）。
  let remaining = total
  let overflowTokens = 0
  // 按数组位置顺序遍历（AC:1564：不得按 seq 排序）。
  for (const node of measure.nodes) {
    const raw = nodeTokens(node)
    const tokens = Math.min(raw, remaining)
    overflowTokens += raw - tokens
    remaining -= tokens
    const source = seqIndex.get(node.seq)
    if (source === undefined) {
      bySource.unknown += tokens
      unknownNodes += 1
      continue
    }
    bySource[source] += tokens
  }
  let attributed = ATTRIBUTION_SOURCES.reduce((sum, source) => sum + bySource[source], 0)
  if (attributed < total) {
    // 未被任何节点覆盖的差额：属于「索引缺口」，计入 unknown（不摊派）。
    bySource.unknown += total - attributed
    attributed = total
  }
  return {
    totalTokens: total,
    bySource,
    attributedTokens: attributed,
    unknownNodes,
    overflowTokens,
  }
}

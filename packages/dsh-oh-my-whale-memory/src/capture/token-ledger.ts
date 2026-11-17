/**
 * token 触发账本（Story 10.1 / AC:2026、AD-36、NFR12）。
 *
 * **纯函数 + 可注入状态**：本模块只做「拿 measure 的 nodes 算增量 → 决定这次边界是否触发」，
 * 不读库、不读时钟。`lastSeq` 与累计量由调用方持久化到 `omw_meta`（每个会话两个键）。
 *
 * 三条口径（逐字来自 spec）：
 * 1. 增量 = `nodes` 中 `seq > lastSeq` 的 `tokens ?? heuristicTokens ?? 0` 之和；
 *    **禁用 `totalTokens` 差值**——compaction 会把总量压小，差值会长期不触发。
 * 2. `>= captureTokens` 触发；`< captureMinTokens` 累计到下次；中间带继续累计。
 * 3. 累计 `> captureMaxTokens` 仍触发，但标 `oversize`（按事件边界切片是 10.2 的 hydrate 侧；
 *    本 story 只保证单事件不被切碎、标记可见）。
 *
 * 为什么每边界都推进 `lastSeq`：不推进就会在下一边界把同一批 nodes 再算一遍（重复计 token）。
 * `pendingTokens` 承载「已计入但尚未触发」的量，触发/强制 flush 后清零。
 */

export interface TokenNodeLike {
  readonly seq: number
  readonly tokens?: number | null
  readonly heuristicTokens?: number | null
}

export interface TokenLedgerThresholds {
  /** 软阈值（tokens）：累计到它触发一次 INBOX。 */
  readonly captureTokens: number
  /** 最小累计（tokens）：低于它不触发，并入下次。 */
  readonly captureMinTokens: number
  /** 硬上限（tokens）：超过它仍触发，但标 `oversize`。 */
  readonly captureMaxTokens: number
}

export interface TokenLedgerState {
  /** 已计入过的最大 seq（-1 = 尚未计入任何节点）。 */
  readonly lastSeq: number
  /** 已计入但尚未触发的 token 累计。 */
  readonly pendingTokens: number
}

export const EMPTY_TOKEN_LEDGER: TokenLedgerState = { lastSeq: -1, pendingTokens: 0 }

/** 只统计 `seq > lastSeq` 的节点；非法 node 跳过（不抛错）。 */
export function sumNewTokens(
  nodes: readonly TokenNodeLike[],
  lastSeq: number,
): { readonly tokens: number, readonly maxSeq: number } {
  let tokens = 0
  let maxSeq = lastSeq
  for (const node of nodes) {
    const seq = node.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= lastSeq) continue
    const value = typeof node.tokens === 'number' && Number.isFinite(node.tokens)
      ? node.tokens
      : typeof node.heuristicTokens === 'number' && Number.isFinite(node.heuristicTokens)
        ? node.heuristicTokens
        : 0
    tokens += Math.max(0, Math.trunc(value))
    if (seq > maxSeq) maxSeq = seq
  }
  return { tokens, maxSeq }
}

export interface TriggerDecision {
  /** 触发后应持久化的状态（触发时 pending 清零；未触发时保留累计）。 */
  readonly state: TokenLedgerState
  /** 本次边界是否触发 INBOX。 */
  readonly triggered: boolean
  /** 触发原因是强制 flush（compaction/start），而非阈值。 */
  readonly forced: boolean
  /** 单次累计超过硬上限（审计/status 可见；不切碎单事件）。 */
  readonly oversize: boolean
}

/**
 * 计算一次边界的触发决策。
 *
 * @param state 上次持久化的账本状态。
 * @param nodes 宿主 `measure(session).nodes`（本模块只读 `seq` 与两种 token 字段）。
 * @param thresholds 三个阈值（来自 Config）。
 * @param options.forceFlush `true` = compaction/start 的强制 flush（无视阈值触发）。
 */
export function planTrigger(
  state: TokenLedgerState,
  nodes: readonly TokenNodeLike[],
  thresholds: TokenLedgerThresholds,
  options: { readonly forceFlush?: boolean } = {},
): TriggerDecision {
  const { tokens, maxSeq } = sumNewTokens(nodes, state.lastSeq)
  const total = state.pendingTokens + tokens
  const oversize = total > thresholds.captureMaxTokens

  if (options.forceFlush === true) {
    return {
      state: { lastSeq: maxSeq, pendingTokens: 0 },
      triggered: total > 0,
      forced: true,
      oversize,
    }
  }
  if (total >= thresholds.captureTokens) {
    return {
      state: { lastSeq: maxSeq, pendingTokens: 0 },
      triggered: true,
      forced: false,
      oversize,
    }
  }
  // 未达软阈值：计入累计，留到下次边界（含 < captureMinTokens 的情形）。
  return {
    state: { lastSeq: maxSeq, pendingTokens: total },
    triggered: false,
    forced: false,
    oversize: false,
  }
}

/** 一条待入队指针事件的 token 权重（`tokens` 缺失按 0 计）。 */
export interface PendingPointerEvent {
  readonly seq: number
  readonly eventType: string
  readonly tokens: number
}

/** 一次切片的结果：一个 INBOX 条目对应的连续事件段。 */
export interface PointerEventSlice {
  readonly events: readonly PendingPointerEvent[]
  /** 单事件自身超过硬上限（独立成单、不切碎；审计与 status 可见）。 */
  readonly oversize: boolean
}

/**
 * 按事件边界切片（Story 10.2 / AC：`> captureMaxTokens` 在事件边界切，单事件不切）。
 *
 * 贪心：顺序累加，加入下一条会超上限就先收束当前段；单事件自身超上限时**独立成单**并标
 * `oversize`，不吸收后续事件（否则「独立成单」就不成立）。权重缺失按 0 计，故没有 token
 * 信息时整批成一段（降级路径不做无法证明的切分）。
 */
export function slicePointerEvents(
  events: readonly PendingPointerEvent[],
  maxTokens: number,
): PointerEventSlice[] {
  if (events.length === 0) return []
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return [{ events: [...events], oversize: false }]
  }
  const slices: PointerEventSlice[] = []
  let current: PendingPointerEvent[] = []
  let currentTokens = 0
  const flush = (oversize: boolean): void => {
    if (current.length === 0) return
    slices.push({ events: current, oversize })
    current = []
    currentTokens = 0
  }
  for (const event of events) {
    const weight = Number.isFinite(event.tokens) ? Math.max(0, Math.trunc(event.tokens)) : 0
    if (current.length > 0 && currentTokens + weight > maxTokens) flush(false)
    current.push(event)
    currentTokens += weight
    if (current.length === 1 && weight > maxTokens) flush(true)
  }
  flush(false)
  return slices
}

/** `omw_meta` 的键：每个会话一行；值形如 `<lastSeq>:<pendingTokens>`。 */export function tokenLedgerMetaKey(sessionId: string): string {
  return 'capture_token_ledger:' + sessionId
}

/** 解析 meta 值；缺键/畸形 ⇒ {@link EMPTY_TOKEN_LEDGER}（不抛）。 */
export function parseTokenLedgerState(raw: string | null | undefined): TokenLedgerState {
  if (raw === null || raw === undefined || raw === '') return EMPTY_TOKEN_LEDGER
  const [seqText, pendingText] = raw.split(':')
  const lastSeq = Number.parseInt(seqText ?? '', 10)
  const pendingTokens = Number.parseInt(pendingText ?? '', 10)
  if (!Number.isInteger(lastSeq) || lastSeq < -1) return EMPTY_TOKEN_LEDGER
  if (!Number.isInteger(pendingTokens) || pendingTokens < 0) return { lastSeq, pendingTokens: 0 }
  return { lastSeq, pendingTokens }
}

/** 序列化 meta 值（`<lastSeq>:<pendingTokens>`）。 */
export function formatTokenLedgerState(state: TokenLedgerState): string {
  return String(state.lastSeq) + ':' + String(state.pendingTokens)
}

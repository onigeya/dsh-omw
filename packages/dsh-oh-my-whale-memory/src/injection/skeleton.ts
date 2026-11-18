/**
 * 动态记忆骨架（Story 8.5 / T3、FR-25、AC:1820-1824）。
 *
 * **载体分工**（AD-2 / AD-23 不破）：静态引导语仍是 `systemPrompt` section `omw-memory`
 * 的**常量**；本模块注册一个**独立的动态 context**（`omw-memory-dynamic`），内容是本会话
 * 的不可删事实集合，每次命题重新解析 ⇒ 压缩把它移除后由宿主在下一请求**自动补回**。
 *
 * 骨架内容（本 story 落地范围）：`memory` 表当前快照里 `priority = -1`（全局强规则/禁令）
 * 或 `kind = 'instruction'`（指令类）的节点——即 INV-2 的不可删集合。**用户原话**在消息层
 * 由 `classifyT1` 按 role 保护（压缩走 T1 不折）。
 *
 * Story 11.3 / AD-39：常驻层的 **accepted 自省** 也渲染在本 context 的独立区块
 * （`readAccepted` 端口，缺省不收集）；完整常驻层收集器仍属 Story 3.4（未交付），
 * 本模块不造第二个收集器，也不改静态 section `omw-memory` 的常量文本。
 *
 * 三条边界：
 * 1. 空骨架 ⇒ **空串**（宿主对空文本不产消息，也不占预算，矩阵 8）；
 * 2. 超预算 ⇒ 按**稳定顺序**截断：禁令（`priority=-1`）先、instruction 次之，
 *    同组按 `recorded_at` 升序、`id` 升序（矩阵 9）；
 * 3. 读库失败 ⇒ 空骨架 + warn（不阻塞注入面；每会话只 warn 一次防刷屏，矩阵 10）。
 *
 * 纯读：本模块不写库、不触发写路径（只读实例同样可用，INV-7）。
 */
import type * as lbug from '@ladybugdb/core'
import { queryRows, nullishString } from '../db/rows.js'
import { MEMORY_TABLE } from '../db/schema.js'
import { currentSnapshotPredicate } from '../db/snapshot.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import { truncateToTokenCap } from '../recall/injection-budget.js'
import { purifyText, type PurifyOptions, type PurifyRule } from '../context/purify.js'
import { recordPurifyRun } from '../context/purify-ledger.js'
import { SKELETON_CONTEXT_NAME } from '../shared/injection-vocab.js'
import { estimateTokens } from '../shared/text-budget.js'

export { SKELETON_CONTEXT_NAME }
/** 排序位：紧跟开局召回 context（130）之后。 */
export const SKELETON_CONTEXT_ORDER = 131
/** 骨架文本的固定首行（常量，便于前缀稳定与测试断言）。 */
export const SKELETON_HEADER = '记忆骨架（本会话不可删；压缩移除后自动补回）：'
/**
 * 常驻层里 accepted Self-Knowledge 区块的固定首行（Story 11.3 / AD-39）。
 *
 * **与记忆骨架分开渲染**：accepted 自省不是用户事实（不进 User Portrait 区），也不是 Persona
 * Spec（静态 section `omw-persona`）；它只是常驻层的第三个成员，因此单独成块、绝不并入骨架事实行。
 */
export const SELF_KNOWLEDGE_HEADER = 'Agent 自省（已晋升，仅常驻层；来源可审计）：'
/** 单次查询的节点上限（防超大库把一次注入拖成长查询）。 */
export const SKELETON_MAX_FACTS = 50
/** 裁完剩余低于此 tokens 的事实不渲染（不留碎片行，与注入裁剪同一口径）。 */
export const SKELETON_MIN_LINE_TOKENS = 4

/** 一条骨架事实（只带渲染与排序需要的字段）。 */
export interface SkeletonFact {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  readonly recordedAt: string
}

/**
 * 一条常驻层的 accepted 自省观察（Story 11.3 / T3）：只带渲染与排序需要的字段。
 *
 * 由 `persona/self-knowledge.ts` 的 `listAccepted` 提供（已经过 `isVisible` 判据）；
 * 本模块不再做状态判断，也不把 candidate/rejected 传进来。
 */
export interface AcceptedKnowledgeFact {
  readonly id: string
  readonly text: string
  readonly decidedAt: string | null
}

/**
 * 骨架读库语句：当前快照 ∧ 不可删集合（`priority = -1` 或 `kind = 'instruction'`）。
 * 参数只用 `$priority` / `$kind` / `$limit`，不内联用户数据（值与语句分离）。
 */
export const SKELETON_FACTS_STATEMENT = [
  `MATCH (m:${MEMORY_TABLE})`,
  `WHERE (m.priority = $priority OR m.kind = $kind) AND ${currentSnapshotPredicate('m')}`,
  'RETURN m.id AS id, m.layer AS layer, m.kind AS kind, m.priority AS priority,',
  '  m.text AS text, m.recorded_at AS recorded_at',
  'ORDER BY m.recorded_at ASC, m.id ASC',
  'LIMIT $limit',
].join('\n')

/** 读一次骨架事实（纯读；调用方负责把异常收敛成「空骨架 + warn」）。 */
export async function readSkeletonFacts(connection: lbug.Connection): Promise<SkeletonFact[]> {
  const rows = await queryRows(connection, SKELETON_FACTS_STATEMENT, {
    priority: -1,
    kind: 'instruction',
    limit: SKELETON_MAX_FACTS,
    now: new Date().toISOString(),
  })
  return rows.map((row) => ({
    id: nullishString(row.id) ?? '',
    layer: nullishString(row.layer) ?? 'L1',
    kind: nullishString(row.kind) ?? '',
    priority: typeof row.priority === 'number' ? row.priority : Number(row.priority ?? 0),
    text: nullishString(row.text) ?? '',
    recordedAt: nullishString(row.recorded_at) ?? '',
  }))
}

/**
 * 稳定排序（矩阵 9）：禁令（`priority === -1`）在前、instruction 次之、其余在后；
 * 同组按 `recordedAt` 升序、`id` 升序。给定同一输入永远得到同一序（前缀稳定性的一半）。
 */
export function orderSkeletonFacts(facts: readonly SkeletonFact[]): SkeletonFact[] {
  const rank = (fact: SkeletonFact): number => {
    if (fact.priority === -1) return 0
    if (fact.kind === 'instruction') return 1
    return 2
  }
  return [...facts].sort((left, right) => {
    const byRank = rank(left) - rank(right)
    if (byRank !== 0) return byRank
    if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
}

/**
 * accepted 自省的稳定排序：`decidedAt` 升序（null 视为空串，排最前）、`id` 升序。
 * 给定同一批行永远得到同一序（前缀稳定性的一半，INV-1）。
 */
export function orderAcceptedKnowledge(
  facts: readonly AcceptedKnowledgeFact[],
): AcceptedKnowledgeFact[] {
  return [...facts].sort((left, right) => {
    const leftAt = left.decidedAt ?? ''
    const rightAt = right.decidedAt ?? ''
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
}

export interface SkeletonRender {
  /** 最终骨架文本（空串 = 无骨架，不占预算）。 */
  readonly text: string
  /** 计入预算的正文 tokens（首行标题不计，与注入裁剪同口径）。 */
  readonly tokens: number
  /** 实际渲染的成员数（骨架事实 + accepted 自省）。 */
  readonly kept: number
  /** 是否因预算丢弃/截断过事实。 */
  readonly truncated: boolean
  /**
   * Story 3.4 / T3、AD-39：保留的 `priority === -1` 事实条数（不可裁集合成员）。
   * 即使超预算也全保留，因此这是「常驻人设层里强规则」的可见计数。
   */
  readonly keptInviolable: number
  /**
   * Story 3.4 / T3、AD-39：是否因 `priority === -1` 集合（或最终文本）超出 `alwaysOnTokenCap`
   * 而超预算。`-1` 不可裁 ⇒ 超预算时仍全保留并在此标 true（矩阵 2/3）。
   */
  readonly overBudget: boolean
}

/**
 * 渲染常驻层的动态区块并按绝对上限截断（`alwaysOnTokenCap`，**不套窗口公式**，AC:1827）。
 *
 * 区块顺序固定：记忆骨架（`priority=-1` / instruction，既有行为逐字不变）→ accepted 自省
 * （独立首行，与骨架事实行不混排）。两块共享同一预算：骨架先渲染，accepted 只用剩余额度；
 * 剩余不足一行即整块丢弃并标 `truncated`。空集合 ⇒ `text: ''`（矩阵 8：不占预算、宿主不产消息）。
 *
 * Story 3.4 / T2、AD-39：`priority === -1` 的条目**不得被预算截断**（即使总超预算也全保留），
 * 并计入 `keptInviolable` / 在超预算时标 `overBudget`；非 `-1` 条目按既有顺序照常截断
 * （矩阵 2/3）。`accepted` 缺省为空 ⇒ 输出与 Story 8.5 逐字一致（既有钉死断言不受影响）。
 */
export function renderSkeleton(
  facts: readonly SkeletonFact[],
  capTokens: number,
  accepted: readonly AcceptedKnowledgeFact[] = [],
): SkeletonRender {
  const ordered = orderSkeletonFacts(facts)
  const knowledge = orderAcceptedKnowledge(accepted)
  if (ordered.length === 0 && knowledge.length === 0) {
    return { text: '', tokens: 0, kept: 0, truncated: false, keptInviolable: 0, overBudget: false }
  }
  const cap = typeof capTokens === 'number' && Number.isFinite(capTokens) && capTokens > 0
    ? Math.trunc(capTokens)
    : 0

  const lines: string[] = ordered.length > 0 ? [SKELETON_HEADER] : [SELF_KNOWLEDGE_HEADER]
  let tokens = 0
  let kept = 0
  let keptInviolable = 0
  let truncated = false
  for (const fact of ordered) {
    const isInviolable = fact.priority === -1
    if (!isInviolable) {
      const remaining = cap - tokens
      if (remaining < SKELETON_MIN_LINE_TOKENS) {
        truncated = true
        break
      }
      const body = truncateToTokenCap(fact.text, remaining)
      if (body.text === '') {
        truncated = true
        break
      }
      lines.push(`- [${fact.layer}] ${fact.id}: ${body.text}`)
      tokens += estimateTokens(body.text)
      kept += 1
      if (body.truncated) {
        truncated = true
        break
      }
      continue
    }
    // `priority === -1`：不可裁，整条保留（即使让总 tokens 超预算）。
    lines.push(`- [${fact.layer}] ${fact.id}: ${fact.text}`)
    tokens += estimateTokens(fact.text)
    kept += 1
    keptInviolable += 1
  }
  if (knowledge.length > 0 && !truncated) {
    const remaining = cap - tokens
    if (remaining < SKELETON_MIN_LINE_TOKENS) {
      truncated = true
    } else {
      if (ordered.length > 0) lines.push(SELF_KNOWLEDGE_HEADER)
      for (const fact of knowledge) {
        const left = cap - tokens
        if (left < SKELETON_MIN_LINE_TOKENS) {
          truncated = true
          break
        }
        const body = truncateToTokenCap(fact.text, left)
        if (body.text === '') {
          truncated = true
          break
        }
        lines.push(`- ${fact.id}: ${body.text}`)
        tokens += estimateTokens(body.text)
        kept += 1
        if (body.truncated) {
          truncated = true
          break
        }
      }
    }
  }
  const overBudget = tokens > cap
  // 一个成员都放不下 ⇒ 空串（不注入只有首行、没有内容的消息；与「空骨架不占预算」同口径）。
  if (kept === 0) {
    return { text: '', tokens: 0, kept: 0, truncated: true, keptInviolable: 0, overBudget: false }
  }
  return { text: lines.join('\n'), tokens, kept, truncated, keptInviolable, overBudget }
}

/** 每会话骨架文本的进程内缓存（与注入状态机同键；不持久化）。 */
export interface SkeletonStore {
  textFor(sessionKey: string): string
  /**
   * Story 3.4 / T4、AD-39：写入渲染文本，并记录本次常驻层**已收集**的成员 id
   * （骨架事实 + accepted 自省）。默认空集 = 无常驻层成员（可选层照旧不排除任何候选）。
   */
  set(sessionKey: string, text: string, ids?: readonly string[]): void
  read(sessionKey: string): { readonly text: string } | undefined
  /**
   * Story 3.4 / T4：本会话常驻层已收集的 id 集（只用于可选层按 id 去重，不做语义去重）。
   * 未刷新过 / 刷新失败 / 常驻层关闭 ⇒ 空集。
   */
  idsFor(sessionKey: string): ReadonlySet<string>
  reset(sessionKey: string): void
}

/** 每会话记录：渲染文本 + 常驻层已收集的 id 集。 */
interface SkeletonRecord {
  readonly text: string
  readonly ids: ReadonlySet<string>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

export function createSkeletonStore(): SkeletonStore {
  const records = new Map<string, SkeletonRecord>()
  return {
    textFor(sessionKey) {
      return records.get(sessionKey)?.text ?? ''
    },
    set(sessionKey, text, ids) {
      records.set(sessionKey, { text, ids: ids === undefined ? EMPTY_IDS : new Set(ids) })
    },
    read(sessionKey) {
      const record = records.get(sessionKey)
      return record === undefined ? undefined : { text: record.text }
    },
    idsFor(sessionKey) {
      return records.get(sessionKey)?.ids ?? EMPTY_IDS
    },
    reset(sessionKey) {
      records.delete(sessionKey)
    },
  }
}

export interface SkeletonRefresherOptions {
  readonly store: SkeletonStore
  /** 读库端口（生产实现是 {@link readSkeletonFacts}；失败必须 throw，由本模块收敛）。 */
  readonly readFacts: () => Promise<readonly SkeletonFact[]>
  /**
   * Story 11.3 / T3：常驻层 accepted 自省成员的读端口（生产实现 = `listAccepted`）。
   * 缺省 = 不收集（既有装配与钉死输出逐字不变）。读失败按「本块为空 + warn」收敛，
   * **不影响**骨架事实（accepted 是附加成员，不能让整块骨架消失）。
   */
  readonly readAccepted?: () => Promise<readonly AcceptedKnowledgeFact[]>
  /** 绝对上限（Config `alwaysOnTokenCap`；惰性读取以支持运行期覆盖）。 */
  readonly capTokens: () => number
  readonly logger?: { warn(message: string): void }
  /**
   * Story 8.6 / T4、AC:1896：**注入口**（FR-25 回注前）的确定性净化。骨架是「逐字回注」
   * 的不可删事实，净化只作用于渲染副本（库里节点不动）；缺省 = 模块默认开关。
   * Story 11.3 起同一净化也作用于 accepted 自省副本（同一注入边界，不留第二条回注路径）。
   */
  readonly purifyOptions?: () => PurifyOptions
  /**
   * Story 3.4 / T5：每次成功渲染后回报一次渲染结果（计数与预算标记），供
   * `/memory status` 的 `always_on:` 行读取。缺省 = 不回报（既有装配逐字不变）。
   */
  readonly onRendered?: (render: SkeletonRender) => void
}

/** 净化账本的聚合形态（与 `context/purify-ledger.ts` 的输入同形）。 */
interface PurifyLedger {
  readonly ruleHits: readonly PurifyRule[]
  readonly removedChars: number
  readonly removedTokens: number
  readonly sourceChars: number
}

/** 净化一组带正文的渲染副本：只改副本；无改动时 `ledger: null`。 */
function purifyCopies<T extends { readonly text: string }>(
  items: readonly T[],
  options: PurifyOptions | undefined,
): { readonly items: readonly T[], readonly ledger: PurifyLedger | null } {
  const hits = new Set<PurifyRule>()
  let removedChars = 0
  let removedTokens = 0
  let sourceChars = 0
  let changed = false
  const purified = items.map((item) => {
    const result = purifyText(item.text, options ?? null)
    sourceChars += item.text.length
    if (!result.changed) return item
    changed = true
    for (const rule of result.ruleHits) hits.add(rule)
    removedChars += result.removedChars
    removedTokens += result.removedTokens
    return { ...item, text: result.text }
  })
  if (!changed) return { items, ledger: null }
  return { items: purified, ledger: { ruleHits: [...hits], removedChars, removedTokens, sourceChars } }
}

/** 合并两块（骨架 / accepted）的净化账本：任一块有改动即记一条账本（不丢另一块的命中）。 */
function mergePurifyLedgers(first: PurifyLedger | null, second: PurifyLedger | null): PurifyLedger | null {
  if (first === null) return second
  if (second === null) return first
  return {
    ruleHits: [...new Set([...first.ruleHits, ...second.ruleHits])],
    removedChars: first.removedChars + second.removedChars,
    removedTokens: first.removedTokens + second.removedTokens,
    sourceChars: first.sourceChars + second.sourceChars,
  }
}

/**
 * 每次命题刷新一次骨架（压缩移除后在下一请求自动补回，AC:1823）。
 * 失败 ⇒ 空骨架 + warn（**每会话只 warn 一次**，避免每步刷屏），注入面照常工作。
 */
export function createSkeletonRefresher(
  options: SkeletonRefresherOptions,
): (sessionKey: string) => Promise<void> {
  const warned = new Set<string>()
  /** accepted 读取失败只让本块为空（不能让整块骨架消失），每会话只 warn 一次。 */
  const acceptedWarned = new Set<string>()
  return async (sessionKey) => {
    try {
      const facts = await options.readFacts()
      let accepted: readonly AcceptedKnowledgeFact[] = []
      if (options.readAccepted !== undefined) {
        try {
          accepted = await options.readAccepted()
        } catch (error) {
          if (!acceptedWarned.has(sessionKey)) {
            acceptedWarned.add(sessionKey)
            options.logger?.warn(
              '自省观察读取失败，本次注入不含自省区块（不阻塞注入）：' +
              (error instanceof Error ? error.message : String(error)),
            )
          }
        }
      }
      // Story 8.6 / T4：回注前净化（只改渲染副本）；Story 11.3：accepted 走同一注入口。
      const purifyOptions = options.purifyOptions?.()
      const purified = purifyCopies(facts, purifyOptions)
      const purifiedAccepted = purifyCopies(accepted, purifyOptions)
      const rendered = renderSkeleton(purified.items, options.capTokens(), purifiedAccepted.items)
      // Story 3.4 / T4：常驻层已收集的 id 集（骨架事实 + accepted 自省，只按 id，不做语义去重）。
      const collectedIds = [...purified.items.map((fact) => fact.id), ...purifiedAccepted.items.map((fact) => fact.id)]
      options.store.set(sessionKey, rendered.text, collectedIds)
      // Story 3.4 / T5：渲染计数回报（`always_on:` 行的数据源）。
      options.onRendered?.(rendered)
      const ledger = mergePurifyLedgers(purified.ledger, purifiedAccepted.ledger)
      if (ledger !== null) {
        void recordPurifyRun(
          {
            sessionId: sessionKey,
            rangeStart: 0,
            rangeEnd: ledger.sourceChars,
            ruleHits: ledger.ruleHits,
            removedChars: ledger.removedChars,
            removedTokens: ledger.removedTokens,
          },
          { logger: options.logger },
        )
      }
      warned.delete(sessionKey)
      acceptedWarned.delete(sessionKey)
    } catch (error) {
      options.store.set(sessionKey, '')
      if (!warned.has(sessionKey)) {
        warned.add(sessionKey)
        options.logger?.warn(
          '记忆骨架读取失败，本次注入不含骨架（不阻塞注入）：' +
          (error instanceof Error ? error.message : String(error)),
        )
      }
    }
  }
}

/** 从宿主 `AssembleContext` 取会话键（与注入状态机/配额同键）。 */
export function skeletonSessionKeyOf(context: unknown): string {
  const session = (context as { readonly agent?: { readonly session?: unknown } } | null | undefined)
    ?.agent?.session
  return inboxSessionKey(session)
}

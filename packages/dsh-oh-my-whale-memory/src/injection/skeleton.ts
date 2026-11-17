/**
 * 动态记忆骨架（Story 8.5 / T3、FR-25、AC:1820-1824）。
 *
 * **载体分工**（AD-2 / AD-23 不破）：静态引导语仍是 `systemPrompt` section `omw-memory`
 * 的**常量**；本模块注册一个**独立的动态 context**（`omw-memory-dynamic`），内容是本会话
 * 的不可删事实集合，每次命题重新解析 ⇒ 压缩把它移除后由宿主在下一请求**自动补回**。
 *
 * 骨架内容（本 story 落地范围）：`memory` 表当前快照里 `priority = -1`（全局强规则/禁令）
 * 或 `kind = 'instruction'`（指令类）的节点——即 INV-2 的不可删集合。**用户原话**在消息层
 * 由 `classifyT1` 按 role 保护（压缩走 T1 不折），常驻层（User Portrait / Persona Spec /
 * accepted Self-Knowledge）的收集器属 Story 3.4（未交付），故这里不造第二个收集器。
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
import { SKELETON_CONTEXT_NAME } from '../shared/injection-vocab.js'
import { estimateTokens } from '../shared/text-budget.js'

export { SKELETON_CONTEXT_NAME }
/** 排序位：紧跟开局召回 context（130）之后。 */
export const SKELETON_CONTEXT_ORDER = 131
/** 骨架文本的固定首行（常量，便于前缀稳定与测试断言）。 */
export const SKELETON_HEADER = '记忆骨架（本会话不可删；压缩移除后自动补回）：'
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

export interface SkeletonRender {
  /** 最终骨架文本（空串 = 无骨架，不占预算）。 */
  readonly text: string
  /** 计入预算的正文 tokens（首行标题不计，与注入裁剪同口径）。 */
  readonly tokens: number
  /** 实际渲染的事实数。 */
  readonly kept: number
  /** 是否因预算丢弃/截断过事实。 */
  readonly truncated: boolean
}

/**
 * 渲染骨架并按绝对上限截断（`alwaysOnTokenCap`，**不套窗口公式**，AC:1827）。
 * 空集合 ⇒ `text: ''`（矩阵 8：不占预算、宿主不产消息）。
 */
export function renderSkeleton(facts: readonly SkeletonFact[], capTokens: number): SkeletonRender {
  const ordered = orderSkeletonFacts(facts)
  if (ordered.length === 0) return { text: '', tokens: 0, kept: 0, truncated: false }
  const cap = typeof capTokens === 'number' && Number.isFinite(capTokens) && capTokens > 0
    ? Math.trunc(capTokens)
    : 0
  if (cap === 0) return { text: '', tokens: 0, kept: 0, truncated: true }

  const lines: string[] = [SKELETON_HEADER]
  let tokens = 0
  let kept = 0
  let truncated = false
  for (const fact of ordered) {
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
  }
  return { text: lines.join('\n'), tokens, kept, truncated }
}

/** 每会话骨架文本的进程内缓存（与注入状态机同键；不持久化）。 */
export interface SkeletonStore {
  textFor(sessionKey: string): string
  set(sessionKey: string, text: string): void
  read(sessionKey: string): { readonly text: string } | undefined
  reset(sessionKey: string): void
}

export function createSkeletonStore(): SkeletonStore {
  const records = new Map<string, string>()
  return {
    textFor(sessionKey) {
      return records.get(sessionKey) ?? ''
    },
    set(sessionKey, text) {
      records.set(sessionKey, text)
    },
    read(sessionKey) {
      const text = records.get(sessionKey)
      return text === undefined ? undefined : { text }
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
  /** 绝对上限（Config `alwaysOnTokenCap`；惰性读取以支持运行期覆盖）。 */
  readonly capTokens: () => number
  readonly logger?: { warn(message: string): void }
}

/**
 * 每次命题刷新一次骨架（压缩移除后在下一请求自动补回，AC:1823）。
 * 失败 ⇒ 空骨架 + warn（**每会话只 warn 一次**，避免每步刷屏），注入面照常工作。
 */
export function createSkeletonRefresher(
  options: SkeletonRefresherOptions,
): (sessionKey: string) => Promise<void> {
  const warned = new Set<string>()
  return async (sessionKey) => {
    try {
      const facts = await options.readFacts()
      const rendered = renderSkeleton(facts, options.capTokens())
      options.store.set(sessionKey, rendered.text)
      warned.delete(sessionKey)
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

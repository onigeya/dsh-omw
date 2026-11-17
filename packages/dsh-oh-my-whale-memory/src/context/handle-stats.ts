/**
 * 句柄展开统计与「摘要重写」入队（Story 8.4 / T5、FR-29、INV-7、矩阵行 8–9）。
 *
 * 为什么单独一层：`memory_expand` 是 surface 层工具，只该关心「还原成功/失败」；计数、
 * 超阈判定与入队是 domain 行为（会写库），放在这里由工具调用。
 *
 * 两条纪律：
 * 1. **只读实例零写**（INV-7）：调用方在 `database.readonly` 时根本不进来；本模块不做只读判断，
 *    以免两份裁决；
 * 2. **幂等**：重写条目 id = `rewrite:<handleId>`，`writeInboxItem` 的 MERGE ON CREATE 语义让
 *    第 N 次超阈展开只留一条条目（矩阵行 8）；计数与入队在同一事务里，崩溃不会只留下计数。
 */
import type * as lbug from '@ladybugdb/core'
import { MEMORY_TABLE } from '../db/schema.js'
import { queryRows } from '../db/rows.js'
import { runInTransaction } from '../db/transaction.js'
import { writeInboxItem } from '../inbox/queue.js'

/**
 * 重写条目的 kind（INBOX 消费者按它路由到摘要重写处理器，而不是走普通精炼）。
 * 字面量与 spec 的「摘要重写」对应；改这里必须同步 `distill/summary-rewrite.ts`。
 */
export const HANDLE_REWRITE_KIND = 'summary-rewrite'

/** 重写条目的幂等键前缀（矩阵行 8：`rewrite:<handleId>`）。 */
export const HANDLE_REWRITE_ID_PREFIX = 'rewrite:'

/** 重写条目的载荷：`rewrite` 标记 + 句柄 id + 当前版本 id（spec T5 逐字要求）。 */
export interface HandleRewritePayload {
  readonly rewrite: true
  readonly handleId: string
  /** 当前版本节点 id（句柄即自身版本，故与 handleId 相同；保留字段以便将来版本链扩展）。 */
  readonly versionId: string
}

/** 重写条目的确定性 id（幂等键）。 */
export function handleRewriteItemId(handleId: string): string {
  return HANDLE_REWRITE_ID_PREFIX + handleId
}

/** 组装载荷并序列化（payload 是 JSON 字符串列）。 */
export function buildHandleRewritePayload(handleId: string): HandleRewritePayload {
  return { rewrite: true, handleId, versionId: handleId }
}

/**
 * 单语句自增（原子：读-改-写在同一条 Cypher 里）：
 * `expand_count` 为 NULL（迁移前的旧行 / 未设置）时按 0 起算。
 */
const BUMP_EXPAND = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'SET m.expand_count = CASE WHEN m.expand_count IS NULL THEN 1 ELSE m.expand_count + 1 END,',
  '    m.last_expanded_at = $now',
  'RETURN m.expand_count AS expand_count, m.chain_depth AS chain_depth',
].join('\n')

export interface HandleExpandInput {
  readonly handleId: string
  /** 条目归属会话（重写条目的路由解析靠它）。 */
  readonly sessionId: string
  readonly now: Date
  /** Config 的 `expandCountThreshold`（`expandCount >= 阈值` 即不合格）。 */
  readonly expandCountThreshold: number
  /** Config 的 `chainDepthThreshold`（`chainDepth >= 阈值` 即不合格）。 */
  readonly chainDepthThreshold: number
}

export interface HandleExpandStats {
  readonly expandCount: number
  readonly chainDepth: number
  readonly lastExpandedAt: string
  /** 本次是否（重新）落了一条重写条目（幂等：已有条目也算 true，因为条目在）。 */
  readonly rewriteQueued: boolean
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 记一次成功展开：`expand_count += 1`、`last_expanded_at = now`；达阈值则幂等入队重写条目。
 *
 * 句柄不存在时抛错（调用方 fail-open：还原结果照常返回，只记 warn）。
 */
export async function recordHandleExpand(
  connection: lbug.Connection,
  input: HandleExpandInput,
): Promise<HandleExpandStats> {
  const nowIso = input.now.toISOString()
  return runInTransaction(connection, async () => {
    const rows = await queryRows(connection, BUMP_EXPAND, { id: input.handleId, now: nowIso })
    const row = rows[0]
    if (row === undefined) {
      throw new Error('句柄节点不存在，无法记录展开（id=' + input.handleId + '）')
    }
    const expandCount = finiteNonNegative(row.expand_count, 1)
    const chainDepth = finiteNonNegative(row.chain_depth, 0)
    const unqualified = expandCount >= input.expandCountThreshold || chainDepth >= input.chainDepthThreshold
    if (unqualified) {
      await writeInboxItem(connection, {
        id: handleRewriteItemId(input.handleId),
        sessionId: input.sessionId,
        kind: HANDLE_REWRITE_KIND,
        payload: JSON.stringify(buildHandleRewritePayload(input.handleId)),
        now: input.now,
      })
    }
    return {
      expandCount,
      chainDepth,
      lastExpandedAt: nowIso,
      rewriteQueued: unqualified,
    }
  })
}

/** 解析重写条目载荷；非法（缺 rewrite 标记 / handleId）返回 null（调用方按致命错误处理）。 */
export function parseHandleRewritePayload(raw: string): HandleRewritePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const payload = parsed as Partial<HandleRewritePayload> | null
  if (payload === null || typeof payload !== 'object') return null
  if (payload.rewrite !== true) return null
  if (typeof payload.handleId !== 'string' || payload.handleId === '') return null
  return {
    rewrite: true,
    handleId: payload.handleId,
    versionId: typeof payload.versionId === 'string' && payload.versionId !== '' ? payload.versionId : payload.handleId,
  }
}

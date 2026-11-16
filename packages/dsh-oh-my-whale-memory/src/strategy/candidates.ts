/**
 * 策略候选区（Story 7.3 / AD-20、FR-21）。
 *
 * 三条纪律（AD-20 逐字）：
 * 1. **append 优先、不整体重写**：候选以新 id 落库；对既有策略只「就地累加元层计数」（本模块用
 *    `omw_meta` 的 `strategy.counter.<strategyId>.<name>` 键，避免为此加表）；
 * 2. **候选未过采纳门不得进正式区**：`state` 从 `pending` 只能到 `adopted` / `rejected` / `expired`；
 * 3. **最多 2 次重写**，改写对象仅限候选本身（`rewriteCandidate` 超限抛 `strategy_rewrite_exhausted`）。
 *
 * 候选的 `outcome` 沿用 fr-8 的三态（success | failure | uncertain），失败经验与成功经验**隔离**：
 * `listPendingCandidates({ includeFailure: false })` 默认不返回失败经验。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from '../db/errors.js'
import { readMetaValue, writeMetaValue } from '../db/meta.js'
import { runPrepared } from '../db/backend.js'
import { queryRows } from '../db/rows.js'
import { STRATEGY_CANDIDATE_TABLE } from '../db/schema.js'

/** 候选最多允许的重写次数（AC:1490：「最多 2 次重写」）。 */
export const MAX_STRATEGY_REWRITES = 2

export type StrategyCandidateState = 'pending' | 'adopted' | 'rejected' | 'expired'
export type StrategyOutcome = 'success' | 'failure' | 'uncertain'

export interface StrategyCandidate {
  readonly id: string
  readonly strategyId: string
  readonly payload: string
  readonly state: StrategyCandidateState
  readonly rewrites: number
  readonly score: number
  readonly outcome: StrategyOutcome
  readonly reasons: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface StrategyStats {
  readonly candidates: number
  readonly pending: number
  readonly adopted: number
  readonly rejected: number
  readonly expired: number
  /** `evidence: none` 的候选数（无 case 集，按 AD-20 不得宣称有效）。 */
  readonly noEvidence: number
}

const INSERT_CANDIDATE = [
  'CREATE (:' + STRATEGY_CANDIDATE_TABLE + ' {',
  '  id: $id, strategy_id: $strategy_id, payload: $payload, state: $state, rewrites: $rewrites,',
  '  score: $score, outcome: $outcome, reasons: $reasons, created_at: $created_at,',
  '  expires_at: $expires_at, updated_at: $updated_at',
  '})',
].join('\n')

const READ_CANDIDATE = [
  'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
  'RETURN c.id AS id, c.strategy_id AS strategy_id, c.payload AS payload, c.state AS state,',
  '  c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
  '  c.created_at AS created_at, c.expires_at AS expires_at',
].join('\n')

function toCandidate(row: Record<string, unknown> | undefined): StrategyCandidate | null {
  if (row === undefined) return null
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id ?? ''),
    payload: String(row.payload ?? ''),
    state: String(row.state ?? 'pending') as StrategyCandidateState,
    rewrites: Number(row.rewrites ?? 0),
    score: Number(row.score ?? 0),
    outcome: String(row.outcome ?? 'uncertain') as StrategyOutcome,
    reasons: String(row.reasons ?? ''),
    createdAt: String(row.created_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
  }
}

/** 落一条候选（`pending`）。`id` 由调用方给（内容键），便于重放幂等。 */
export async function insertStrategyCandidate(
  connection: lbug.Connection,
  input: {
    readonly id: string
    readonly strategyId: string
    readonly payload: string
    readonly outcome: StrategyOutcome
    readonly createdAt: string
    readonly expiresAt: string
  },
): Promise<void> {
  const statement = await connection.prepare(INSERT_CANDIDATE)
  await runPrepared(connection, statement, {
    id: input.id,
    strategy_id: input.strategyId,
    payload: input.payload,
    state: 'pending',
    rewrites: 0,
    score: 0,
    outcome: input.outcome,
    reasons: '',
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    updated_at: input.createdAt,
  })
}

export async function readStrategyCandidate(
  connection: lbug.Connection,
  id: string,
): Promise<StrategyCandidate | null> {
  const rows = await queryRows(connection, READ_CANDIDATE, { id })
  return toCandidate(rows[0])
}

/** 候选清单；`outcome='failure'` 默认排除（失败经验隔离）。 */
export async function listStrategyCandidates(
  connection: lbug.Connection,
  options: { readonly state?: StrategyCandidateState; readonly includeFailure?: boolean; readonly limit?: number } = {},
): Promise<StrategyCandidate[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? 20))
  const conditions = ['true']
  const params: Record<string, string | number> = { limit }
  if (options.state !== undefined) {
    conditions.push('c.state = $state')
    params.state = options.state
  }
  if (options.includeFailure !== true) {
    conditions.push("c.outcome <> 'failure'")
  }
  const rows = await queryRows(
    connection,
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ')',
      '  WHERE ' + conditions.join(' AND '),
      '  RETURN c.id AS id, c.strategy_id AS strategy_id, c.payload AS payload, c.state AS state,',
      '    c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
      '    c.created_at AS created_at, c.expires_at AS expires_at',
      '  ORDER BY c.created_at DESC, c.id ASC LIMIT $limit',
    ].join('\n'),
    params,
  )
  return rows.map((row) => toCandidate(row)).filter((item): item is StrategyCandidate => item !== null)
}

/**
 * 记一次采纳门结果：`adopted` ⇒ `state='adopted'`；否则 `state='rejected'`（留在候选区，不删）。
 * `reasons` 落库便于 `/memory strategy` 与审计解释「为什么没过门」。
 */
export async function recordGateResult(
  connection: lbug.Connection,
  input: {
    readonly id: string
    readonly adopted: boolean
    readonly score: number
    readonly reasons: readonly string[]
    readonly nowIso: string
  },
): Promise<void> {
  const candidate = await readStrategyCandidate(connection, input.id)
  if (candidate === null) {
    throw new MemoryDbError('strategy_candidate_not_found', '策略候选不存在（id=' + input.id + '）')
  }
  // 状态守卫（评审 R73 第 3 条）：只有 pending 能被门判定；已 adopted/rejected/expired 不得改判，
  // 否则一条已采纳的候选能被第二次判定「改判」，审计上等于篡改历史。
  if (candidate.state !== 'pending') {
    throw new MemoryDbError(
      'strategy_candidate_not_pending',
      `策略候选状态为 ${candidate.state}，只有 pending 可被采纳门判定`,
    )
  }
  const statement = await connection.prepare(
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      '  SET c.state = $state, c.score = $score, c.reasons = $reasons, c.updated_at = $now',
    ].join('\n'),
  )
  await runPrepared(connection, statement, {
    id: input.id,
    state: input.adopted ? 'adopted' : 'rejected',
    score: input.score,
    reasons: input.reasons.join('；'),
    now: input.nowIso,
  })
}

/**
 * 重写候选正文（**仅候选本身**，绝不动已入正式区的策略）。
 * 超过 `MAX_STRATEGY_REWRITES` 抛 `strategy_rewrite_exhausted`，调用方应丢弃候选并记 `outcome='failure'`。
 */
export async function rewriteStrategyCandidate(
  connection: lbug.Connection,
  input: { readonly id: string; readonly payload: string; readonly nowIso: string },
): Promise<{ readonly rewrites: number }> {
  const candidate = await readStrategyCandidate(connection, input.id)
  if (candidate === null) {
    throw new MemoryDbError('strategy_candidate_not_found', '策略候选不存在（id=' + input.id + '）')
  }
  if (candidate.state !== 'pending') {
    // 状态守卫（评审 R73 第 3 条）：已采纳/已拒绝的候选不允许再改正文，否则「正式区正文不可重写」
    // 的精神在候选层被绕过（改完不重过门就等于静默发布）。
    throw new MemoryDbError(
      'strategy_candidate_not_pending',
      `策略候选状态为 ${candidate.state}，只有 pending 可重写`,
    )
  }
  if (candidate.rewrites >= MAX_STRATEGY_REWRITES) {
    throw new MemoryDbError(
      'strategy_rewrite_exhausted',
      `策略候选已达重写上限（${String(MAX_STRATEGY_REWRITES)} 次），应丢弃并记 outcome=failure`,
    )
  }
  const rewrites = candidate.rewrites + 1
  const statement = await connection.prepare(
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      '  SET c.payload = $payload, c.rewrites = $rewrites, c.updated_at = $now',
    ].join('\n'),
  )
  await runPrepared(connection, statement, { id: input.id, payload: input.payload, rewrites, now: input.nowIso })
  return { rewrites }
}

/** 丢弃候选（重写用尽后）：`state='rejected'` 且 `outcome='failure'`（失败经验保留并与成功经验隔离）。 */
export async function discardStrategyCandidate(
  connection: lbug.Connection,
  input: { readonly id: string; readonly reason: string; readonly nowIso: string },
): Promise<void> {
  const statement = await connection.prepare(
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      // reasons 追加而不是覆盖（评审 R73 第 4 条：覆盖会丢掉 'no-cases'，让 noEvidence 计数静默归零）。
      "  SET c.state = 'rejected', c.outcome = 'failure',",
      "    c.reasons = CASE WHEN c.reasons = '' THEN $reason ELSE c.reasons + '；' + $reason END,",
      '    c.updated_at = $now',
    ].join('\n'),
  )
  await runPrepared(connection, statement, { id: input.id, reason: input.reason, now: input.nowIso })
}

/** 过期扫描：`expires_at < now` 且仍 `pending` ⇒ `expired`。返回影响条数。 */
export async function expireStrategyCandidates(
  connection: lbug.Connection,
  nowIso: string,
): Promise<number> {
  const rows = await queryRows(
    connection,
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ')',
      "  WHERE c.state = 'pending' AND c.expires_at < $now",
      '  RETURN c.id AS id',
    ].join('\n'),
    { now: nowIso },
  )
  if (rows.length === 0) return 0
  const statement = await connection.prepare(
    ['MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})', "  SET c.state = 'expired', c.updated_at = $now"].join('\n'),
  )
  for (const row of rows) await runPrepared(connection, statement, { id: String(row.id), now: nowIso })
  return rows.length
}

/** 元层计数就地累加（AD-20：不新建版本、不重写正文）。`name` ∈ usage | adopted | hit。 */
export async function bumpStrategyCounter(
  connection: lbug.Connection,
  input: { readonly strategyId: string; readonly name: 'usage' | 'adopted' | 'hit' },
): Promise<number> {
  const key = `strategy.counter.${input.strategyId}.${input.name}`
  const current = Number((await readMetaValue(connection, key)) ?? '0')
  const next = (Number.isFinite(current) ? current : 0) + 1
  await writeMetaValue(connection, key, String(next))
  return next
}

/** 候选区可观测性（AC:1494、1498）：`/memory strategy` 与 `/memory status` 的同口径数据源。 */
export async function strategyStats(connection: lbug.Connection): Promise<StrategyStats> {
  const rows = await queryRows(
    connection,
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ')',
      '  RETURN count(c) AS total,',
      "  sum(CASE WHEN c.state = 'pending' THEN 1 ELSE 0 END) AS pending_count,",
      "  sum(CASE WHEN c.state = 'adopted' THEN 1 ELSE 0 END) AS adopted_count,",
      "  sum(CASE WHEN c.state = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,",
      "  sum(CASE WHEN c.state = 'expired' THEN 1 ELSE 0 END) AS expired_count,",
      "  sum(CASE WHEN c.reasons CONTAINS 'no-cases' THEN 1 ELSE 0 END) AS no_evidence",
    ].join('\n'),
  )
  const row = rows[0] ?? {}
  return {
    candidates: Number(row.total ?? 0),
    pending: Number(row.pending_count ?? 0),
    adopted: Number(row.adopted_count ?? 0),
    rejected: Number(row.rejected_count ?? 0),
    expired: Number(row.expired_count ?? 0),
    noEvidence: Number(row.no_evidence ?? 0),
  }
}

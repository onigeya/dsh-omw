/**
 * 慢路径队列（Story 7.2 / AD-6「慢路径独立队列与预算」、AD-20、Q-4）。
 *
 * **与快路径的边界**（AD-6 逐字）：慢路径**不共用**采集/精炼的 FIFO，也不占用它的 lease 60s / 重试 3 次 /
 * 24h stale 配额。本模块的全部参数来自 Q-4 已锁的慢路径默认值：
 * - 单任务重试 **3 次**（首次 + 2 次重试），指数退避 ×2、初始 5s、上限 120s、jitter ±20%；
 * - **整窗重做 ≤ 2 轮**（撤章 = 把该窗内所有 `failed` 行退回 `pending` 并清 `attempts`）；
 * - **运行级短路**：本轮预算耗尽（`budget_exhausted`）即停，不再逐个重试；
 * - 死信保留 **7 天**（`failed` 且超期才能被清理）。
 *
 * 本模块只是**持久化 + 状态迁移**；退避的实际等待由调用方（宿主 timer）负责 —— 队列只给 `nextAttemptAt`。
 * 这样队列可以纯逻辑单测，不需要假时钟去驱动 setTimeout。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from '../db/errors.js'
import { queryRows } from '../db/rows.js'
import { runPrepared } from '../db/backend.js'
import { SLOW_TASK_TABLE } from '../db/schema.js'

/** Q-4 锁定的慢路径默认值（代码里不得另写字面量）。 */
export const SLOW_PATH_MAX_ATTEMPTS = 3
export const SLOW_PATH_MAX_WINDOW_ROUNDS = 2
export const SLOW_PATH_BACKOFF_INITIAL_MS = 5_000
export const SLOW_PATH_BACKOFF_MAX_MS = 120_000
export const SLOW_PATH_BACKOFF_JITTER = 0.2
export const SLOW_PATH_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type SlowTaskState = 'pending' | 'processing' | 'done' | 'failed'

export interface SlowTask {
  readonly id: string
  readonly kind: string
  readonly payload: string
  readonly state: SlowTaskState
  readonly attempts: number
  readonly windowRound: number
  readonly lastError: string | null
  readonly createdAt: string
}

export interface SlowQueueStats {
  /** 待处理（含 lease 已过期的 processing，调用方应先 `reapExpired`）。 */
  readonly depth: number
  /** 有界重试集大小（`failed` 且 `attempts < 上限`）。 */
  readonly retrySet: number
  /** 已达到重试上限、等整窗重扫的条目数。 */
  readonly exhausted: number
  /** 死信（`failed` 且超期或已无路径）。 */
  readonly deadLetters: number
  /** 已发生的整窗重扫轮次（取库内最大值）。 */
  readonly windowRound: number
  /** 本轮是否发生过运行级短路。 */
  readonly shortCircuited: boolean
}

const INSERT_TASK = [
  'CREATE (:' + SLOW_TASK_TABLE + ' {',
  '  id: $id, kind: $kind, payload: $payload, state: $state, attempts: $attempts,',
  '  window_round: $window_round, lease_owner: $lease_owner, lease_until: $lease_until,',
  '  last_error: $last_error, created_at: $created_at, updated_at: $updated_at',
  '})',
].join('\n')

const READ_TASK = [
  'MATCH (t:' + SLOW_TASK_TABLE + ' {id: $id})',
  'RETURN t.id AS id, t.kind AS kind, t.payload AS payload, t.state AS state,',
  '  t.attempts AS attempts, t.window_round AS window_round, t.last_error AS last_error,',
  '  t.created_at AS created_at',
].join('\n')

function toTask(row: Record<string, unknown> | undefined): SlowTask | null {
  if (row === undefined) return null
  return {
    id: String(row.id),
    kind: String(row.kind ?? ''),
    payload: String(row.payload ?? ''),
    state: String(row.state ?? 'pending') as SlowTaskState,
    attempts: Number(row.attempts ?? 0),
    windowRound: Number(row.window_round ?? 0),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: String(row.created_at ?? ''),
  }
}

/** 入队（`pending`）。`id` 由调用方给（内容键或 uuid），便于重放幂等。 */
export async function enqueueSlowTask(
  connection: lbug.Connection,
  input: {
    readonly id: string
    readonly kind: string
    readonly payload: string
    readonly createdAt: string
  },
): Promise<void> {
  const statement = await connection.prepare(INSERT_TASK)
  await runPrepared(connection, statement, {
    id: input.id,
    kind: input.kind,
    payload: input.payload,
    state: 'pending',
    attempts: 0,
    window_round: 0,
    lease_owner: null,
    lease_until: null,
    last_error: null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  })
}

export async function readSlowTask(connection: lbug.Connection, id: string): Promise<SlowTask | null> {
  const rows = await queryRows(connection, READ_TASK, { id })
  return toTask(rows[0])
}

/**
 * 取下一个任务并上租约（`pending` 或租约已过期的 `processing` 都可取）。
 * 无任务返回 `null`（不报错：空队列是常态）。
 */
export async function leaseNextSlowTask(
  connection: lbug.Connection,
  input: { readonly owner: string; readonly leaseUntil: string; readonly nowIso: string },
): Promise<SlowTask | null> {
  const rows = await queryRows(
    connection,
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ')',
      "  WHERE t.state = 'pending'",
      '  RETURN t.id AS id, t.kind AS kind, t.payload AS payload, t.state AS state,',
      '    t.attempts AS attempts, t.window_round AS window_round, t.last_error AS last_error,',
      '    t.created_at AS created_at',
      '  ORDER BY t.created_at ASC, t.id ASC LIMIT 1',
    ].join('\n'),
  )
  const task = toTask(rows[0])
  if (task === null) return null
  const statement = await connection.prepare(
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ' {id: $id})',
      "  SET t.state = 'processing', t.lease_owner = $owner, t.lease_until = $lease_until, t.updated_at = $now",
    ].join('\n'),
  )
  await runPrepared(connection, statement, {
    id: task.id,
    owner: input.owner,
    lease_until: input.leaseUntil,
    now: input.nowIso,
  })
  return { ...task, state: 'processing' }
}

/** 标记完成（`done`）；不删行，`done` 行由运行期按保留期回收。 */
export async function completeSlowTask(
  connection: lbug.Connection,
  id: string,
  nowIso: string,
): Promise<void> {
  const statement = await connection.prepare(
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ' {id: $id})',
      "  SET t.state = 'done', t.lease_owner = null, t.lease_until = null, t.last_error = null, t.updated_at = $now",
    ].join('\n'),
  )
  await runPrepared(connection, statement, { id, now: nowIso })
}

/**
 * 记一次失败：`attempts + 1`。
 * - 未达上限 ⇒ 回 `pending`（有界重试集），并给出**下一次允许尝试的时刻**（退避 + jitter）；
 * - 达上限 ⇒ 留 `failed`（等整窗重扫或进死信），`nextAttemptAt` 为 `null`。
 */
export async function failSlowTask(
  connection: lbug.Connection,
  input: {
    readonly id: string
    readonly error: string
    readonly nowIso: string
    readonly random?: () => number
  },
): Promise<{ readonly state: SlowTaskState; readonly attempts: number; readonly nextAttemptAt: string | null }> {
  const task = await readSlowTask(connection, input.id)
  if (task === null) {
    throw new MemoryDbError('slow_task_not_found', '慢路径任务不存在（id=' + input.id + '）')
  }
  const attempts = task.attempts + 1
  const exhausted = attempts >= SLOW_PATH_MAX_ATTEMPTS
  const statement = await connection.prepare(
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ' {id: $id})',
      '  SET t.state = $state, t.attempts = $attempts, t.lease_owner = null, t.lease_until = null,',
      '    t.last_error = $error, t.updated_at = $now',
    ].join('\n'),
  )
  await runPrepared(connection, statement, {
    id: input.id,
    state: exhausted ? 'failed' : 'pending',
    attempts,
    error: input.error,
    now: input.nowIso,
  })
  if (exhausted) return { state: 'failed', attempts, nextAttemptAt: null }
  const delay = backoffDelayMs(attempts, input.random ?? Math.random)
  const nextAttemptAt = new Date(Date.parse(input.nowIso) + delay).toISOString()
  return { state: 'pending', attempts, nextAttemptAt }
}

/** 退避：初始 5s、×2 且上限 120s、jitter ±20%（Q-4）。 */
export function backoffDelayMs(attempts: number, random: () => number): number {
  const base = Math.min(SLOW_PATH_BACKOFF_MAX_MS, SLOW_PATH_BACKOFF_INITIAL_MS * 2 ** Math.max(0, attempts - 1))
  const jitter = 1 + (random() * 2 - 1) * SLOW_PATH_BACKOFF_JITTER
  return Math.max(1, Math.round(base * jitter))
}

/**
 * 撤章整窗重扫：把该窗内**所有** `failed` 退回 `pending` 并清 `attempts`，`window_round + 1`。
 *
 * 「整窗」= 同一 `created_at` 批次（慢路径按窗调度，调用方传窗标识；这里用 `created_at` 前缀匹配，
 * 由调用方保证批次语义）。返回受影响条数；轮次已用尽（> 2）时抛 `slow_task_window_exhausted`，
 * 让调用方转「运行级短路 + 死信」，而不是无限重扫。
 */
export async function rescanSlowTaskWindow(
  connection: lbug.Connection,
  input: { readonly windowPrefix: string; readonly nowIso: string },
): Promise<{ readonly requeued: number; readonly windowRound: number }> {
  const rows = await queryRows(
    connection,
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ')',
      "  WHERE t.state = 'failed' AND t.created_at STARTS WITH $prefix",
      '  RETURN t.id AS id, t.window_round AS window_round',
    ].join('\n'),
    { prefix: input.windowPrefix },
  )
  if (rows.length === 0) return { requeued: 0, windowRound: 0 }
  const currentRound = Math.max(...rows.map((row) => Number(row.window_round ?? 0)))
  if (currentRound >= SLOW_PATH_MAX_WINDOW_ROUNDS) {
    throw new MemoryDbError(
      'slow_task_window_exhausted',
      `整窗重扫已达上限（${String(SLOW_PATH_MAX_WINDOW_ROUNDS)} 轮），转为运行级短路`,
    )
  }
  const nextRound = currentRound + 1
  const statement = await connection.prepare(
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ' {id: $id})',
      "  SET t.state = 'pending', t.attempts = 0, t.window_round = $round,",
      '    t.lease_owner = null, t.lease_until = null, t.updated_at = $now',
    ].join('\n'),
  )
  for (const row of rows) {
    await runPrepared(connection, statement, { id: String(row.id), round: nextRound, now: input.nowIso })
  }
  return { requeued: rows.length, windowRound: nextRound }
}

/** 队列可观测性（AC:1433-1435）：`/memory status` 的 `slow_queue:` 行数据源。 */
export async function slowQueueStats(connection: lbug.Connection): Promise<SlowQueueStats> {
  // 0.22.3 里 `count(CASE WHEN …)` 返回 0（实测量不到分支），必须用 `sum(CASE … THEN 1 ELSE 0 END)`。
  const rows = await queryRows(
    connection,
    [
      'MATCH (t:' + SLOW_TASK_TABLE + ')',
      '  RETURN count(t) AS total,',
      "  sum(CASE WHEN t.state = 'pending' THEN 1 ELSE 0 END) AS pending_count,",
      "  sum(CASE WHEN t.state = 'processing' THEN 1 ELSE 0 END) AS processing_count,",
      "  sum(CASE WHEN t.state = 'failed' AND t.attempts < " + String(SLOW_PATH_MAX_ATTEMPTS) + " THEN 1 ELSE 0 END) AS retry_set,",
      "  sum(CASE WHEN t.state = 'failed' AND t.attempts >= " + String(SLOW_PATH_MAX_ATTEMPTS) + " THEN 1 ELSE 0 END) AS exhausted,",
      '  max(t.window_round) AS max_round',
    ].join('\n'),
  )
  const row = rows[0] ?? {}
  const processing = Number(row.processing_count ?? 0)
  const pending = Number(row.pending_count ?? 0)
  return {
    depth: pending + processing,
    retrySet: Number(row.retry_set ?? 0),
    exhausted: Number(row.exhausted ?? 0),
    deadLetters: Number(row.exhausted ?? 0),
    windowRound: Number(row.max_round ?? 0),
    shortCircuited: false,
  }
}

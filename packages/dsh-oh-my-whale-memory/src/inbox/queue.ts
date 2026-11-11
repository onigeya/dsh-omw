/**
 * INBOX FIFO 队列原语（Story 2.2 / AD-6、NFR7）。
 *
 * 表 `l1_inbox`（表名与既有五张表同一 snake_case 约定）是队列的**唯一持久事实源**：
 * - 一条条目一行，状态机 pending → processing(lease) → done|failed；
 * - FIFO 顺序 = (enqueued_at ASC, id ASC)（时间列一律 UTC ISO-8601 字符串，可直接字典序比较）；
 * - lease_owner 记进程 id、lease_until 记 take 时刻 + 60s（AD-6）；
 * - 失败 attempts 累加，超过 INBOX_MAX_RETRIES 进 failed 死信（Q-4）。
 *
 * 取队头是「读队头 + 条件写 lease」两步，但**两条语句在同一个 runInTransaction 里**：
 * 同一连接上的所有事务由 transaction.ts 的 per-connection promise 链串行化，跨进程由写者
 * 文件锁保证只有一个写者，故不存在 read-then-write 竞态。
 */
import { randomUUID } from 'node:crypto'
import type * as lbug from '@ladybugdb/core'
import { collectRows } from '../db/rows.js'
import { L1_INBOX_TABLE, createL1InboxTableStatement } from '../db/schema.js'
import { runInTransaction } from '../db/transaction.js'

export type InboxConnection = lbug.Connection

export const INBOX_STATUS_PENDING = 'pending'
export const INBOX_STATUS_PROCESSING = 'processing'
export const INBOX_STATUS_DONE = 'done'
export const INBOX_STATUS_FAILED = 'failed'

export type InboxStatus =
  | typeof INBOX_STATUS_PENDING
  | typeof INBOX_STATUS_PROCESSING
  | typeof INBOX_STATUS_DONE
  | typeof INBOX_STATUS_FAILED

export const INBOX_STATUSES: readonly InboxStatus[] = [
  INBOX_STATUS_PENDING,
  INBOX_STATUS_PROCESSING,
  INBOX_STATUS_DONE,
  INBOX_STATUS_FAILED,
]

/** lease 时长（AD-6：now() + 60s）。 */
export const INBOX_LEASE_MS = 60_000
/**
 * 重试上限（U23 口径）：`attempts` = **累计失败次数**——第 1..3 次失败回 pending 重试，
 * 第 4 次失败（`attempts > INBOX_MAX_RETRIES`）进 failed 死信（Q-4 / AD-6）。
 */
export const INBOX_MAX_RETRIES = 3
/** 死信 stale 基准（AC4：24h 未成功）。 */
export const INBOX_FAILED_STALE_MS = 24 * 60 * 60 * 1000
/** `/memory status` 展示的最近死信条数（AC4：最近 5 条）。 */
export const INBOX_FAILED_VIEW_LIMIT = 5
/** last_error 落库长度上限：错误摘要，不是日志转储。 */
export const INBOX_LAST_ERROR_MAX_CHARS = 500

export interface InboxItem {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  readonly payload: string
  readonly status: InboxStatus
  readonly attempts: number
  readonly leaseOwner: string | null
  readonly leaseUntil: string | null
  readonly enqueuedAt: string
  readonly updatedAt: string
  readonly lastError: string | null
}

/** 死信视图条目（AC4）：stale = 进入 failed 起已超过 INBOX_FAILED_STALE_MS。 */
export interface InboxFailedItem {
  readonly id: string
  readonly kind: string
  readonly attempts: number
  readonly lastError: string | null
  readonly updatedAt: string
  readonly stale: boolean
}

export interface InboxItemInput {
  readonly payload: string
  /** 归属会话 id（提升触发按会话聚合，Story 2.5 用）。 */
  readonly sessionId?: string
  /** 七类分类之一，缺省空串。 */
  readonly kind?: string
  /** 入队时间，默认 now。 */
  readonly now?: Date
  /** 条目 id，缺省 randomUUID（测试可注入固定 id 钉住 FIFO 次序）。 */
  readonly id?: string
}

const COLUMNS = [
  'q.id AS id',
  'q.session_id AS session_id',
  'q.kind AS kind',
  'q.payload AS payload',
  'q.status AS status',
  'q.attempts AS attempts',
  'q.lease_owner AS lease_owner',
  'q.lease_until AS lease_until',
  'q.enqueued_at AS enqueued_at',
  'q.updated_at AS updated_at',
  'q.last_error AS last_error',
].join(', ')

/** 入队：id 是 randomUUID（或调用方注入的确定性 id），MERGE 只为幂等，不会覆盖既有行。 */
const INSERT_ITEM = [
  'MERGE (q:' + L1_INBOX_TABLE + ' {id: $id})',
  '  ON CREATE SET q.session_id = $session_id, q.kind = $kind, q.payload = $payload,',
  '    q.status = $status, q.attempts = $attempts, q.lease_owner = $lease_owner,',
  '    q.lease_until = $lease_until, q.enqueued_at = $enqueued_at, q.updated_at = $updated_at,',
  '    q.last_error = $last_error',
].join('')

const CLAIM_HEAD = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $pending',
  'RETURN ' + COLUMNS,
  'ORDER BY q.enqueued_at ASC, q.id ASC LIMIT 1',
].join(' ')

/** 带游标的取队头：跳过本轮已尝试过的条目（失败回 pending 后不在同一轮被重复取出）。 */
const CLAIM_HEAD_AFTER = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $pending',
  '  AND (q.enqueued_at > $after_enqueued_at',
  '       OR (q.enqueued_at = $after_enqueued_at AND q.id > $after_id))',
  'RETURN ' + COLUMNS,
  'ORDER BY q.enqueued_at ASC, q.id ASC LIMIT 1',
].join(' ')

/** 条件写 lease：status 仍是 pending 才生效（拿不到行 = 竞态，本轮放弃）。 */
const CLAIM_MARK = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.id = $id AND q.status = $pending',
  'SET q.status = $processing, q.lease_owner = $lease_owner,',
  '    q.lease_until = $lease_until, q.updated_at = $updated_at',
  'RETURN q.id AS id',
].join(' ')

const READ_ONE = 'MATCH (q:' + L1_INBOX_TABLE + ') WHERE q.id = $id RETURN ' + COLUMNS

const COMPLETE = [
  'MATCH (q:' + L1_INBOX_TABLE + ') WHERE q.id = $id',
  'SET q.status = $done, q.lease_owner = null, q.lease_until = null, q.updated_at = $updated_at',
  'RETURN q.id AS id',
].join(' ')

/** 一轮失败：attempts+1，未超限回 pending（可重试）、超限进 failed（死信）。 */
const FAIL_TEMPLATE = [
  'MATCH (q:' + L1_INBOX_TABLE + ') WHERE q.id = $id',
  'SET q.status = $status, q.attempts = $attempts, q.lease_owner = null,',
  '    q.lease_until = null, q.last_error = $last_error, q.updated_at = $updated_at',
  'RETURN q.id AS id',
].join(' ')

/** 启动回收：lease_until < now 的 processing 条目回 pending（活着的持有者不被抢）。 */
const RECLAIM_EXPIRED = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $processing AND q.lease_until < $now',
  'SET q.status = $pending, q.lease_owner = null, q.lease_until = null, q.updated_at = $now',
  'RETURN q.id AS id',
].join(' ')

/** 写者启动回收（AC3 超集，U7）：见 reclaimProcessingInboxItems。 */
const RECLAIM_PROCESSING = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $processing',
  'SET q.status = $pending, q.lease_owner = null, q.lease_until = null, q.updated_at = $now',
  'RETURN q.id AS id',
].join(' ')

const COUNT_BY_STATUS = 'MATCH (q:' + L1_INBOX_TABLE + ') RETURN q.status AS status, count(q) AS total'

const LIST_FAILED = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $failed',
  'RETURN ' + COLUMNS,
  // id 只做同一毫秒（updated_at 相同）的并列次序，让死信视图完全确定（可断言）。
  'ORDER BY q.updated_at DESC, q.id ASC LIMIT $limit',
].join(' ')

/** 参数化读：一律 prepare + execute（与 memory.ts 同一套形态）。 */
async function queryRows(
  connection: InboxConnection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

function nullishToString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toInboxItem(row: Record<string, unknown>): InboxItem {
  return {
    id: String(row.id),
    sessionId: String(row.session_id ?? ''),
    kind: String(row.kind ?? ''),
    payload: String(row.payload ?? ''),
    status: String(row.status ?? '') as InboxStatus,
    attempts: Number(row.attempts ?? 0),
    leaseOwner: nullishToString(row.lease_owner),
    leaseUntil: nullishToString(row.lease_until),
    enqueuedAt: String(row.enqueued_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    lastError: nullishToString(row.last_error),
  }
}

/**
 * 建 INBOX 队列表（唯一迁移点由 src/db/database.ts 调用；范式同 audit.ts 的 ensureAuditTables：
 * DDL 在事务内执行，失败即整体回滚）。
 */
export async function ensureInboxTables(connection: InboxConnection): Promise<void> {
  await runInTransaction(connection, async () => {
    await connection.query(createL1InboxTableStatement())
  })
}

/** 错误摘要（落 last_error 列 + 日志；截断到 INBOX_LAST_ERROR_MAX_CHARS）。 */
export function inboxErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > INBOX_LAST_ERROR_MAX_CHARS ? message.slice(0, INBOX_LAST_ERROR_MAX_CHARS) : message
}

/**
 * 入队一条待精炼条目，返回其 id（缺省 randomUUID；同 id 重复入队幂等，不覆盖既有行）。
 *
 * **自带事务**，因此不得在已有事务内调用——Story 2.2 起 runInTransaction 对同一 async 链的
 * 重入直接抛错。需要「与其它写入同事务」的调用方得自己用「由调用方开事务」的插入语句；
 * 本函数是单条入队的便利包装，不做事务内检测。
 */
export async function enqueueInboxItem(
  connection: InboxConnection,
  input: InboxItemInput,
): Promise<string> {
  const id = input.id ?? randomUUID()
  const now = (input.now ?? new Date()).toISOString()
  await runInTransaction(connection, async () => {
    await queryRows(connection, INSERT_ITEM, {
      id,
      session_id: input.sessionId ?? '',
      kind: input.kind ?? '',
      payload: input.payload,
      status: INBOX_STATUS_PENDING,
      attempts: 0,
      lease_owner: null,
      lease_until: null,
      enqueued_at: now,
      updated_at: now,
      last_error: null,
    })
  })
  return id
}

export interface ClaimInboxOptions {
  /** lease 持有者标识，缺省进程 id（AC1）。 */
  readonly owner?: string
  readonly now?: Date
  /** lease 时长，缺省 INBOX_LEASE_MS（60s）。 */
  readonly leaseMs?: number
  /** FIFO 游标：只取严格晚于该条目的队头（一轮内跳过已尝试条目）。 */
  readonly after?: { readonly enqueuedAt: string; readonly id: string }
}

/**
 * 取队头并**在同一事务内**写 lease（AC1）：返回条目时它已处于 processing、
 * lease_owner = owner、lease_until = now + leaseMs。队空返回 null（不写库）。
 */
export async function claimNextInboxItem(
  connection: InboxConnection,
  options: ClaimInboxOptions = {},
): Promise<InboxItem | null> {
  const owner = options.owner ?? String(process.pid)
  const now = options.now ?? new Date()
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? INBOX_LEASE_MS)).toISOString()
  const updatedAt = now.toISOString()
  return runInTransaction(connection, async () => {
    const rows = options.after
      ? await queryRows(connection, CLAIM_HEAD_AFTER, {
        pending: INBOX_STATUS_PENDING,
        after_enqueued_at: options.after.enqueuedAt,
        after_id: options.after.id,
      })
      : await queryRows(connection, CLAIM_HEAD, { pending: INBOX_STATUS_PENDING })
    const row = rows[0]
    if (!row) return null
    const item = toInboxItem(row)
    const claimed = await queryRows(connection, CLAIM_MARK, {
      id: item.id,
      pending: INBOX_STATUS_PENDING,
      processing: INBOX_STATUS_PROCESSING,
      lease_owner: owner,
      lease_until: leaseUntil,
      updated_at: updatedAt,
    })
    if (claimed.length === 0) return null
    return { ...item, status: INBOX_STATUS_PROCESSING, leaseOwner: owner, leaseUntil, updatedAt }
  })
}

/** 标 done 并清 lease（AC2）。条目不存在返回 false（不静默 no-op）。 */
export async function completeInboxItem(
  connection: InboxConnection,
  id: string,
  options: { readonly now?: Date } = {},
): Promise<boolean> {
  const updatedAt = (options.now ?? new Date()).toISOString()
  return runInTransaction(connection, async () => {
    const rows = await queryRows(connection, COMPLETE, {
      id,
      done: INBOX_STATUS_DONE,
      updated_at: updatedAt,
    })
    return rows.length > 0
  })
}

export interface FailInboxResult {
  readonly status: typeof INBOX_STATUS_PENDING | typeof INBOX_STATUS_FAILED
  readonly attempts: number
}

/**
 * 记一次失败：attempts+1；未超 INBOX_MAX_RETRIES 回 pending（下轮重试），
 * 超限进 failed 死信（AC4）。返回值即落库后的状态。
 */
export async function failInboxItem(
  connection: InboxConnection,
  id: string,
  options: { readonly error: unknown; readonly now?: Date },
): Promise<FailInboxResult> {
  const updatedAt = (options.now ?? new Date()).toISOString()
  const lastError = inboxErrorText(options.error)
  return runInTransaction(connection, async () => {
    const rows = await queryRows(connection, READ_ONE, { id })
    const row = rows[0]
    if (!row) throw new Error('INBOX 条目不存在（id=' + id + '）：无法记录失败')
    const attempts = Number(row.attempts ?? 0) + 1
    const status = attempts > INBOX_MAX_RETRIES ? INBOX_STATUS_FAILED : INBOX_STATUS_PENDING
    const written = await queryRows(connection, FAIL_TEMPLATE, {
      id,
      status,
      attempts,
      last_error: lastError,
      updated_at: updatedAt,
    })
    if (written.length === 0) throw new Error('INBOX 条目失败状态未落库（id=' + id + '）')
    return { status, attempts }
  })
}

/**
 * 启动回收（AC3）：lease_until < now 的 processing 条目回 pending，lease 清空、attempts 保留。
 * 返回回收条数。lease 未过期的在跑持有者不被抢。
 */
export async function reclaimExpiredLeases(
  connection: InboxConnection,
  options: { readonly now?: Date } = {},
): Promise<number> {
  const now = (options.now ?? new Date()).toISOString()
  return runInTransaction(connection, async () => {
    const rows = await queryRows(connection, RECLAIM_EXPIRED, {
      processing: INBOX_STATUS_PROCESSING,
      pending: INBOX_STATUS_PENDING,
      now,
    })
    return rows.length
  })
}

/**
 * 写者启动回收（AC3 的**超集**，U7）：把**全部** processing 条目回 pending，不等 lease 过期。
 *
 * 依据 AD-12：写者文件锁保证同一库同一时刻只有一个写进程，故写者启动那一刻看到的任何
 * processing 行必然属于已死进程（本进程刚启动，不可能有在飞条目）。若只回收 `lease_until < now`，
 * 「T 崩溃、T+20s 重启（lease 到 T+60）」的条目会卡在 processing 直到**下一次**重启才自愈。
 *
 * 刻意**不做**周期性回收：活进程内的周期回收会在「任务时长 > lease(60s)」时抢走自己正在处理的
 * 条目（同进程重复精炼）。lease 与任务最坏时长的关系属 Story 2.3 契约（需续租或收紧 lease）。
 *
 * reclaimExpiredLeases 保留原语义（活着的持有者不被抢），供运行期/测试使用。
 */
export async function reclaimProcessingInboxItems(
  connection: InboxConnection,
  options: { readonly now?: Date } = {},
): Promise<number> {
  const now = (options.now ?? new Date()).toISOString()
  return runInTransaction(connection, async () => {
    const rows = await queryRows(connection, RECLAIM_PROCESSING, {
      processing: INBOX_STATUS_PROCESSING,
      pending: INBOX_STATUS_PENDING,
      now,
    })
    return rows.length
  })
}

/** 按状态计数（缺失状态补 0）；只发一条聚合语句，未出现在结果里的状态留 0。 */
export async function countInboxByStatus(
  connection: InboxConnection,
): Promise<Record<InboxStatus, number>> {
  const counts = {
    [INBOX_STATUS_PENDING]: 0,
    [INBOX_STATUS_PROCESSING]: 0,
    [INBOX_STATUS_DONE]: 0,
    [INBOX_STATUS_FAILED]: 0,
  } as Record<InboxStatus, number>
  const rows = await queryRows(connection, COUNT_BY_STATUS, {})
  for (const row of rows) {
    const status = String(row.status ?? '')
    if ((INBOX_STATUSES as readonly string[]).includes(status)) {
      counts[status as InboxStatus] += Number(row.total ?? 0)
    }
  }
  return counts
}

/** 最近失败条目（updated_at 倒序，最多 limit 条）+ stale 标注（AC4）。 */
export async function listRecentFailedInboxItems(
  connection: InboxConnection,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<InboxFailedItem[]> {
  const now = (options.now ?? new Date()).getTime()
  const limit = Math.max(0, Math.trunc(options.limit ?? INBOX_FAILED_VIEW_LIMIT))
  if (limit === 0) return []
  const rows = await queryRows(connection, LIST_FAILED, { failed: INBOX_STATUS_FAILED, limit })
  return rows.map((row) => {
    const updatedAt = String(row.updated_at ?? '')
    const at = Date.parse(updatedAt)
    return {
      id: String(row.id ?? ''),
      kind: String(row.kind ?? ''),
      attempts: Number(row.attempts ?? 0),
      lastError: nullishToString(row.last_error),
      updatedAt,
      stale: Number.isFinite(at) ? now - at > INBOX_FAILED_STALE_MS : false,
    }
  })
}

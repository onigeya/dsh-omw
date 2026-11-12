/**
 * INBOX FIFO 队列原语（Story 2.2 / AD-6、NFR7）。
 *
 * 表 `l1_inbox`（表名与既有五张表同一 snake_case 约定）是队列的**唯一持久事实源**：
 * - 一条条目一行，状态机 pending → processing(lease) → done|failed；
 * - FIFO 顺序 = (enqueued_at ASC, id ASC)（时间列一律 UTC ISO-8601 字符串，可直接字典序比较）；
 * - lease_owner 记进程 id、lease_until 记 take 时刻 + 60s（AD-6）；
 * - **lease_until 复用为「最早可取件时刻」（Story 2.3 / R3①）**：processing 行上它是 lease 到期时刻，
 *   pending 行上它是**退避截止**——失败回 pending 时写 now + backoff(attempts)，取件谓词据此跳过未到期条目；
 * - 失败 attempts 累加，超过 INBOX_MAX_RETRIES 进 failed 死信（Q-4）。
 *
 * 取队头是「读队头 + 条件写 lease」两步，但**两条语句在同一个 runInTransaction 里**：
 * 同一连接上的所有事务由 transaction.ts 的 per-connection promise 链串行化，跨进程由写者
 * 文件锁保证只有一个写者，故不存在 read-then-write 竞态。
 *
 * Story 2.5 / U1（泛化）：同一套状态机由 L1 精炼队列与 L2 提升队列共用，只有表名不同，
 * 故语句集由 {@link createInboxStatements} 按表名生成、API 由 {@link createInboxQueue} 绑定。
 * **表名只取自 src/db/schema.ts 的常量**（绝不接受外部输入——那是把用户数据拼进 DDL 的口子）。
 * 文件末尾的既有导出名一律保留为绑定 `l1_inbox` 的薄包装：2.2 起的调用点与测试零改动。
 */
import { randomUUID } from 'node:crypto'
import type * as lbug from '@ladybugdb/core'
import { collectRows } from '../db/rows.js'
import { L1_INBOX_TABLE, L2_INBOX_TABLE, createInboxTableStatement } from '../db/schema.js'
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
/**
 * 失败退避基准（Story 2.3 / R3①）：第 n 次失败后最早可取件时刻 = now + min(5s × 2^(n-1), 120s)
 * （§14 的 5–120s 指数退避）。退避落在 pending 行的 lease_until 上，不新增列。
 */
export const INBOX_BACKOFF_BASE_MS = 5_000
export const INBOX_BACKOFF_MAX_MS = 120_000
/** 启动回收写进 last_error 的固定说明（Story 2.3 / R3②）。 */
export const INBOX_RECLAIM_ERROR = 'reclaimed after crash'

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
  /**
   * 条目生产者的标签：Story 2.1 写采集来源（step|turn|compaction）；七类记忆 kind 是
   * **写路径**（工具/命令）的合法域，精炼后由写路径决定节点 kind（评审 P7）。
   */
  readonly kind?: string
  /** 入队时间，默认 now。 */
  readonly now?: Date
  /** 条目 id，缺省 randomUUID（测试可注入固定 id 钉住 FIFO 次序）。 */
  readonly id?: string
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

export interface FailInboxResult {
  /** 落库后的状态；条目本就不在 processing 时原样返回其当前状态（N8 no-op）。 */
  readonly status: InboxStatus
  readonly attempts: number
}

export interface FailInboxOptions {
  readonly error: unknown
  readonly now?: Date
  /**
   * true = 语义错（4xx / 输出截断），首次即降级、不再退避重试：直接进 failed 死信（AC:581）。
   * 缺省 false = 瞬时失败，走 §14 的 5–120s 指数退避。
   */
  readonly fatal?: boolean
}

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

/**
 * 一张队列表的全部语句（Story 2.5 / U1 泛化点）：这里**只**做表名替换，
 * 语义与 2.2 的 `l1_inbox` 单表版本逐字相同。
 */
interface InboxStatements {
  readonly table: string
  readonly insertItem: string
  readonly claimHead: string
  readonly claimHeadAfter: string
  readonly claimMark: string
  readonly readOne: string
  readonly complete: string
  readonly failTemplate: string
  readonly reclaimExpired: string
  readonly reclaimProcessing: string
  readonly countByStatus: string
  readonly countBusy: string
  readonly listFailed: string
}

function createInboxStatements(table: string): InboxStatements {
  const INSERT_ITEM = [
    'MERGE (q:' + table + ' {id: $id})',
    '  ON CREATE SET q.session_id = $session_id, q.kind = $kind, q.payload = $payload,',
    '    q.status = $status, q.attempts = $attempts, q.lease_owner = $lease_owner,',
    '    q.lease_until = $lease_until, q.enqueued_at = $enqueued_at, q.updated_at = $updated_at,',
    '    q.last_error = $last_error',
  ].join('')

  const CLAIM_HEAD = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $pending',
    '  AND (q.lease_until IS NULL OR q.lease_until <= $now)',
    'RETURN ' + COLUMNS,
    'ORDER BY q.enqueued_at ASC, q.id ASC LIMIT 1',
  ].join(' ')

  /** 带游标的取队头：跳过本轮已尝试过的条目（失败回 pending 后不在同一轮被重复取出）。 */
  const CLAIM_HEAD_AFTER = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $pending',
    '  AND (q.lease_until IS NULL OR q.lease_until <= $now)',
    '  AND (q.enqueued_at > $after_enqueued_at',
    '       OR (q.enqueued_at = $after_enqueued_at AND q.id > $after_id))',
    'RETURN ' + COLUMNS,
    'ORDER BY q.enqueued_at ASC, q.id ASC LIMIT 1',
  ].join(' ')

  /** 条件写 lease：status 仍是 pending 才生效（拿不到行 = 竞态，本轮放弃）。 */
  const CLAIM_MARK = [
    'MATCH (q:' + table + ')',
    'WHERE q.id = $id AND q.status = $pending',
    'SET q.status = $processing, q.lease_owner = $lease_owner,',
    '    q.lease_until = $lease_until, q.updated_at = $updated_at',
    'RETURN q.id AS id',
  ].join(' ')

  const READ_ONE = 'MATCH (q:' + table + ') WHERE q.id = $id RETURN ' + COLUMNS

  const COMPLETE = [
    'MATCH (q:' + table + ') WHERE q.id = $id AND q.status = $processing',
    'SET q.status = $done, q.lease_owner = null, q.lease_until = null, q.updated_at = $updated_at',
    'RETURN q.id AS id',
  ].join(' ')

  /** 一轮失败：attempts+1，未超限回 pending（可重试）、超限进 failed（死信）。 */
  const FAIL_TEMPLATE = [
    'MATCH (q:' + table + ') WHERE q.id = $id AND q.status = $processing',
    'SET q.status = $status, q.attempts = $attempts, q.lease_owner = null,',
    '    q.lease_until = $lease_until, q.last_error = $last_error, q.updated_at = $updated_at',
    'RETURN q.id AS id',
  ].join(' ')

  /** 启动回收：lease_until < now 的 processing 条目回 pending（活着的持有者不被抢）。 */
  const RECLAIM_EXPIRED = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $processing AND q.lease_until < $now',
    'SET q.status = $pending, q.lease_owner = null, q.lease_until = null, q.updated_at = $now',
    'RETURN q.id AS id',
  ].join(' ')

  /**
   * 写者启动回收（R3②）：崩溃是一次失败——attempts+1 并记 last_error，达上限直接进 failed 死信，
   * 否则回 pending（不退避：进程刚重启，重试立即进行是期望行为）。
   */
  const RECLAIM_PROCESSING = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $processing',
    'SET q.status = CASE WHEN q.attempts + 1 > $max_retries THEN $failed ELSE $pending END,',
    '    q.attempts = q.attempts + 1, q.last_error = $reclaim_error,',
    '    q.lease_owner = null, q.lease_until = null, q.updated_at = $now',
    'RETURN q.id AS id',
  ].join(' ')

  const COUNT_BY_STATUS = 'MATCH (q:' + table + ') RETURN q.status AS status, count(q) AS total'

  /**
   * 「这张表还有活儿要干吗」（Story 2.5 / 评审 P6+P6b）：processing 中的条目算忙，
   * 且 **pending 只有「现在就能取」才算忙** —— 退避把 pending 的 lease_until 写到未来
   * （最长 INBOX_BACKOFF_MAX_MS=120s），那些窗口不该让 L2 慢循环停摆。
   */
  const COUNT_BUSY = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $processing',
    '   OR (q.status = $pending AND (q.lease_until IS NULL OR q.lease_until <= $now))',
    'RETURN count(q) AS total',
  ].join(' ')

  const LIST_FAILED = [
    'MATCH (q:' + table + ')',
    'WHERE q.status = $failed',
    'RETURN ' + COLUMNS,
    // id 只做同一毫秒（updated_at 相同）的并列次序，让死信视图完全确定（可断言）。
    'ORDER BY q.updated_at DESC, q.id ASC LIMIT $limit',
  ].join(' ')

  return {
    table,
    insertItem: INSERT_ITEM,
    claimHead: CLAIM_HEAD,
    claimHeadAfter: CLAIM_HEAD_AFTER,
    claimMark: CLAIM_MARK,
    readOne: READ_ONE,
    complete: COMPLETE,
    failTemplate: FAIL_TEMPLATE,
    reclaimExpired: RECLAIM_EXPIRED,
    reclaimProcessing: RECLAIM_PROCESSING,
    countByStatus: COUNT_BY_STATUS,
    countBusy: COUNT_BUSY,
    listFailed: LIST_FAILED,
  }
}

/** 一个队列实例的能力面（表名在创建时绑定）。 */
export interface InboxQueue {
  readonly table: string
  /** 建表（唯一迁移点由 src/db/database.ts 调用；DDL 在事务内执行，失败即整体回滚）。 */
  ensureTables(connection: InboxConnection): Promise<void>
  /** 在**调用方已开启的事务**内入队（采集侧「L0 行 + INBOX 行」同事务用）。 */
  writeItem(connection: InboxConnection, input: InboxItemInput): Promise<string>
  /** 入队的便利包装：**自带事务**，不得在已有事务内调用。 */
  enqueue(connection: InboxConnection, input: InboxItemInput): Promise<string>
  claimNext(connection: InboxConnection, options?: ClaimInboxOptions): Promise<InboxItem | null>
  /** 标 done，**由调用方开事务**；带 processing 守卫（at-most-once 的支点）。 */
  markDone(connection: InboxConnection, id: string, options?: { readonly now?: Date }): Promise<boolean>
  /** 标 done 的便利包装：自带事务。 */
  complete(connection: InboxConnection, id: string, options?: { readonly now?: Date }): Promise<boolean>
  readStatus(connection: InboxConnection, id: string): Promise<InboxStatus | null>
  fail(connection: InboxConnection, id: string, options: FailInboxOptions): Promise<FailInboxResult>
  reclaimExpired(connection: InboxConnection, options?: { readonly now?: Date }): Promise<number>
  reclaimProcessing(connection: InboxConnection, options?: { readonly now?: Date }): Promise<number>
  countByStatus(connection: InboxConnection): Promise<Record<InboxStatus, number>>
  /**
   * 还有「现在就该干」的活儿吗（processing，或 lease 已到期的 pending）。
   * Story 2.5 的 L2 慢循环用它给 L1 主路径让路（评审 P6+P6b）。
   */
  countBusy(connection: InboxConnection, options?: { readonly now?: Date }): Promise<number>
  listRecentFailed(
    connection: InboxConnection,
    options?: { readonly now?: Date; readonly limit?: number },
  ): Promise<InboxFailedItem[]>
}

/**
 * 建一个绑定到 `table` 的队列实例。
 *
 * 复用与查表：
 * - L1 精炼队列 = {@link l1InboxQueue}（`l1_inbox`，2.2 起的主路径）；
 * - L2 提升队列 = {@link l2InboxQueue}（`l2_inbox`，Story 2.5 / U1）。
 *
 * **表名不来自用户输入**：调用方只应传 src/db/schema.ts 导出的表名常量。
 */
export function createInboxQueue(table: string): InboxQueue {
  const statements = createInboxStatements(table)

  const writeItem = async (connection: InboxConnection, input: InboxItemInput): Promise<string> => {
    const id = input.id ?? randomUUID()
    const now = (input.now ?? new Date()).toISOString()
    await queryRows(connection, statements.insertItem, {
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
    return id
  }

  const markDone = async (
    connection: InboxConnection,
    id: string,
    options: { readonly now?: Date } = {},
  ): Promise<boolean> => {
    const updatedAt = (options.now ?? new Date()).toISOString()
    const rows = await queryRows(connection, statements.complete, {
      id,
      processing: INBOX_STATUS_PROCESSING,
      done: INBOX_STATUS_DONE,
      updated_at: updatedAt,
    })
    return rows.length > 0
  }

  const reclaim = async (
    connection: InboxConnection,
    statement: string,
    params: Record<string, lbug.LbugValue>,
  ): Promise<number> => {
    return runInTransaction(connection, async () => {
      const rows = await queryRows(connection, statement, params)
      return rows.length
    })
  }

  return {
    table,
    async ensureTables(connection) {
      await runInTransaction(connection, async () => {
        await connection.query(createInboxTableStatement(table))
      })
    },
    writeItem,
    async enqueue(connection, input) {
      return runInTransaction(connection, () => writeItem(connection, input))
    },
    async claimNext(connection, options = {}) {
      const owner = options.owner ?? String(process.pid)
      const now = options.now ?? new Date()
      const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? INBOX_LEASE_MS)).toISOString()
      const updatedAt = now.toISOString()
      return runInTransaction(connection, async () => {
        const rows = options.after
          ? await queryRows(connection, statements.claimHeadAfter, {
            pending: INBOX_STATUS_PENDING,
            now: updatedAt,
            after_enqueued_at: options.after.enqueuedAt,
            after_id: options.after.id,
          })
          : await queryRows(connection, statements.claimHead, { pending: INBOX_STATUS_PENDING, now: updatedAt })
        const row = rows[0]
        if (!row) return null
        const item = toInboxItem(row)
        const claimed = await queryRows(connection, statements.claimMark, {
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
    },
    markDone,
    async complete(connection, id, options = {}) {
      return runInTransaction(connection, () => markDone(connection, id, options))
    },
    async readStatus(connection, id) {
      const rows = await queryRows(connection, statements.readOne, { id })
      const row = rows[0]
      return row ? (String(row.status ?? '') as InboxStatus) : null
    },
    async fail(connection, id, options) {
      const now = options.now ?? new Date()
      const updatedAt = now.toISOString()
      const lastError = inboxErrorText(options.error)
      return runInTransaction(connection, async () => {
        const rows = await queryRows(connection, statements.readOne, { id })
        const row = rows[0]
        if (!row) throw new Error('INBOX 条目不存在（id=' + id + '）：无法记录失败')
        const current = toInboxItem(row)
        if (current.status !== INBOX_STATUS_PROCESSING) return { status: current.status, attempts: current.attempts }
        const attempts = current.attempts + 1
        const status = options.fatal === true || attempts > INBOX_MAX_RETRIES
          ? INBOX_STATUS_FAILED
          : INBOX_STATUS_PENDING
        const written = await queryRows(connection, statements.failTemplate, {
          id,
          processing: INBOX_STATUS_PROCESSING,
          status,
          attempts,
          lease_until: status === INBOX_STATUS_PENDING
            ? new Date(now.getTime() + inboxBackoffMs(attempts)).toISOString()
            : null,
          last_error: lastError,
          updated_at: updatedAt,
        })
        // N8：语句带 status 守卫，同事务内刚读到 processing 故不应未命中；真未命中按 no-op 返回，
        // 不抛错——避免异常冲出消费者的 for 循环。
        if (written.length === 0) return { status: current.status, attempts: current.attempts }
        return { status, attempts }
      })
    },
    async reclaimExpired(connection, options = {}) {
      const now = options.now ?? new Date()
      return reclaim(connection, statements.reclaimExpired, {
        processing: INBOX_STATUS_PROCESSING,
        pending: INBOX_STATUS_PENDING,
        now: now.toISOString(),
      })
    },
    async reclaimProcessing(connection, options = {}) {
      const now = options.now ?? new Date()
      return reclaim(connection, statements.reclaimProcessing, {
        processing: INBOX_STATUS_PROCESSING,
        pending: INBOX_STATUS_PENDING,
        failed: INBOX_STATUS_FAILED,
        max_retries: INBOX_MAX_RETRIES,
        reclaim_error: INBOX_RECLAIM_ERROR,
        now: now.toISOString(),
      })
    },
    async countByStatus(connection) {
      const counts = {
        [INBOX_STATUS_PENDING]: 0,
        [INBOX_STATUS_PROCESSING]: 0,
        [INBOX_STATUS_DONE]: 0,
        [INBOX_STATUS_FAILED]: 0,
      } as Record<InboxStatus, number>
      const rows = await queryRows(connection, statements.countByStatus, {})
      for (const row of rows) {
        const status = String(row.status ?? '')
        if ((INBOX_STATUSES as readonly string[]).includes(status)) {
          counts[status as InboxStatus] += Number(row.total ?? 0)
        }
      }
      return counts
    },
    async countBusy(connection, options = {}) {
      const now = options.now ?? new Date()
      const rows = await queryRows(connection, statements.countBusy, {
        processing: INBOX_STATUS_PROCESSING,
        pending: INBOX_STATUS_PENDING,
        now: now.toISOString(),
      })
      return Number(rows[0]?.total ?? 0)
    },
    async listRecentFailed(connection, options = {}) {
      const now = (options.now ?? new Date()).getTime()
      const limit = Math.max(0, Math.trunc(options.limit ?? INBOX_FAILED_VIEW_LIMIT))
      if (limit === 0) return []
      const rows = await queryRows(connection, statements.listFailed, {
        failed: INBOX_STATUS_FAILED,
        limit,
      })
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
    },
  }
}

/** L1 精炼队列（`l1_inbox`）：Story 2.2 起的主路径。 */
export const l1InboxQueue: InboxQueue = createInboxQueue(L1_INBOX_TABLE)
/** L2 提升队列（`l2_inbox`）：Story 2.5 / U1。 */
export const l2InboxQueue: InboxQueue = createInboxQueue(L2_INBOX_TABLE)

/** 错误摘要（落 last_error 列 + 日志；截断到 INBOX_LAST_ERROR_MAX_CHARS）。 */
export function inboxErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > INBOX_LAST_ERROR_MAX_CHARS ? message.slice(0, INBOX_LAST_ERROR_MAX_CHARS) : message
}

/**
 * 建 INBOX 队列表（唯一迁移点由 src/db/database.ts 调用；范式同 audit.ts 的 ensureAuditTables：
 * DDL 在事务内执行，失败即整体回滚）。
 */
export async function ensureInboxTables(connection: InboxConnection): Promise<void> {
  await l1InboxQueue.ensureTables(connection)
}

/** 建 L2 提升队列表（Story 2.5 / U1）：与 l1_inbox 同列同状态机。 */
export async function ensureL2InboxTables(connection: InboxConnection): Promise<void> {
  await l2InboxQueue.ensureTables(connection)
}

/**
 * 在**调用方已开启的事务**内入队一条条目，返回其 id（Story 2.1 抽出）。
 *
 * 写入语义与 INSERT_ITEM 完全一致：MERGE ... ON CREATE SET，只创建、不更新——同 id 重复入队
 * 不会覆盖既有行的 status/attempts/lease。调用方注入确定性 id（采集侧用 uuid5('inbox:' + 稳定身份)）
 * 时，崩溃重放不会造出第二条队列条目。
 */
export async function writeInboxItem(
  connection: InboxConnection,
  input: InboxItemInput,
): Promise<string> {
  return l1InboxQueue.writeItem(connection, input)
}

/**
 * 入队一条待精炼条目，返回其 id（缺省 randomUUID；同 id 重复入队幂等，不覆盖既有行）。
 *
 * **自带事务**，因此不得在已有事务内调用——Story 2.2 起 runInTransaction 对同一 async 链的
 * 重入直接抛错。需要「与其它写入同事务」的调用方请用 writeInboxItem（由调用方开事务），
 * 例如采集侧的「L0 行 + INBOX 行」同一事务（Story 2.1）。本函数是它的单条便利包装。
 */
export async function enqueueInboxItem(
  connection: InboxConnection,
  input: InboxItemInput,
): Promise<string> {
  return l1InboxQueue.enqueue(connection, input)
}

/**
 * 取队头并**在同一事务内**写 lease（AC1）：返回条目时它已处于 processing、
 * lease_owner = owner、lease_until = now + leaseMs。队空返回 null（不写库）。
 */
export async function claimNextInboxItem(
  connection: InboxConnection,
  options: ClaimInboxOptions = {},
): Promise<InboxItem | null> {
  return l1InboxQueue.claimNext(connection, options)
}

/**
 * 标 done 并清 lease（AC2），**由调用方开事务**（Story 2.3 / R1 抽出的连接级原语）。
 *
 * 带 `status = processing` 守卫：只有**正在处理**的条目能转 done；返回 false 表示未命中
 * （条目已被处理过、或状态不符）。精炼成功路径把本原语与产出写在同一事务里，靠这次条件
 * 转换实现 at-most-once（U12：崩溃重放不重复产出）。
 */
export async function markInboxItemDone(
  connection: InboxConnection,
  id: string,
  options: { readonly now?: Date } = {},
): Promise<boolean> {
  return l1InboxQueue.markDone(connection, id, options)
}

/**
 * 标 done 的便利包装：自带事务。语义与 2.2 相同（条目不存在 / 未在处理中返回 false，
 * 不静默 no-op）——2.2 的调用方与测试无需改动。
 */
export async function completeInboxItem(
  connection: InboxConnection,
  id: string,
  options: { readonly now?: Date } = {},
): Promise<boolean> {
  return l1InboxQueue.complete(connection, id, options)
}

/**
 * 读一条条目的当前状态；条目不存在返回 null（不抛错）。
 *
 * 供精炼处理器的入口守卫用（评审 T7）：失败分支的记账在 `markInboxItemDone` 之前，
 * 对已 done 的条目再跑一次 process 会多写审计行，违反 DONE_REPLAY 契约。
 * 只读，不开事务。
 */
export async function readInboxItemStatus(
  connection: InboxConnection,
  id: string,
): Promise<InboxStatus | null> {
  return l1InboxQueue.readStatus(connection, id)
}

/** 第 attempts 次失败后的退避（毫秒）：min(5s × 2^(attempts-1), 120s)（R3①）。 */
export function inboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.trunc(attempts) - 1)
  return Math.min(INBOX_BACKOFF_BASE_MS * 2 ** exponent, INBOX_BACKOFF_MAX_MS)
}

/**
 * 记一次失败：attempts+1；未超 INBOX_MAX_RETRIES 或非致命错则回 pending 并写退避截止
 * （`lease_until = now + backoff(attempts)`，R3①），超限/致命进 failed 死信（AC4）。
 *
 * 只有 **processing** 的条目才记失败（N8）：已 done / failed / pending 的行原样返回、不写库，
 * 这样「成功路径已 complete、异常兜底又调一次 fail」不会把已完成的条目打回 pending。
 */
export async function failInboxItem(
  connection: InboxConnection,
  id: string,
  options: FailInboxOptions,
): Promise<FailInboxResult> {
  return l1InboxQueue.fail(connection, id, options)
}

/**
 * 启动回收（AC3）：lease_until < now 的 processing 条目回 pending，lease 清空、attempts 保留。
 * 返回回收条数。lease 未过期的在跑持有者不被抢。
 */
export async function reclaimExpiredLeases(
  connection: InboxConnection,
  options: { readonly now?: Date } = {},
): Promise<number> {
  return l1InboxQueue.reclaimExpired(connection, options)
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
 *
 * Story 2.3 / R3②：启动回收把这次崩溃**记成一次失败**（attempts+1、last_error='reclaimed after crash'），
 * 达到 INBOX_MAX_RETRIES 的条目直接进 failed 死信——否则「精炼每次都以杀死进程告终」的条目会
 * 无限循环（U11）。
 */
export async function reclaimProcessingInboxItems(
  connection: InboxConnection,
  options: { readonly now?: Date } = {},
): Promise<number> {
  return l1InboxQueue.reclaimProcessing(connection, options)
}

/** 按状态计数（缺失状态补 0）；只发一条聚合语句，未出现在结果里的状态留 0。 */
export async function countInboxByStatus(
  connection: InboxConnection,
): Promise<Record<InboxStatus, number>> {
  return l1InboxQueue.countByStatus(connection)
}

/** 最近失败条目（updated_at 倒序，最多 limit 条）+ stale 标注（AC4）。 */
export async function listRecentFailedInboxItems(
  connection: InboxConnection,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<InboxFailedItem[]> {
  return l1InboxQueue.listRecentFailed(connection, options)
}

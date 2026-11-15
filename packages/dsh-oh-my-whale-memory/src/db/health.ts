/**
 * `/memory status` 的两个健康指标（Story 4.3 / FR-13、NFR8、AC:1083-1119）。
 *
 * 指标（语义见 spec 的「指标语义」）：
 * - `inboxBacklog`：当前时刻 − 最老 `pending|processing` 条目的 `enqueued_at`，两条队列各算一份，
 *   渲染层取较大者。两队列都没有积压 ⇒ `none`（不是 0）。
 * - `lastRefineAt`：`l1_inbox` 里 `status='done'` 的最大 `updated_at`，逐字回显库内 ISO-8601。
 *
 * 三态用判别联合表达（`ok` / `none` / `missing-table` / `failed` / `budget`），本层只返回结构、
 * 不拼文案：命令层不 import db（AD-33 单向），渲染文案在 `src/command.ts` 的渲染函数里。
 *
 * 为什么只读 `l1_inbox` 而不读 `generation_log`（D-3）：审计表缺失时仍要能回答「上次精炼成功是
 * 什么时候」，且队列状态机与精炼成功是同一事实源。
 *
 * best-effort（AC:1105-1107）：每个采集点独立 try/catch，失败只影响自己那一项；累计耗时超出
 * 观测预算时，尚未采集的指标直接短路成 `budget`（D-4：本地同步 DB 读，不做真并发/超时中断）。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError, isMissingTableError } from './errors.js'
import { nullishString, queryRows } from './rows.js'
import { L1_INBOX_TABLE, L2_INBOX_TABLE } from './schema.js'

/** 观测预算（NFR8 / AC:1105-1107）：从采集开始起计，超出后未采集项渲染超时文案。 */
export const HEALTH_BUDGET_MS = 10_000

/**
 * INBOX 队列里「正在等活干」的两个状态。
 *
 * 字面量在此重复而不 import `src/inbox/queue.ts`：db 是最底层，反向 import inbox 会形成
 * `db ↔ inbox` 的目录级环（AD-33）。测试 `test/db-health.test.ts` 钉住它们与队列常量一致。
 */
const BACKLOG_STATUSES: readonly string[] = ['pending', 'processing']
/** 精炼完成态（同上，字面量避免 db → inbox 依赖）。 */
const REFINE_DONE_STATUS = 'done'

/**
 * 单个健康指标的三态。
 *
 * - `ok`：采到值；`none`：采集成功但事实为空（无积压 / 从未完成精炼），与 0 区分；
 * - `missing-table`：队列表不存在（与 `audit_gap: 未知` 同一「算不出来不报 0」约定）；
 * - `failed`：采集抛错（含列值不是合法时刻）；
 * - `budget`：超出 10s 观测预算，尚未采集。
 */
export type HealthMetric<T> =
  | { readonly status: 'ok', readonly value: T }
  | { readonly status: 'none' }
  | { readonly status: 'missing-table' }
  | { readonly status: 'failed' }
  | { readonly status: 'budget' }

/** 两路队列的积压时长（毫秒，已夹紧为非负）；null = 该队列无积压。 */
export interface InboxBacklog {
  readonly l1Ms: number | null
  readonly l2Ms: number | null
}

/**
 * 健康视图（命令层在 `src/command.ts` 有同形镜像 `MemoryHealthView`，两处字段必须一致）。
 *
 * 只有两个可采指标：`rerank_latency` 恒 `n/a`（v1 无精排，AD-16 归 v1.1），Epic 7 的两项
 * 真源在 Story 7.1 / 7.3，本 story 只占位、不采集，故它们不是本结构的字段。
 */
export interface MemoryHealthView {
  readonly inboxBacklog: HealthMetric<InboxBacklog>
  readonly lastRefineAt: HealthMetric<string>
}

export interface CollectHealthMetricsOptions {
  readonly connection: lbug.Connection
  /** 毫秒时钟（单调即可）；测试注入递增序列构造超预算。缺省 `Date.now`。 */
  readonly now?: () => number
  /** 观测预算，缺省 {@link HEALTH_BUDGET_MS}。 */
  readonly budgetMs?: number
}

/** 最老的待处理条目（FIFO 顺序即字典序）。 */
function oldestPendingStatement(table: string): string {
  return [
    'MATCH (q:' + table + ')',
    'WHERE q.status IN $statuses',
    'RETURN q.enqueued_at AS enqueued_at',
    'ORDER BY q.enqueued_at ASC LIMIT 1',
  ].join('\n')
}

/** 最近完成的一次精炼（`id` 只做同毫秒并列的确定性次序）。 */
const LAST_REFINE_STATEMENT = [
  'MATCH (q:' + L1_INBOX_TABLE + ')',
  'WHERE q.status = $done',
  'RETURN q.updated_at AS updated_at',
  'ORDER BY q.updated_at DESC, q.id ASC LIMIT 1',
].join('\n')

function failedMetric<T>(error: unknown): HealthMetric<T> {
  return isMissingTableError(error) ? { status: 'missing-table' } : { status: 'failed' }
}

/**
 * 队列头条目距 `nowMs` 的毫秒数；队列无待处理条目返回 null。
 *
 * 非法时刻按「采集失败」处理（spec：不得抛、也不得静默当成 0）：库内时间列是 UTC ISO-8601
 * 字符串，脏值意味着队列事实不可信，报 0 会让用户误读为「刚入队」。
 */
async function oldestPendingAgeMs(connection: lbug.Connection, table: string, nowMs: number): Promise<number | null> {
  const rows = await queryRows(connection, oldestPendingStatement(table), { statuses: [...BACKLOG_STATUSES] })
  const row = rows[0]
  if (row === undefined) return null
  const at = Date.parse(String(nullishString(row.enqueued_at) ?? ''))
  if (!Number.isFinite(at)) {
    throw new MemoryDbError('invalid_instant', `INBOX 条目的 enqueued_at 不是合法时刻：${String(row.enqueued_at)}`)
  }
  // 时钟回拨（条目时间晚于 now）夹紧为 0：负时长没有意义，也不该让用户以为积压「提前」。
  return Math.max(0, nowMs - at)
}

/** 两路队列的积压；都空 ⇒ `none`，任一路读失败按该错误整体降级（两行同生同灭）。 */
async function collectInboxBacklog(
  connection: lbug.Connection,
  nowMs: number,
): Promise<HealthMetric<InboxBacklog>> {
  try {
    const [l1Ms, l2Ms] = await Promise.all([
      oldestPendingAgeMs(connection, L1_INBOX_TABLE, nowMs),
      oldestPendingAgeMs(connection, L2_INBOX_TABLE, nowMs),
    ])
    if (l1Ms === null && l2Ms === null) return { status: 'none' }
    return { status: 'ok', value: { l1Ms, l2Ms } }
  } catch (error) {
    return failedMetric<InboxBacklog>(error)
  }
}

/** 最近一次精炼完成时刻；无 `done` 条目 ⇒ `none`（不是「未知」，也不是 0）。 */
async function collectLastRefineAt(connection: lbug.Connection): Promise<HealthMetric<string>> {
  try {
    const rows = await queryRows(connection, LAST_REFINE_STATEMENT, { done: REFINE_DONE_STATUS })
    const row = rows[0]
    const at = row === undefined ? null : nullishString(row.updated_at)
    return at === null ? { status: 'none' } : { status: 'ok', value: at }
  } catch (error) {
    return failedMetric<string>(error)
  }
}

/**
 * 采集健康指标（best-effort、永不抛）。
 *
 * 预算从第一次读时钟起计，**每个采集点之前**检查（D-4）：超出后尚未采集的指标一律 `budget`，
 * 已在采集中的指标照常返回（矩阵行 10：首项正常出值、其余超时）。
 */
export async function collectHealthMetrics(options: CollectHealthMetricsOptions): Promise<MemoryHealthView> {
  const clock = options.now ?? Date.now
  const budgetMs = options.budgetMs ?? HEALTH_BUDGET_MS
  const startedAt = clock()
  const overBudget = (): boolean => clock() - startedAt > budgetMs

  // 积压是首项：即使它自己耗时超预算也照常出值，预算只截断后续项。
  const inboxBacklog = await collectInboxBacklog(options.connection, startedAt)
  const lastRefineAt = overBudget()
    ? { status: 'budget' } as const
    : await collectLastRefineAt(options.connection)
  return { inboxBacklog, lastRefineAt }
}

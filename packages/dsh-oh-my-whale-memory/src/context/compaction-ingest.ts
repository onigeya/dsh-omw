/**
 * 压缩产物入图（Story 8.1 / FR-24、AC:1528-1539）。
 *
 * 把 `compaction/summary` 折成 INBOX 条目并落库，同时记一条 `compaction_run`（Config 快照）。
 *
 * 三条纪律：
 * 1. **幂等**：同一 `(sessionId, compactionId)` 只产生一条 INBOX 条目（AC:1532-1534）。判据是
 *    INBOX 行的 `id` 就是幂等键——`writeInboxItem` 同 id 重复入队天然幂等（queue 的 MERGE 语义），
 *    因此不需要「先查后写」的竞态窗口；
 * 2. **失败不阻塞 append**：调用方是 `session/event` 的 post-commit 监听器，抛错只记 warn（AC:1536-1538）；
 * 3. **观测回流不外暴露**：写入的是 L1 INBOX（进精炼管线），不是面向人的文档（AC:1550-1552）。
 */
import type * as lbug from '@ladybugdb/core'
import { auditWriter } from '../db/audit.js'
import { runPrepared } from '../db/backend.js'
import { queryRows } from '../db/rows.js'
import { COMPACTION_RUN_TABLE } from '../db/schema.js'
import { writeInboxItem } from '../inbox/queue.js'
import type { CompactionPlanRecord } from './compaction-plan-registry.js'
import {
  buildCompactionSummaryEntry,
  type CompactionSummaryPayload,
} from './compaction-summary.js'

/** 压缩入图用的 policy 标识（generation_log / 审计行共用）。 */
export const COMPACTION_INGEST_POLICY = 'compaction-ingest'

export interface CompactionIngestResult {
  /** INBOX 条目 id（= 幂等键）。 */
  readonly inboxId: string
  /** 是否新建了 `compaction_run` 行（false = 该 compression 已记过）。 */
  readonly runRecorded: boolean
  /** 解析期的降级说明（原样透传，便于账本与 status）。 */
  readonly notes: readonly string[]
}

const INSERT_RUN = [
  'CREATE (:' + COMPACTION_RUN_TABLE + ' {',
  '  id: $id, compaction_id: $compaction_id, session_id: $session_id,',
  '  config_snapshot_json: $config_snapshot_json, started_at: $started_at,',
  '  shadowed_seqs_json: $shadowed_seqs_json, shadowed_range_json: $shadowed_range_json,',
  '  plan_json: $plan_json, tier: $tier, delegate: $delegate',
  '})',
].join('\n')

const READ_RUN = 'MATCH (r:' + COMPACTION_RUN_TABLE + ' {id: $id}) RETURN r.id AS id'

/** 压缩运行的幂等键（与 INBOX 条目 key 分开命名空间，避免两张表语义混淆）。 */
export function compactionRunId(sessionId: string, compactionId: string): string {
  return 'run:' + sessionId + '#' + compactionId
}

/**
 * 落一条 `compaction_run`（Config 快照）。已存在则跳过并返回 false（幂等）。
 *
 * 为什么快照要 stringify：AD-26 的诉求是「事后能回答那次压缩在什么配置下做的」；把对象存成
 * JSON 字符串即可，不引入新的结构化列（AD-3 的可加表原则）。
 */
export async function recordCompactionRun(
  connection: lbug.Connection,
  input: {
    readonly sessionId: string
    readonly compactionId: string
    readonly configSnapshot: unknown
    readonly startedAt: string
    /** 被折叠的 seq 列表（AC:1535 的可回溯证据）。 */
    readonly shadowedSeqs?: readonly number[]
    readonly shadowedRange?: { readonly start: number, readonly end: number } | null
    /**
     * Story 8.4：这次压缩的档位计划（`summarize()` 写进注册表）。
     * 缺省 / null ⇒ tier、plan_json、delegate 三列都写 NULL（矩阵行 6：不编造）。
     */
    readonly plan?: CompactionPlanRecord | null
  },
): Promise<boolean> {
  const id = compactionRunId(input.sessionId, input.compactionId)
  const existing = await queryRows(connection, READ_RUN, { id }).catch(() => [])
  if (existing.length > 0) return false
  const plan = input.plan ?? null
  const statement = await connection.prepare(INSERT_RUN)
  await runPrepared(connection, statement, {
    id,
    compaction_id: input.compactionId,
    session_id: input.sessionId,
    config_snapshot_json: JSON.stringify(input.configSnapshot ?? null),
    started_at: input.startedAt,
    shadowed_seqs_json: JSON.stringify(input.shadowedSeqs ?? []),
    shadowed_range_json: JSON.stringify(input.shadowedRange ?? null),
    plan_json: plan === null ? null : JSON.stringify(plan),
    tier: plan === null ? null : plan.tier,
    delegate: plan === null ? null : plan.delegate,
  })
  return true
}

/**
 * 处理一条 `compaction/summary`：INBOX 入图 + `compaction_run` 落账 + 一条审计行。
 *
 * 抛错时整条不写（由调用方捕获并 warn）；`compaction_summary_invalid` 属于 payload 问题，
 * 重试也不会好，调用方应记 warn 后放弃这一条（不阻塞后续事件）。
 */
export async function ingestCompactionSummary(
  connection: lbug.Connection,
  input: {
    readonly payload: CompactionSummaryPayload
    readonly configSnapshot: unknown
    readonly startedAt: string
    readonly nowIso: string
    /** Story 8.4：档位计划（缺省 = 没有 plan，三列写 NULL）。 */
    readonly plan?: CompactionPlanRecord | null
  },
): Promise<CompactionIngestResult> {
  const entry = buildCompactionSummaryEntry(input.payload)
  // 幂等条目 id = key；writeInboxItem 同 id 重复入队是幂等的（不覆盖既有行）。
  const inboxId = await writeInboxItem(connection, {
    id: entry.key,
    sessionId: entry.sessionId,
    kind: 'compaction-summary',
    payload: entry.text,
    now: new Date(input.nowIso),
  })
  const runRecorded = await recordCompactionRun(connection, {
    sessionId: entry.sessionId,
    compactionId: entry.compactionId,
    configSnapshot: input.configSnapshot,
    startedAt: input.startedAt,
    shadowedSeqs: entry.shadowedSeqs,
    shadowedRange: entry.shadowedRange,
    plan: input.plan ?? null,
  })
  const plan = input.plan ?? null
  await auditWriter(connection, {
    recordedAt: input.nowIso,
    actor: 'system',
    kind: 'compaction',
    policy: COMPACTION_INGEST_POLICY,
    l0Refs: entry.shadowedSeqs.map((seq) => 'l0:' + String(seq)),
  })({
    action: 'compaction_summary_ingested',
    outcome: 'success',
    reason:
      'compaction=' + entry.compactionId +
      ' shadowed=' + String(entry.shadowedSeqs.length) +
      (plan === null ? '' : ' tier=' + plan.tier + ' delegate=' + plan.delegate) +
      (entry.shadowedRange === null ? '' : ' range=' + String(entry.shadowedRange.start) + '..' + String(entry.shadowedRange.end)) +
      (entry.notes.length === 0 ? '' : ' notes=' + entry.notes.join(',')),
  })
  return { inboxId, runRecorded, notes: entry.notes }
}

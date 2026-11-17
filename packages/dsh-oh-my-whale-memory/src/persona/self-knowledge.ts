/**
 * Agent Self-Knowledge：候选区、独立晋升门与只读收集面（Story 11.3 / AD-38、AD-39；ADR-11.1 方案 B）。
 *
 * 三件事的唯一实现处：
 * 1. **候选 append-only**：`recordCandidate` 只 `MERGE ... ON CREATE SET`，同一观察（正文归一化后
 *    相同）重放不新增、不改写历史正文；空正文 / 空 `sourceRefs` 一律拒绝（不造无源候选）。
 * 2. **晋升门**：`decidePersistence` 只调 11.1 的 `decidePromotion`——accepted / rejected 是终态
 *    （不得二次判定，防状态伪造 F-7），无独立信号时保持 `candidate` 并把原因写进
 *    `decision_reason`（record-only 的可观测判据）；自评不得单独晋升。
 * 3. **可见性**：所有读面只走 11.1 的 `isVisible`（禁止第二份矩阵）。`listAccepted` 是常驻层
 *    （AD-39）的收集入口：查询按 `state='accepted'` 结构化分域，返回前再经 `isVisible(state,
 *    'injection')` 判据过滤（未知/伪造状态 fail-closed）。candidate / rejected 永不返回。
 *
 * 隔离（T3）：本模块只读写 `agent_self_knowledge` 一张表；普通 recall、冲突路由与 `memory` 浏览
 * 的查询不包含本表，因此候选在结构上不可能进入召回候选池或 User Portrait 冲突（ADR-11.1 决策 3）。
 *
 * 表不存在（旧库只读打开、未迁移）时本模块的读函数照抛 `does not exist`，由调用方按
 * 「自省面为空 / status 未知」收敛——不在这里静默把缺表当 0（ADR-11.1：旧库只读时自省面为空）。
 */
import type * as lbug from '@ladybugdb/core'
import { runPrepared } from '../db/backend.js'
import { MemoryDbError } from '../db/errors.js'
import { normalizeFingerprintText, uuid5 } from '../db/id.js'
import { queryRows } from '../db/rows.js'
import { AGENT_SELF_KNOWLEDGE_TABLE } from '../db/schema.js'
import {
  KNOWLEDGE_SIGNALS,
  decidePromotion,
  isVisible,
  type KnowledgeSignal,
  type PromotionState,
  type SelfKnowledgeState,
} from './contract.js'

/** 单次收集/审计返回的条数上限（防超大库把一次注入拖成长查询）。 */
export const SELF_KNOWLEDGE_LIST_LIMIT = 50

/** 自省观察的持久化形态（`state` 只可能是三态之一；未知值按 fail-closed 处理）。 */
export interface SelfKnowledgeRecord {
  readonly id: string
  readonly state: SelfKnowledgeState
  readonly text: string
  /** 可达 L0 id（与 `memory.source_refs` 同形态，不带 `l0:` 前缀）。 */
  readonly sourceRefs: readonly string[]
  /** 晋升所依据的独立信号；null = 无独立信号（record-only）。 */
  readonly signal: KnowledgeSignal | null
  /** 晋升/拒绝/record-only 的原因；空串 = 尚未判定。 */
  readonly decisionReason: string
  readonly createdAt: string
  /** 终态决定时刻；record-only 保持 null（没有终态决定）。 */
  readonly decidedAt: string | null
}

/** `/memory status` 与审计面的计数（不含正文；record-only 是 candidate 的子集）。 */
export interface SelfKnowledgeCounts {
  readonly candidate: number
  readonly accepted: number
  readonly rejected: number
  /** `state='candidate'` 且已有 `decision_reason` 的条数（「只记录不晋升」的唯一可观测判据）。 */
  readonly recordOnly: number
}

/**
 * 观察正文的确定性内容键：`uuid5('self-knowledge:' + 归一化正文)`。
 *
 * 与 `memoryNodeId` 同一思路（归一化后相同 ⇒ 同一 id），但不含 layer：自省表不是记忆层。
 * 归一化后为空（只含标点/空白）时抛 `self_knowledge_invalid`。
 */
export function selfKnowledgeId(text: string): string {
  let normalized: string
  try {
    normalized = normalizeFingerprintText(text)
  } catch {
    throw new MemoryDbError('self_knowledge_invalid', '自省候选正文归一化后为空（只含标点或空白），拒绝写入')
  }
  return uuid5('self-knowledge:' + normalized)
}

/**
 * `sourceRefs` 归一化：`l0:<id>` → `<id>`（与 `memory.source_refs` 同形态），去空白与重复。
 * 归一化后为空 ⇒ 调用方拒绝写入（不造无源候选）。
 */
function normalizeSourceRefs(refs: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of refs) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const bare = trimmed.startsWith('l0:') ? trimmed.slice(3).trim() : trimmed
    if (bare !== '') normalized.add(bare)
  }
  return [...normalized]
}

const RECORD_RETURN = [
  'RETURN k.id AS id, k.state AS state, k.text AS text, k.source_refs AS source_refs,',
  '  k.signal AS signal, k.decision_reason AS decision_reason, k.created_at AS created_at,',
  '  k.decided_at AS decided_at',
].join('\n')

function toRecord(row: Record<string, unknown>): SelfKnowledgeRecord {
  const signal = row.signal === null || row.signal === undefined ? null : String(row.signal)
  return {
    id: String(row.id ?? ''),
    state: String(row.state ?? 'candidate') as SelfKnowledgeState,
    text: String(row.text ?? ''),
    sourceRefs: Array.isArray(row.source_refs) ? row.source_refs.map(String) : [],
    // 只把契约清单内的信号读成 KnowledgeSignal；伪造值读成 null（fail-closed）。
    signal: signal !== null && (KNOWLEDGE_SIGNALS as readonly string[]).includes(signal)
      ? signal as KnowledgeSignal
      : null,
    decisionReason: String(row.decision_reason ?? ''),
    createdAt: String(row.created_at ?? ''),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : String(row.decided_at),
  }
}

export interface RecordCandidateInput {
  readonly text: string
  readonly sourceRefs: readonly string[]
  /** 注入时钟（测试）；缺省系统时间。 */
  readonly now?: Date
}

/**
 * 落一条候选（append-only、幂等）：`state='candidate'`、`created_at=now`、`decided_at=NULL`。
 *
 * 只 `ON CREATE SET`：同一 id 重放不新增行、不改写既有正文（哪怕它已被 accepted/rejected）。
 * 返回确定性 id，便于生产者/测试断言「同观察同 id」。
 */
export async function recordCandidate(
  connection: lbug.Connection,
  input: RecordCandidateInput,
): Promise<{ readonly id: string }> {
  const text = input.text.trim()
  if (text === '') {
    throw new MemoryDbError('self_knowledge_invalid', '自省候选正文为空，拒绝写入（不造无源候选）')
  }
  const sourceRefs = normalizeSourceRefs(input.sourceRefs)
  if (sourceRefs.length === 0) {
    throw new MemoryDbError(
      'self_knowledge_invalid',
      '自省候选缺少可达 L0 来源（sourceRefs 为空），拒绝写入（不造无源候选）',
    )
  }
  const id = selfKnowledgeId(text)
  const statement = await connection.prepare([
    `MERGE (k:${AGENT_SELF_KNOWLEDGE_TABLE} {id: $id})`,
    'ON CREATE SET k.state = $state, k.text = $text, k.source_refs = $source_refs,',
    '  k.signal = $signal, k.decision_reason = $decision_reason,',
    '  k.created_at = $created_at, k.decided_at = $decided_at',
  ].join('\n'))
  await runPrepared(connection, statement, {
    id,
    state: 'candidate',
    text,
    source_refs: sourceRefs,
    signal: null,
    decision_reason: null,
    created_at: (input.now ?? new Date()).toISOString(),
    decided_at: null,
  })
  return { id }
}

/** 按 id 读一条（不存在 ⇒ null；表缺失照抛，由调用方决定收敛方式）。 */
export async function readSelfKnowledge(
  connection: lbug.Connection,
  id: string,
): Promise<SelfKnowledgeRecord | null> {
  const rows = await queryRows(
    connection,
    `MATCH (k:${AGENT_SELF_KNOWLEDGE_TABLE} {id: $id})\n${RECORD_RETURN}`,
    { id },
  )
  return rows[0] === undefined ? null : toRecord(rows[0])
}

export interface DecidePersistenceInput {
  readonly id: string
  /** 独立验证信号（outcome / tool-result / user-feedback）；null = 无独立信号。 */
  readonly signal: KnowledgeSignal | null
  /** 晋升依据是否只有反思模型自己的评分（true ⇒ 永不晋升）。 */
  readonly selfScoreOnly: boolean
  /** 调用方补充的原因（与门的 reasons 一起落库；空/缺省不加）。 */
  readonly reason?: string
  readonly now?: Date
}

export interface PersistenceDecision {
  readonly id: string
  /** 落库后的状态：accepted / rejected（终态）或 candidate（record-only，保持候选）。 */
  readonly state: SelfKnowledgeState
  /** 门的原始判定：accepted / rejected / record-only。 */
  readonly decision: PromotionState
  readonly reasons: readonly string[]
  /** 终态决定时刻；record-only 为 null。 */
  readonly decidedAt: string | null
}

/**
 * 晋升/拒绝判定（只走 11.1 的 `decidePromotion`，不复制判据）：
 * - 无独立信号 ⇒ record-only：保持 `state='candidate'`，原因写 `decision_reason`，`decided_at` 仍 NULL；
 * - 只有自评 ⇒ rejected（即使同时报了信号名，也按「唯一依据仍是自评」处理）；
 * - 有独立信号且非自评 ⇒ accepted。
 *
 * 终态守卫：`accepted` / `rejected` 不得二次判定（抛 `self_knowledge_decided`），否则审计上等于
 * 篡改历史（F-7）。状态迁移**不改写正文**（append-only）。
 */
export async function decidePersistence(
  connection: lbug.Connection,
  input: DecidePersistenceInput,
): Promise<PersistenceDecision> {
  const existing = await readSelfKnowledge(connection, input.id)
  if (existing === null) {
    throw new MemoryDbError('self_knowledge_not_found', '自省候选不存在（id=' + input.id + '）')
  }
  if (existing.state !== 'candidate') {
    throw new MemoryDbError(
      'self_knowledge_decided',
      `自省候选已是终态 ${existing.state}，不得再判定（accepted/rejected 不可逆）`,
    )
  }
  // 只把契约清单内的信号交给门；伪造/未知值按「无独立信号」处理（fail-closed）。
  const signal = input.signal !== null && (KNOWLEDGE_SIGNALS as readonly string[]).includes(input.signal)
    ? input.signal
    : null
  const decision = decidePromotion({ signal, selfScoreOnly: input.selfScoreOnly })
  const extra = input.reason?.trim() ?? ''
  const reasons = extra === '' ? decision.reasons : [...decision.reasons, extra]
  const reasonText = reasons.join('；')
  const terminal = decision.state !== 'record-only'
  const state: SelfKnowledgeState = decision.state === 'record-only' ? 'candidate' : decision.state
  const decidedAt = terminal ? (input.now ?? new Date()).toISOString() : null

  const statement = await connection.prepare(
    terminal
      ? [
        `MATCH (k:${AGENT_SELF_KNOWLEDGE_TABLE} {id: $id})`,
        'SET k.state = $state, k.signal = $signal, k.decision_reason = $decision_reason, k.decided_at = $decided_at',
      ].join('\n')
      // record-only：保持 candidate，不写 decided_at（没有终态决定）。
      : [
        `MATCH (k:${AGENT_SELF_KNOWLEDGE_TABLE} {id: $id})`,
        'SET k.signal = $signal, k.decision_reason = $decision_reason',
      ].join('\n'),
  )
  await runPrepared(
    connection,
    statement,
    terminal
      ? { id: input.id, state, signal, decision_reason: reasonText, decided_at: decidedAt }
      : { id: input.id, signal, decision_reason: reasonText },
  )
  return { id: input.id, state, decision: decision.state, reasons, decidedAt }
}

/**
 * 常驻层（AD-39）的 accepted 收集入口：**只有** accepted 可见，且返回前再经 `isVisible` 判据。
 * 排序固定（`decided_at` 升序、`id` 升序）⇒ 同一批行在任何会话渲染字节相同（INV-1）。
 */
export async function listAccepted(
  connection: lbug.Connection,
  options: { readonly limit?: number } = {},
): Promise<SelfKnowledgeRecord[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? SELF_KNOWLEDGE_LIST_LIMIT))
  const rows = await queryRows(
    connection,
    [
      `MATCH (k:${AGENT_SELF_KNOWLEDGE_TABLE})`,
      'WHERE k.state = $state',
      RECORD_RETURN,
      'ORDER BY k.decided_at ASC, k.id ASC LIMIT $limit',
    ].join('\n'),
    { state: 'accepted', limit },
  )
  // 单一可见性判据（AD-38 / IM-1）：未知或伪造状态在这里被过滤，不另写一份矩阵。
  return rows
    .map((row) => toRecord(row))
    .filter((record) => isVisible(record.state, 'injection'))
}

/**
 * 三态计数 + record-only 计数（审计/status 面，不含正文）。
 * record-only 的判据：`state='candidate'` 且 `decision_reason` 非空（无信号时的规定降级态）。
 */
export async function countsByState(connection: lbug.Connection): Promise<SelfKnowledgeCounts> {
  const rows = await queryRows(
    connection,
    [
      `MATCH (k:${AGENT_SELF_KNOWLEDGE_TABLE})`,
      'RETURN',
      "  sum(CASE WHEN k.state = 'candidate' THEN 1 ELSE 0 END) AS candidate_count,",
      "  sum(CASE WHEN k.state = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,",
      "  sum(CASE WHEN k.state = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,",
      "  sum(CASE WHEN k.state = 'candidate' AND k.decision_reason IS NOT NULL " +
        "AND k.decision_reason <> '' THEN 1 ELSE 0 END) AS record_only",
    ].join('\n'),
  )
  const row = rows[0] ?? {}
  return {
    candidate: Number(row.candidate_count ?? 0),
    accepted: Number(row.accepted_count ?? 0),
    rejected: Number(row.rejected_count ?? 0),
    recordOnly: Number(row.record_only ?? 0),
  }
}

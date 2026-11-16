/**
 * 待裁决冲突（Story 7.1 / FR-20、AD-18 的 `await-confirmation` 落地）。
 *
 * 一条 pending 记录 = 「有一条新的 persona 观测与既有人设冲突，等你裁决」。它同时有两条凭证：
 * - `keyed_decision` 的 `{judge_key, action='await-confirmation', resolution_source='auto'}`（AD-18 要求的裁决账）；
 * - 本表的一行（`id = judge_key`，带候选正文 `payload`）——因为 keyed 表按 AD-21 不存正文（NFR9）。
 *
 * 生命周期：
 * 1. `insertPendingDecision`（写路径检测到 persona 冲突时，与 keyed 行同事务）；
 * 2. `readPendingDecision` / `countPendingDecisions` / `listPendingDecisions`（`/memory status` 与 `/memory resolve`）；
 * 3. `resolvePendingDecision`（`--accept` / `--keep`：写新节点 + 写 supersede/merge 的 keyed 行 + 删本行，
 *    整个流程在**一个事务**里，中途失败全回滚）。
 *
 * 事务契约：除 `resolvePendingDecision`（它自己开事务，因为它是完整的用户级动作）外，其余原语都
 * 「由调用方开事务」。`runInTransaction` 不可重入，所以 resolve 内部只用自开事务的原语
 * （`writeMemoryVersion` / `insertKeyedDecision` / 裸 `MATCH … SET`）。
 */
import type * as lbug from '@ladybugdb/core'
import { buildJudgeKey, insertKeyedDecision } from './audit.js'
import { MemoryDbError } from './errors.js'
import { memoryNodeId } from './id.js'
import { writeMemoryVersion } from './memory.js'
import { runPrepared } from './backend.js'
import { queryRows } from './rows.js'
import { MEMORY_TABLE, PENDING_DECISION_TABLE } from './schema.js'
import { MEMORY_REMEMBER_LAYER } from '../shared/memory-vocab.js'
import { runInTransaction } from './transaction.js'

/** 冲突裁决的 policy 标识（`keyed_decision.policy` / `generation_log.policy` 共用）。 */
export const PERSONA_CONFLICT_POLICY = 'persona-conflict'

/** 一条待裁决记录（`/memory status` 的清单与 `/memory resolve` 的入参都用这个形状）。 */
export interface PendingDecision {
  readonly id: string
  readonly oldId: string
  readonly newId: string
  readonly payload: string
  readonly kind: string
  readonly priority: number
  readonly actor: string
  readonly createdAt: string
}

export interface InsertPendingDecisionInput {
  /** 与 keyed 裁决的 judge_key 相同（内容键）。 */
  readonly id: string
  readonly oldId: string
  readonly newId: string
  readonly payload: string
  readonly kind: string
  readonly priority: number
  readonly actor: string
  readonly createdAt: string
}

const INSERT_PENDING = [
  'CREATE (:' + PENDING_DECISION_TABLE + ' {',
  '  id: $id, old_id: $old_id, new_id: $new_id, payload: $payload,',
  '  kind: $kind, priority: $priority, actor: $actor, created_at: $created_at',
  '})',
].join('\n')

const READ_PENDING = [
  'MATCH (p:' + PENDING_DECISION_TABLE + ' {id: $id})',
  'RETURN p.id AS id, p.old_id AS old_id, p.new_id AS new_id, p.payload AS payload,',
  '  p.kind AS kind, p.priority AS priority, p.actor AS actor, p.created_at AS created_at',
].join('\n')

const DELETE_PENDING = 'MATCH (p:' + PENDING_DECISION_TABLE + ' {id: $id}) DELETE p'

const LIST_PENDING = [
  'MATCH (p:' + PENDING_DECISION_TABLE + ')',
  'RETURN p.id AS id, p.old_id AS old_id, p.new_id AS new_id, p.payload AS payload,',
  '  p.kind AS kind, p.priority AS priority, p.actor AS actor, p.created_at AS created_at',
  'ORDER BY p.created_at DESC, p.id ASC LIMIT $limit',
].join('\n')

const SET_OLD_INVALID = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'WHERE m.invalid_at IS NULL',
  'SET m.invalid_at = $invalid_at',
  'RETURN m.id AS id',
].join('\n')

function toPending(row: Record<string, unknown> | undefined): PendingDecision | null {
  if (row === undefined) return null
  return {
    id: String(row.id),
    oldId: String(row.old_id ?? ''),
    newId: String(row.new_id ?? ''),
    payload: String(row.payload ?? ''),
    kind: String(row.kind ?? ''),
    priority: Number(row.priority ?? 0),
    actor: String(row.actor ?? ''),
    createdAt: String(row.created_at ?? ''),
  }
}

/** 写一条待裁决记录（由调用方开事务；同一事务里还应写 `action='await-confirmation'` 的 keyed 行）。 */
export async function insertPendingDecision(
  connection: lbug.Connection,
  input: InsertPendingDecisionInput,
): Promise<void> {
  const statement = await connection.prepare(INSERT_PENDING)
  await runPrepared(connection, statement, {
    id: input.id,
    old_id: input.oldId,
    new_id: input.newId,
    payload: input.payload,
    kind: input.kind,
    priority: Math.trunc(input.priority),
    actor: input.actor,
    created_at: input.createdAt,
  })
}

/** 读一条；不存在返回 `null`（不抛，调用方决定文案）。 */
export async function readPendingDecision(
  connection: lbug.Connection,
  id: string,
): Promise<PendingDecision | null> {
  const rows = await queryRows(connection, READ_PENDING, { id })
  return toPending(rows[0])
}

/** 待裁决条数；表缺失（极旧库未迁移且只读）返回 `null` = 未知，不静默报 0。 */
export async function countPendingDecisions(connection: lbug.Connection): Promise<number | null> {
  try {
    const rows = await queryRows(
      connection,
      'MATCH (p:' + PENDING_DECISION_TABLE + ') RETURN count(p) AS c',
    )
    return Number(rows[0]?.c ?? 0)
  } catch (error) {
    if (/does not exist/i.test(error instanceof Error ? error.message : String(error))) return null
    throw error
  }
}

/** 最近的待裁决记录（`created_at` 倒序，最多 `limit` 条）。 */
export async function listPendingDecisions(
  connection: lbug.Connection,
  options: { readonly limit?: number } = {},
): Promise<PendingDecision[]> {
  const limit = Math.max(1, Math.trunc(options.limit ?? 5))
  try {
    const rows = await queryRows(connection, LIST_PENDING, { limit })
    return rows.map((row) => toPending(row)).filter((item): item is PendingDecision => item !== null)
  } catch (error) {
    // 表缺失（旧库未迁移且只读）⇒ 视作「没有待裁决」，与 count 返回 null 同一约定：不抛、不阻塞 status。
    if (/does not exist/i.test(error instanceof Error ? error.message : String(error))) return []
    throw error
  }
}

/** 用户的裁决结果：接受新值（旧值作废）或保留并存。 */
export type PendingResolution = 'accept' | 'keep'

export interface PendingResolutionResult {
  readonly id: string
  /** 裁决后写入/命中的记忆节点 id（指纹 id）。 */
  readonly newMemoryId: string
  /** 落账的 keyed 动作（AD-18 三档里的两档）。 */
  readonly action: 'supersede' | 'merge'
}

/**
 * 执行一次裁决：**自己开事务**。
 *
 * - `accept`：旧节点 `invalid_at = now`，新节点以候选正文写入（`parent_id = old_id`），keyed 记 `supersede`；
 * - `keep`：旧节点不动，新节点照常写入，keyed 记 `merge`；
 * - 两者都把 `resolution_source` 记为 `'user'`（AD-18），并在同一事务里删除待裁决行。
 */
export async function resolvePendingDecision(
  connection: lbug.Connection,
  id: string,
  resolution: PendingResolution,
  options: { readonly now?: () => Date } = {},
): Promise<PendingResolutionResult> {
  const nowIso = (options.now ?? (() => new Date()))().toISOString()
  return runInTransaction(connection, async () => {
    const pending = await readPendingDecision(connection, id)
    if (pending === null) {
      throw new MemoryDbError('pending_decision_not_found', '未找到待裁决记录（id=' + id + '）')
    }
    const action: 'supersede' | 'merge' = resolution === 'accept' ? 'supersede' : 'merge'
    // 新节点用候选正文：指纹 id 由 layer+归一化正文决定（AD-4），与写入路径同源。
    const newMemoryId = memoryNodeId(MEMORY_REMEMBER_LAYER, pending.payload)
    await insertKeyedDecision(connection, {
      judgeKey: buildJudgeKey(PERSONA_CONFLICT_POLICY, action, pending.oldId, newMemoryId),
      newId: newMemoryId,
      oldId: pending.oldId,
      action,
      policy: PERSONA_CONFLICT_POLICY,
      l0Refs: [],
      resolutionSource: 'user',
      ts: nowIso,
    })
    if (resolution === 'accept') {
      const invalidate = await connection.prepare(SET_OLD_INVALID)
      await runPrepared(connection, invalidate, { id: pending.oldId, invalid_at: nowIso })
    }
    await writeMemoryVersion(connection, {
      layer: MEMORY_REMEMBER_LAYER,
      text: pending.payload,
      kind: pending.kind,
      priority: pending.priority,
      parentId: pending.oldId,
      actor: 'user',
      validAt: nowIso,
      recordedAt: nowIso,
      sourceRefs: [],
    }, { now: () => new Date(nowIso) })
    const deletion = await connection.prepare(DELETE_PENDING)
    await runPrepared(connection, deletion, { id })
    return { id, newMemoryId, action }
  })
}

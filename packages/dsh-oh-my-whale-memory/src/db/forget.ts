/**
 * forget 软删除与 EII 定序级联（Story 4.1 / FR-14、FR-15 / AD-10、AD-19、AD-21）。
 *
 * 全仓唯一写 `expired_at` 的地方。两列语义不同，不可混用：
 * - `expired_at` 只写**目标节点**（用户显式遗忘；`dedup.ts` 的复活判定据此永不复活）；
 * - 级联受害者只写 `invalid_at`（作废 = 证据链断裂），不把用户级遗忘传染给未被点名的节点。
 * 两列都让节点退出当前快照（EII 谓词：`valid_at <= now AND invalid_at IS NULL AND expired_at IS NULL`）。
 *
 * 三条从代码看不出来的约束：
 * - 反向闭包深度固定 {@link EVIDENCE_CLOSURE_DEPTH}（AD-19，不接配置）。深度必须是内联字面量：
 *   0.22.3 的 `*1..$depth` 是 Parser exception（同 `edges.ts:275`）。同一 id 的多条路径会让
 *   查询重行，且 0.22.3 的 `min()` 聚合未验证 ⇒ 跳数在 JS 侧按 id 归并取最小。
 * - 全部写入在**一个** `runInTransaction` 内（AC「无半级联状态」）。事务内只允许「由调用方
 *   开事务」的原语：`insertGenerationLog` / `insertKeyedDecision` / 裸 `MATCH … SET`；
 *   `runInTransaction` 不可重入，`upsertMemory` 这类自开事务的写入一律不碰。
 * - AD-10 次序：先写全部从属记录（generation_log + keyed_decision），再写指针
 *   （`invalid_at` 自顶向下 = 跳数降序），最后写目标的 `expired_at`。
 *
 * 每个被作废的节点都必须落一条 `keyed_decision`（`old_id` = 该节点）：`audit.ts` 的
 * AUDIT_GAP_STATEMENT 把「已有 invalid_at/expired_at 但没有 keyed 裁决」计为差额，
 * 缺行会让一次合法 forget 把 audit_gap 推高（D-D）。
 *
 * 凭据纪律（NFR9）：`reason` / `policy` 只放 id、跳数与策略名，绝不写记忆正文。
 */
import type * as lbug from '@ladybugdb/core'
import {
  FORGET_ACTION,
  FORGET_CASCADE_KIND,
  FORGET_POLICY,
  buildJudgeKey,
  insertGenerationLog,
  insertKeyedDecision,
} from './audit.js'
import { MemoryDbError } from './errors.js'
import { nullishString, queryRows, toStringArray } from './rows.js'
import { EVIDENCE_CLOSURE_DEPTH, EVIDENCE_TABLE, MEMORY_TABLE } from './schema.js'
import { runInTransaction } from './transaction.js'

/** 一次 forget 里被作废的一个节点。 */
export interface ForgottenNode {
  readonly id: string
  readonly layer: string
  readonly text: string
  /** 与目标的证据跳数：目标自身 0，级联受害者 1..{@link EVIDENCE_CLOSURE_DEPTH}。 */
  readonly hops: number
}

export interface ForgetResult {
  /** 被遗忘的目标 id（回显）。 */
  readonly id: string
  /** true = 目标此前已有 `expired_at`，本次是幂等重放：没有写任何行，也没有级联。 */
  readonly alreadyExpired: boolean
  /** 本次真正作废的节点，跳数降序、目标在最后；幂等重放时只有目标一行。 */
  readonly affected: readonly ForgottenNode[]
}

export interface ForgetOptions {
  /** 时钟注入点（单测固定时刻；缺省系统时间）。 */
  readonly now?: () => Date
}

/** 目标节点的当前状态（只需决定「能不能写」的列 + 记账要用的列）。 */
interface ForgetCandidate {
  readonly id: string
  readonly layer: string
  readonly text: string
  readonly hops: number
  /** `invalid_at` 已非空（作废过）。 */
  readonly invalidated: boolean
  /** `expired_at` 已非空（遗忘过）。 */
  readonly expired: boolean
  readonly sourceRefs: readonly string[]
}

const READ_TARGET = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN m.id AS id, m.layer AS layer, m.text AS text,',
  '  m.invalid_at AS invalid_at, m.expired_at AS expired_at, m.source_refs AS source_refs',
].join('\n')

/**
 * 目标的上层引用者闭包。EVIDENCE 的方向是「被引用者 → 引用者」（低层 → 高层，`schema.ts`），
 * 所以引用者是从目标**顺着**边走到的那一端：`(t)-[:EVIDENCE*1..4]->(up)`。
 * `WHERE up.id <> t.id` 把回到目标的环排除在外。
 */
const REVERSE_CLOSURE = [
  'MATCH p = (t:' + MEMORY_TABLE + ' {id: $id})-[:' + EVIDENCE_TABLE + '*1..' + EVIDENCE_CLOSURE_DEPTH + ']->(up:' + MEMORY_TABLE + ')',
  'WHERE up.id <> t.id',
  'RETURN up.id AS id, up.layer AS layer, up.text AS text,',
  '  up.invalid_at AS invalid_at, up.expired_at AS expired_at,',
  '  up.source_refs AS source_refs, length(p) AS hops',
].join('\n')

const SET_INVALID_AT = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'SET m.invalid_at = $invalid_at',
  'RETURN m.id AS id',
].join('\n')

const SET_EXPIRED_AT = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'SET m.expired_at = $expired_at',
  'RETURN m.id AS id',
].join('\n')

/**
 * 唯一构造 `memory_not_found` 的地方：命令面渲染成 `未找到 id 为 <id> 的记忆。`（与 `show`
 * 逐字一致），工具面收敛成 `failed/memory_not_found`。
 */
function notFound(id: string): MemoryDbError {
  return new MemoryDbError('memory_not_found', `未找到 id 为 ${id} 的记忆。`)
}

function toCandidate(row: Record<string, unknown>, hops: number): ForgetCandidate {
  const invalidAt = nullishString(row.invalid_at)
  const expiredAt = nullishString(row.expired_at)
  return {
    id: String(row.id),
    layer: String(row.layer ?? ''),
    text: String(row.text ?? ''),
    hops,
    invalidated: invalidAt !== null,
    expired: expiredAt !== null,
    sourceRefs: toStringArray(row.source_refs),
  }
}

async function readTarget(connection: lbug.Connection, id: string): Promise<ForgetCandidate | null> {
  const rows = await queryRows(connection, READ_TARGET, { id })
  const row = rows[0]
  return row === undefined ? null : toCandidate(row, 0)
}

/**
 * 上层引用者：按 id 归并取**最小**跳数（同 id 多路径会重行）。
 * 已经离开当前快照的节点照样进闭包（否则更高的引用者永远够不到），由调用方决定要不要重写。
 */
async function readUpstreamRefs(
  connection: lbug.Connection,
  id: string,
): Promise<ForgetCandidate[]> {
  const rows = await queryRows(connection, REVERSE_CLOSURE, { id })
  const merged = new Map<string, ForgetCandidate>()
  for (const row of rows) {
    const candidate = toCandidate(row, Number(row.hops ?? Number.POSITIVE_INFINITY))
    const current = merged.get(candidate.id)
    if (current === undefined || candidate.hops < current.hops) merged.set(candidate.id, candidate)
  }
  return [...merged.values()]
}

/** 跳数降序、同跳按 id 升序（确定性输出；目标 hops=0 因此在最后）。 */
function compareAffected(a: ForgottenNode, b: ForgottenNode): number {
  if (a.hops !== b.hops) return b.hops - a.hops
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

function toForgotten(candidate: ForgetCandidate): ForgottenNode {
  return {
    id: candidate.id,
    layer: candidate.layer,
    text: candidate.text,
    hops: candidate.hops,
  }
}

/**
 * 写一列指针并校验真的写到了行：`MATCH` 未命中时 `SET` 是静默 no-op，不校验就会
 * 以「成功」收尾（矩阵行 15 的「不静默」与行 13 的回滚前提都依赖这条断言）。
 */
async function writePointer(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<void> {
  const rows = await queryRows(connection, statement, params)
  if (rows.length === 0) throw notFound(String(params.id))
}

/**
 * 遗忘一条记忆：目标写 `expired_at`，其上层引用者按跳数自顶向下写 `invalid_at`。
 *
 * 幂等：目标已有 `expired_at` ⇒ 直接返回 success，不写任何行（保留首次时间，也不级联）。
 * 不存在 ⇒ `memory_not_found`（不写任何行）。
 *
 * @param connection 库连接（本函数自开事务，不得在既有事务内调用）
 * @param id         目标记忆 id
 */
export async function forgetMemory(
  connection: lbug.Connection,
  id: string,
  options: ForgetOptions = {},
): Promise<ForgetResult> {
  const ts = (options.now ?? (() => new Date()))().toISOString()
  return runInTransaction(connection, async () => {
    const target = await readTarget(connection, id)
    if (target === null) throw notFound(id)
    if (target.expired) {
      // 幂等重放（矩阵行 2/9/10）：保留首次 expired_at，不重写、不级联、零新行。
      return { id, alreadyExpired: true, affected: [toForgotten(target)] }
    }

    // 级联受害者的判据：仍在当前快照里才重写。已作废/已遗忘的上层照样进闭包（它能往更高层
    // 走），但不重写、不记账（矩阵行 7：invalid_at 保持原值、不新增 log/keyed 行）。
    const victims = (await readUpstreamRefs(connection, id))
      .filter((candidate) => !candidate.invalidated && !candidate.expired)
      .sort(compareAffected)

    // ① 从属记录：先落目标（级联行要用它的 log 行 id 作 trigger_id），再落每个受害者。
    const rootLogId = await insertGenerationLog(connection, {
      recordedAt: ts,
      actor: 'user',
      kind: FORGET_CASCADE_KIND,
      action: FORGET_ACTION,
      policy: FORGET_POLICY,
      l0Refs: target.sourceRefs,
      outcome: 'success',
      reason: `forget root=${id} depth=0`,
      cascadeDepth: 0,
      triggerId: null,
    })
    await insertKeyedDecision(connection, {
      judgeKey: buildJudgeKey(FORGET_POLICY, id, id),
      newId: id,
      oldId: id,
      action: 'supersede',
      policy: FORGET_POLICY,
      l0Refs: target.sourceRefs,
      resolutionSource: 'user',
      ts,
    })
    for (const victim of victims) {
      await insertGenerationLog(connection, {
        recordedAt: ts,
        actor: 'user',
        kind: FORGET_CASCADE_KIND,
        action: FORGET_ACTION,
        policy: FORGET_POLICY,
        l0Refs: victim.sourceRefs,
        outcome: 'success',
        reason: `forget root=${id} depth=${victim.hops}`,
        cascadeDepth: victim.hops,
        triggerId: rootLogId,
      })
      await insertKeyedDecision(connection, {
        judgeKey: buildJudgeKey(FORGET_POLICY, victim.id, id),
        newId: id,
        oldId: victim.id,
        action: 'supersede',
        policy: FORGET_POLICY,
        l0Refs: victim.sourceRefs,
        resolutionSource: 'user',
        ts,
      })
    }

    // ② 指针：invalid_at 自顶向下（跳数降序），最后写目标的 expired_at（AD-10）。
    for (const victim of victims) {
      await writePointer(connection, SET_INVALID_AT, { id: victim.id, invalid_at: ts })
    }
    await writePointer(connection, SET_EXPIRED_AT, { id, expired_at: ts })

    const affected = [...victims.map(toForgotten), toForgotten(target)].sort(compareAffected)
    return { id, alreadyExpired: false, affected }
  })
}

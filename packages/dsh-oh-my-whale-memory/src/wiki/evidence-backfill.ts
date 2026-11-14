/**
 * EVIDENCE 边历史回填（Story 2.6 / 裁决 X1）。
 *
 * 边表是 Story 2.6 才建的，**建表之前**写入的 L1/L2 节点在 source_refs 里记着证据 id，
 * 却没有对应的边。回填把二者的差集补成边（MERGE，幂等），让 EII 判据②与 audit_gap
 * 对存量节点也成立。
 *
 * 纪律（裁决 X1 + Lead 交付清单②）：
 * - **有界**：每轮至多 `EVIDENCE_BACKFILL_BATCH_SIZE` 个节点，按 `(recorded_at, id)` 游标前进，
 *   游标存 `omw_meta`（纯逻辑水位，不新增存储）；扫完写哨兵 `done` 后不再查库。
 * - **受空闲闸门约束**：入口查一次 `gate.isIdle()`，每个节点迭代前再复查一次。
 * - **同层 / 倒置 / 悬空 ref 一律不建边**（X1×U5），只计审计——绝不静默写一条非法边。
 * - **挂既有模块级后台任务集**：调用方是消费者的 maintenance 钩子（与 NULL 向量回填同一钩子），
 *   因此不新增 ctx.effect，且天然被既有的 `stop() → drain → close()` 覆盖。
 *
 * 崩溃语义（评审 P7/T7 修订）：边写入、审计与**游标推进**同一事务。故进程崩溃只会让整批
 * 一起回滚（下一轮从原游标重做）——MERGE 幂等，不产重边，也**不会重复记** backfill_evidence
 * 审计行。唯一例外是「空页 ⇒ 写 done 哨兵」那条路径（无审计，留在事务外）。
 */
import type * as lbug from '@ladybugdb/core'
import {
  BACKFILL_EVIDENCE_ACTION,
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  insertGenerationLog,
} from '../db/audit.js'
import { runPrepared } from '../db/backend.js'
import { isEvidenceLayerOrder, L0_LAYER, writeEvidenceEdges, type EvidenceEdgeInput } from '../db/edges.js'
import { collectRows } from '../db/rows.js'
import { L0_RAW_TABLE, MEMORY_TABLE, META_KEYS, META_TABLE } from '../db/schema.js'
import { currentSnapshotPredicate } from '../db/snapshot.js'
import { runInTransaction } from '../db/transaction.js'
import type { IdleGate } from '../inbox/idle-gate.js'

/** 每轮至多回填的节点数（有界：把一轮的时长钉死，剩余留到下一轮）。 */
export const EVIDENCE_BACKFILL_BATCH_SIZE = 50

/** 游标哨兵：整个 memory 表已扫完。 */
export const EVIDENCE_BACKFILL_DONE = 'done'

/** 回填出来的边的 reason（与精炼路径同一族：来源是结构化的 source_refs，不是 LLM 提议）。 */
export const BACKFILL_EVIDENCE_REASON = 'source-ref'

const PAGE_STATEMENT = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  'WHERE (m.recorded_at > $cursor_at OR (m.recorded_at = $cursor_at AND m.id > $cursor_id))',
  // 评审 P9（T9③ / spec D3 spec:103）：回填只取**有效**节点，墓碑/失效节点不产出边。
  // Story 3.1 / F-04：换成 `db/snapshot.ts` 的共享四条件谓词（`$now` 绑定）——future-valid
  // 节点在生效前不是当前快照，会被本页排除；游标只进不退 ⇒ 该行不会被回补（spec D10
  // 接受的代价，生产写路径 `valid_at` 恒 ≤ now，仅显式夹具可触发）。
  '  AND ' + currentSnapshotPredicate('m'),
  'RETURN m.id AS id, m.layer AS layer, m.source_refs AS source_refs, m.recorded_at AS recorded_at',
  'ORDER BY m.recorded_at ASC, m.id ASC',
  'LIMIT $limit',
].join('\n')

const L0_PROBE = 'MATCH (l:' + L0_RAW_TABLE + ' {id: $id}) RETURN l.id AS id'
const MEMORY_LAYER_PROBE = 'MATCH (m:' + MEMORY_TABLE + ' {id: $id}) RETURN m.layer AS layer'
const READ_META = 'MATCH (m:' + META_TABLE + ' {key: $key}) RETURN m.value AS value'
const MERGE_META = 'MERGE (m:' + META_TABLE + ' {key: $key}) ON CREATE SET m.value = $value ON MATCH SET m.value = $value'

export interface EvidenceBackfillOptions {
  /** 惰性取连接（apply 期间建库完成后才可用；未就绪 → 本轮不做事）。 */
  readonly connection: () => lbug.Connection | null
  readonly gate: IdleGate
  readonly logger?: { warn(message: string): void }
  readonly batchSize?: number
}

export interface EvidenceBackfill {
  /** 跑一轮：返回本轮实际 MERGE 到的边数（诊断/测试入口）。 */
  runOnce(): Promise<number>
}

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue> = {},
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

async function readCursor(connection: lbug.Connection): Promise<string> {
  const rows = await queryRows(connection, READ_META, { key: META_KEYS.evidenceBackfillCursor })
  const value = rows[0]?.value
  return value === undefined || value === null ? '' : String(value)
}

async function writeCursor(connection: lbug.Connection, value: string): Promise<void> {
  const statement = await connection.prepare(MERGE_META)
  // 结果必须释放，否则 pin 满 buffer pool（见 ../db/backend.ts closeQueryResult）。
  await runPrepared(connection, statement, { key: META_KEYS.evidenceBackfillCursor, value })
}

/**
 * 读证据回填游标（Story 2.5 / 评审 P18）：`null` = 从未跑过（库里还没有这个键）。
 *
 * 存在的理由：判据① 对 `no-evidence-edge` 要区分「**暂时**不可判定」与「回填已跑完仍无入边」。
 * 只有后者才是终局丢弃 —— 升级库里 2.6 之前写入的 legacy L1 没有边，回填（每轮 ≤50、按
 * recorded_at ASC）可能还没跑到它，此时把候选 done + 来源 gate-fail 是不可恢复的损失。
 */
export async function readEvidenceBackfillCursor(connection: lbug.Connection): Promise<string | null> {
  const rows = await queryRows(connection, READ_META, { key: META_KEYS.evidenceBackfillCursor })
  const value = rows[0]?.value
  return value === undefined || value === null ? null : String(value)
}

export function createEvidenceBackfill(options: EvidenceBackfillOptions): EvidenceBackfill {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? EVIDENCE_BACKFILL_BATCH_SIZE))
  const runOnce = async (): Promise<number> => {
    if (!options.gate.isIdle()) return 0
    const connection = options.connection()
    if (!connection) return 0
    const cursor = await readCursor(connection)
    if (cursor === EVIDENCE_BACKFILL_DONE) return 0
    const separator = cursor.indexOf('|')
    const cursorAt = separator < 0 ? '' : cursor.slice(0, separator)
    const cursorId = separator < 0 ? '' : cursor.slice(separator + 1)

    const page = await queryRows(connection, PAGE_STATEMENT, {
      cursor_at: cursorAt,
      cursor_id: cursorId,
      limit: batchSize,
      now: new Date().toISOString(),
    })
    if (page.length === 0) {
      // 评审 P15（T17）：只有**游标非空**（确实扫过一段）时才能把空页判为「扫完」。
      // 游标为空 + 页空 = 空库 / 首次 maintenance 早于任何节点写入——此时写 done 会让
      // 之后新写的节点**永不回填**。直接 return 0（代价：空库每轮多一次查询，可忽略）。
      if (cursor.length > 0) {
        // 扫完了：写哨兵，之后每轮只花一次 meta 读。
        await writeCursor(connection, EVIDENCE_BACKFILL_DONE)
      }
      return 0
    }

    const l0Probe = await connection.prepare(L0_PROBE)
    const memoryProbe = await connection.prepare(MEMORY_LAYER_PROBE)
    const refLayers = new Map<string, string | null>()
    const resolveLayer = async (refId: string): Promise<string | null> => {
      if (refLayers.has(refId)) return refLayers.get(refId) ?? null
      const l0Rows = await collectRows(await connection.execute(l0Probe, { id: refId }))
      if (l0Rows.length > 0) {
        refLayers.set(refId, L0_LAYER)
        return L0_LAYER
      }
      const memoryRows = await collectRows(await connection.execute(memoryProbe, { id: refId }))
      const layer = memoryRows.length > 0 ? String(memoryRows[0]?.layer) : null
      refLayers.set(refId, layer)
      return layer
    }

    const entries: EvidenceEdgeInput[] = []
    const skipped: string[] = []
    let lastSeen = cursor
    // 评审 P1（T1）：闸门在本页中途转忙 ⇒ 尾部行**没被处理**，游标不能落 done 哨兵，
    // 否则那些行永久无 EVIDENCE 边且游标谎报完成。processed 用于审计写**实际处理行数**。
    let completed = true
    let processed = 0
    for (const row of page) {
      // 每个节点迭代前复查闸门：一轮绝不跨 turn 边界继续。
      if (!options.gate.isIdle()) {
        completed = false
        break
      }
      processed += 1
      const id = String(row.id)
      const layer = String(row.layer)
      lastSeen = String(row.recorded_at) + '|' + id
      for (const ref of new Set(toStringArray(row.source_refs))) {
        if (ref === id) {
          skipped.push('self-loop')
          continue
        }
        // ref 的层：优先 l0_raw（L0），否则查 memory 的 layer；都没有 ⇒ 悬空引用。
        const refLayer = await resolveLayer(ref)
        if (refLayer === null) {
          skipped.push('dangling-ref')
          continue
        }
        if (!isEvidenceLayerOrder(refLayer, layer)) {
          // X1×U5：同层 / 倒置 / 层值非法一律不建边（ref 仍在 source_refs 里 ⇒ 漂移可见）。
          skipped.push(
            refLayer.trim().toUpperCase() === layer.trim().toUpperCase() ? 'same-layer' : 'layer-order',
          )
          continue
        }
        entries.push({ fromId: ref, fromLayer: refLayer, toId: id, toLayer: layer, reason: BACKFILL_EVIDENCE_REASON })
      }
    }

    // 一个节点都没处理（闸门在页首就转忙）⇒ 游标不动，下一轮重来。
    if (lastSeen === cursor && entries.length === 0) return 0

    const outcome = skipped.length > 0 ? 'uncertain' : 'success'
    const reason =
      'nodes=' + String(processed) + ' edges=' + String(entries.length) +
      (skipped.length > 0 ? ' skipped=' + String(skipped.length) + ' first=' + (skipped[0] ?? '') : '')
    let written = 0
    await runInTransaction(connection, async () => {
      // AD-10 置序：先写日志后写边。日志与边同事务，崩溃后不产生「有边无账」。
      await insertGenerationLog(connection, {
        recordedAt: new Date().toISOString(),
        actor: 'system',
        kind: CAPTURE_KIND,
        action: BACKFILL_EVIDENCE_ACTION,
        policy: DEFAULT_CAPTURE_POLICY,
        outcome,
        reason,
      })
      const result = await writeEvidenceEdges(connection, entries)
      written = result.written
      // 评审 P7（T7）：游标推进移入**同一事务**（写在写边与审计之后）。放在事务外时
      // COMMIT 后崩溃/任何重放会让同一批再记一次 backfill_evidence 审计行——边 MERGE 幂等，
      // 账本不幂等。空页写 done 的路径无审计，留在事务外（上面那段）。
      // 评审 P1：只有「本页全部处理完」**且**是末批（不足一页）才能写 done 哨兵。
      await writeCursor(connection, completed && processed < batchSize ? EVIDENCE_BACKFILL_DONE : lastSeen)
    })
    return written
  }
  return { runOnce }
}

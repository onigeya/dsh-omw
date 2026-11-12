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
 * 崩溃语义：边写入与审计同一事务；游标在事务**之后**推进。故进程在两者之间崩溃只会
 * 让同一批重做一遍——MERGE 幂等，不产重边。
 */
import type * as lbug from '@ladybugdb/core'
import {
  BACKFILL_EVIDENCE_ACTION,
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  insertGenerationLog,
} from '../db/audit.js'
import { isEvidenceLayerOrder, L0_LAYER, writeEvidenceEdges, type EvidenceEdgeInput } from '../db/edges.js'
import { collectRows } from '../db/rows.js'
import { L0_RAW_TABLE, MEMORY_TABLE, META_KEYS, META_TABLE } from '../db/schema.js'
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
  'WHERE m.recorded_at > $cursor_at OR (m.recorded_at = $cursor_at AND m.id > $cursor_id)',
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
  await connection.execute(statement, { key: META_KEYS.evidenceBackfillCursor, value })
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
    })
    if (page.length === 0) {
      // 扫完了：写哨兵，之后每轮只花一次 meta 读。
      await writeCursor(connection, EVIDENCE_BACKFILL_DONE)
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
    for (const row of page) {
      // 每个节点迭代前复查闸门：一轮绝不跨 turn 边界继续。
      if (!options.gate.isIdle()) break
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
      'nodes=' + String(page.length) + ' edges=' + String(entries.length) +
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
    })
    // 游标推进放在事务外：回填幂等（MERGE），崩溃重放只会重做同一批的 MERGE。
    await writeCursor(connection, page.length < batchSize ? EVIDENCE_BACKFILL_DONE : lastSeen)
    return written
  }
  return { runOnce }
}

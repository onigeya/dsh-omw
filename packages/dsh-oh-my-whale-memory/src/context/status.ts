/**
 * 上下文管理的可观测面（Story 8.1 / AC:1566-1568、INV-5）。
 *
 * 两个数据源：
 * - **归因账本**：最近一次 `measure()` 的归因结果（进程内快照；`measure()` 是宿主调用，不能凭空造）；
 * - **压缩运行**：`compaction_run` 表的计数与最近一次（落库，可跨重启）。
 *
 * INV-5：门控/裁剪只能依据 `measure()`；本模块只**展示**，不提供任何压力启发式。
 */
import type * as lbug from '@ladybugdb/core'
import { queryRows } from '../db/rows.js'
import { COMPACTION_RUN_TABLE } from '../db/schema.js'
import { attributeSurface, type AttributionLedger, type SeqSourceIndex } from './attribution.js'

/** 归因账本的进程内快照（由调用方在拿到 measure() 后写入）。 */
export interface AttributionSnapshot {
  readonly ledger: AttributionLedger
  readonly capturedAt: string
  /** 本次归因识别的主题来源数（`seq → 来源` 索引大小）；0 = 索引完全缺失。 */
  readonly indexedSeqs: number
}

export interface ContextStatusView {
  /** 最近一次归因（未采过 = null，status 渲染 `n/a`）。 */
  readonly attribution: AttributionSnapshot | null
  /** `compaction_run` 行数（= 压缩次数，SM-8 ④ 的可观测口径）。 */
  readonly compactionRuns: number
  /** 最近一次压缩（null = 从未压缩）。 */
  readonly lastCompaction: { readonly compactionId: string, readonly sessionId: string, readonly startedAt: string } | null
}

/** 采集一次归因快照：把 `measure()` 与 `seq→来源` 索引喂给纯函数，记下时刻。 */
export function captureAttribution(
  measure: { readonly totalTokens: number, readonly nodes: readonly { readonly seq: number, readonly tokens?: number | null, readonly heuristicTokens?: number | null }[] },
  seqIndex: SeqSourceIndex,
  nowIso: string,
): AttributionSnapshot {
  return {
    ledger: attributeSurface(measure, seqIndex),
    capturedAt: nowIso,
    indexedSeqs: seqIndex.size,
  }
}

/** 读 `compaction_run` 的计数与最近一条。 */
export async function readCompactionStatus(connection: lbug.Connection): Promise<{
  readonly compactionRuns: number
  readonly lastCompaction: ContextStatusView['lastCompaction']
}> {
  // 表缺失（旧库未迁移）时按「从未压缩」处理，不阻塞 status。
  const rows = await queryRows(
    connection,
    [
      'MATCH (r:' + COMPACTION_RUN_TABLE + ')',
      '  RETURN count(r) AS total,',
      '  max(r.started_at) AS last_started',
    ].join('\n'),
  ).catch(() => [])
  const total = Number(rows[0]?.total ?? 0)
  const lastStarted = rows[0]?.last_started
  if (total === 0 || lastStarted === undefined || lastStarted === null) {
    return { compactionRuns: 0, lastCompaction: null }
  }
  const lastRows = await queryRows(
    connection,
    [
      'MATCH (r:' + COMPACTION_RUN_TABLE + ')',
      '  WHERE r.started_at = $started',
      '  RETURN r.compaction_id AS compaction_id, r.session_id AS session_id, r.started_at AS started_at',
      '  ORDER BY r.compaction_id ASC LIMIT 1',
    ].join('\n'),
    { started: String(lastStarted) },
  ).catch(() => [])
  const row = lastRows[0]
  if (row === undefined) return { compactionRuns: total, lastCompaction: null }
  return {
    compactionRuns: total,
    lastCompaction: {
      compactionId: String(row.compaction_id ?? ''),
      sessionId: String(row.session_id ?? ''),
      startedAt: String(row.started_at ?? ''),
    },
  }
}


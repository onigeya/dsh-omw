/**
 * 压缩产物的纯映射（Story 8.1 / FR-24、AC:1528-1538）。
 *
 * 宿主发出 `compaction/summary` 时，本模块把 payload 折成「要写进 INBOX 的 L1 条目」与**幂等键**。
 * 只做纯计算：订阅、写库、readOnly 判断都在第 2 轮的接线层；这样「带哪些字段、怎么判幂等」可以先钉死。
 *
 * 三条纪律：
 * 1. 摘要作为 **L1** 入 INBOX（不是 L0，也不是直接写 memory）；
 * 2. 必须带 `shadowedSeqs` 与 `shadowedRange{start,end}`（FR-24），缺失时**不编造**；
 * 3. 幂等键 = `(sessionId, compactionId)` 的稳定字符串（AC:1532-1534）。
 */
import { MemoryDbError } from '../db/errors.js'

/** `compaction/summary` 的最小 payload 形态（宿主契约，AD-7）。 */
export interface CompactionSummaryPayload {
  readonly sessionId?: string
  readonly compactionId?: string
  readonly summary?: string
  /** 被折叠的 L0 seq 列表（可能乱序、可能重复；本模块去重并升序）。 */
  readonly shadowedSeqs?: readonly number[]
  /** 被折叠的区间；两端都必须给出（只有一端视为非法）。 */
  readonly shadowedRange?: { readonly start?: number | null, readonly end?: number | null } | null
  /** `null` = 独立手动触发（AC:1543）。 */
  readonly turn?: number | null
}

export interface CompactionSummaryEntry {
  /** 幂等键：同一 `(sessionId, compactionId)` 恒同值。 */
  readonly key: string
  readonly sessionId: string
  readonly compactionId: string
  readonly layer: 'L1'
  readonly text: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedRange: { readonly start: number, readonly end: number } | null
  readonly turn: number | null
  /** 解析期的降级说明（例如 range 只有一端 ⇒ null），用于账本，不阻断写入。 */
  readonly notes: readonly string[]
}

/** 幂等键：`compaction:<sessionId>#<compactionId>`（两个 id 都可能含 `:`，用 `#` 分隔避免歧义）。 */
export function compactionSummaryKey(sessionId: string, compactionId: string): string {
  return 'compaction:' + sessionId + '#' + compactionId
}

function normalizeSeqs(seqs: readonly number[] | undefined): number[] {
  if (seqs === undefined) return []
  const valid = seqs.filter((seq) => Number.isInteger(seq) && seq >= 0)
  return [...new Set(valid)].sort((left, right) => left - right)
}

/**
 * 把 payload 折成 INBOX 条目。
 *
 * 抛错条件（`compaction_summary_invalid`）：缺 `sessionId` / 缺 `compactionId` / 摘要正文为空。
 * 这三种情况写进库都会产生无主或空节点，属于「不可恢复的脏数据」，故 fail-loud（AC:1560 的口径）。
 */
export function buildCompactionSummaryEntry(payload: CompactionSummaryPayload): CompactionSummaryEntry {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  const compactionId = typeof payload.compactionId === 'string' ? payload.compactionId.trim() : ''
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  if (sessionId === '') {
    throw new MemoryDbError('compaction_summary_invalid', 'compaction/summary 缺 sessionId，拒绝入图')
  }
  if (compactionId === '') {
    throw new MemoryDbError('compaction_summary_invalid', 'compaction/summary 缺 compactionId，拒绝入图')
  }
  if (summary === '') {
    throw new MemoryDbError('compaction_summary_invalid', 'compaction/summary 摘要正文为空，拒绝入图')
  }

  const notes: string[] = []
  const shadowedSeqs = normalizeSeqs(payload.shadowedSeqs)
  if (payload.shadowedSeqs === undefined) notes.push('missing-shadowed-seqs')
  if (payload.shadowedSeqs !== undefined && shadowedSeqs.length !== payload.shadowedSeqs.length) {
    notes.push('shadowed-seqs-normalized')
  }

  let shadowedRange: { start: number, end: number } | null = null
  const range = payload.shadowedRange
  const start = range?.start
  const end = range?.end
  const hasStart = typeof start === 'number' && Number.isInteger(start) && start >= 0
  const hasEnd = typeof end === 'number' && Number.isInteger(end) && end >= 0
  if (hasStart && hasEnd) {
    shadowedRange = start <= end ? { start, end } : { start: end, end: start }
    if (start > end) notes.push('shadowed-range-swapped')
  } else if (range !== undefined && range !== null) {
    // 只有一端：不编造另一端（AC:1530 要求两端），记 note 并留 null。
    notes.push('shadowed-range-incomplete')
  } else {
    notes.push('missing-shadowed-range')
  }

  return {
    key: compactionSummaryKey(sessionId, compactionId),
    sessionId,
    compactionId,
    layer: 'L1',
    text: summary,
    shadowedSeqs,
    shadowedRange,
    turn: typeof payload.turn === 'number' ? payload.turn : null,
    notes,
  }
}

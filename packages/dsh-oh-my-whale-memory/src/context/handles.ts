/**
 * 句柄节点的读写（Story 8.2 / FR-23、INV-3、INV-4、INV-6）。
 *
 * 存储选择：复用 `memory` 表的 **L1** 节点（`kind='handle'`，`source_refs` 指向会话日志 seq），
 * 不新建表——句柄只需要「按 id 取正文」，没有额外索引维度；正文仍永存 append-only 的 L0（INV-4）。
 *
 * 幂等（INV-6）：AD-4 的节点 id 是**正文指纹**，编码不了 `(session, seq)`，因此幂等靠
 * `findHandleBySeq` 先查后写；同 `(session, seq)` 第二次折叠直接返回既有节点（不写第二份）。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from '../db/errors.js'
import { memoryNodeId } from '../db/id.js'
import { writeMemoryVersion, type MemoryDetail } from '../db/memory.js'
import { queryRows } from '../db/rows.js'
import { MEMORY_TABLE } from '../db/schema.js'
import { MEMORY_REMEMBER_LAYER } from '../shared/memory-vocab.js'

/** 句柄节点的固定 kind（与七类记忆 kind 并列，但语义是「折叠占位」）。 */
export const HANDLE_KIND = 'handle'

/** 句柄 id 的**展示用**推导（实际节点 id 由正文指纹决定，见文件头说明）。 */
export function handleId(sessionId: string, seq: number): string {
  return memoryNodeId(MEMORY_REMEMBER_LAYER, 'handle:' + sessionId + '#' + String(seq))
}

export interface HandleRecord {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly text: string
  readonly invalidAt: string | null
  readonly expiredAt: string | null
}

const READ_HANDLE = [
  'MATCH (m:' + MEMORY_TABLE + ' {id: $id})',
  'RETURN m.id AS id, m.text AS text, m.source_refs AS source_refs,',
  '  m.invalid_at AS invalid_at, m.expired_at AS expired_at',
].join('\n')

const FIND_BY_SEQ = [
  'MATCH (m:' + MEMORY_TABLE + ')',
  "  WHERE m.kind = '" + HANDLE_KIND + "'",
  "    AND 'session:' + $session IN m.source_refs",
  "    AND 'seq:' + $seq IN m.source_refs",
  '  RETURN m.id AS id, m.text AS text, m.source_refs AS source_refs,',
  '    m.invalid_at AS invalid_at, m.expired_at AS expired_at LIMIT 1',
].join('\n')

function toRecord(row: Record<string, unknown> | undefined): HandleRecord | null {
  if (row === undefined) return null
  const refs = Array.isArray(row.source_refs) ? row.source_refs.map(String) : []
  const sessionRef = refs.find((ref) => ref.startsWith('session:'))
  const seqRef = refs.find((ref) => ref.startsWith('seq:'))
  return {
    id: String(row.id),
    sessionId: sessionRef === undefined ? '' : sessionRef.slice('session:'.length),
    seq: seqRef === undefined ? -1 : Number.parseInt(seqRef.slice('seq:'.length), 10),
    text: String(row.text ?? ''),
    invalidAt: row.invalid_at === null || row.invalid_at === undefined ? null : String(row.invalid_at),
    expiredAt: row.expired_at === null || row.expired_at === undefined ? null : String(row.expired_at),
  }
}

/**
 * 写一条句柄节点。`source_refs` 带 `session:<id>` 与 `seq:<n>`，既做幂等键来源，也让
 * 「来自其它 session」可判（AC:1619-1621 的 `session_mismatch`）。
 */
export async function writeHandle(
  connection: lbug.Connection,
  input: {
    readonly sessionId: string
    readonly seq: number
    readonly text: string
    readonly recordedAt: string
    readonly tokens?: number
  },
): Promise<HandleRecord> {
  if (input.text === '') {
    throw new MemoryDbError('handle_text_empty', '句柄正文为空，拒绝写入（空句柄无法还原任何内容）')
  }
  // 幂等：同 (session, seq) 已有句柄 ⇒ 直接返回（不写第二份，INV-6）。
  const existing = await findHandleBySeq(connection, input.sessionId, input.seq)
  if (existing !== null) return existing
  const written = await writeMemoryVersion(connection, {
    layer: MEMORY_REMEMBER_LAYER,
    text: input.text,
    kind: HANDLE_KIND,
    priority: 0,
    support: input.tokens ?? null,
    validAt: input.recordedAt,
    recordedAt: input.recordedAt,
    sourceRefs: ['session:' + input.sessionId, 'seq:' + String(input.seq)],
  }, { now: () => new Date(input.recordedAt) })
  const record = await readHandle(connection, written.id)
  if (record === null) {
    throw new MemoryDbError('handle_write_failed', '句柄节点写入后读不回（id=' + written.id + '）')
  }
  return record
}

/**
 * 按 id 读句柄。**不抛**：不存在 / 表缺失都返回 null，由调用方映射成 fail-open 的失败信封。
 */
export async function readHandle(connection: lbug.Connection, id: string): Promise<HandleRecord | null> {
  const rows = await queryRows(connection, READ_HANDLE, { id }).catch(() => [])
  return toRecord(rows[0])
}

/** 按 `(sessionId, seq)` 找既有句柄（AC:1630 的幂等键）。 */
export async function findHandleBySeq(
  connection: lbug.Connection,
  sessionId: string,
  seq: number,
): Promise<HandleRecord | null> {
  // 0.22.3 里 `'session:' + $p IN list` 的语义不稳定（实测取不到行），改为按 kind 取回后在 JS 侧过滤：
  // 句柄数量级远小于全表，且过滤条件与索引无关。
  const rows = await queryRows(
    connection,
    [
      'MATCH (m:' + MEMORY_TABLE + ')',
      "  WHERE m.kind = '" + HANDLE_KIND + "'",
      '  RETURN m.id AS id, m.text AS text, m.source_refs AS source_refs,',
      '    m.invalid_at AS invalid_at, m.expired_at AS expired_at',
    ].join('\n'),
  ).catch(() => [])
  const sessionRef = 'session:' + sessionId
  const seqRef = 'seq:' + String(seq)
  for (const row of rows) {
    const refs = Array.isArray(row.source_refs) ? row.source_refs.map(String) : []
    if (refs.includes(sessionRef) && refs.includes(seqRef)) return toRecord(row)
  }
  return null
}

/** 读句柄并按 AC:1619-1621 归因失败原因（不抛；调用方据此决定 retryable）。 */
export type HandleLookupFailure = 'handle_not_found' | 'handle_expired' | 'session_mismatch'

export function classifyHandle(
  record: HandleRecord | null,
  sessionId: string,
): { readonly ok: true, readonly record: HandleRecord } | { readonly ok: false, readonly failure: HandleLookupFailure } {
  if (record === null) return { ok: false, failure: 'handle_not_found' }
  if (record.sessionId !== '' && sessionId !== '' && record.sessionId !== sessionId) {
    return { ok: false, failure: 'session_mismatch' }
  }
  if (record.invalidAt !== null || record.expiredAt !== null) return { ok: false, failure: 'handle_expired' }
  return { ok: true, record }
}

/** 供 status/审计使用：句柄正文的 UTF-8 字节数（不改写正文）。 */
export function handleByteLength(record: MemoryDetail | HandleRecord): number {
  return Buffer.byteLength(record.text, 'utf8')
}

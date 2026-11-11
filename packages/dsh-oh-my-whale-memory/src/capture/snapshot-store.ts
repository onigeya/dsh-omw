/**
 * 压缩快照的崩溃标记（Story 2.1 / AC②⑤）：临时文件 + rename 保证「快照已落盘」是原子的；
 * 文件在「L0 行 + INBOX 行」事务提交被确认后删除，因此残留文件 = 崩溃孤儿，启动时重放。
 *
 * 同步 API 是刻意的：compaction/start 的 < 50ms 预算辖同步路径（见 spec 的 Spec Change Log）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SNAPSHOT_SUFFIX = '.snap'
/** 写一半的临时文件后缀（rename 前的形态）：启动扫描时清理（评审 P10）。 */
export const SNAPSHOT_TEMP_SUFFIX = SNAPSHOT_SUFFIX + '.tmp'

export interface SnapshotRecord {
  readonly stableKey: string
  readonly kind: string
  readonly sessionId: string
  readonly ref: string
  readonly text: string
  readonly actor: string
  readonly recordedAt: string
  /** 文件名（listSnapshots 填充；writeSnapshot 入参不需要）。 */
  readonly file?: string
}

/**
 * 文件名 = stableKey 的 SHA-1：把 ':' 之类分隔符替换成 '_' 不是单射（'a:b' 与 'a_b' 撞名），
 * 撞名会让后写的标记覆盖先写的 ⇒ 那条采集永远不会入队。stableKey 在文件内容里，仍可人工定位。
 */
function snapshotFileName(stableKey: string): string {
  return createHash('sha1').update(stableKey, 'utf8').digest('hex') + SNAPSHOT_SUFFIX
}

/** 同步落盘（临时文件 + rename）。返回最终文件名。 */
export function writeSnapshot(dir: string, record: SnapshotRecord): string {
  mkdirSync(dir, { recursive: true })
  const file = snapshotFileName(record.stableKey)
  const target = join(dir, file)
  const temp = target + SNAPSHOT_TEMP_SUFFIX
  writeFileSync(temp, JSON.stringify(record), 'utf8')
  renameSync(temp, target)
  return file
}

/**
 * 形状校验（评审 P8）：L0 是 append-only，畸形记录一旦写进去就永久留下垃圾行，
 * 所以重放前必须逐字段验；不合格的记录一律「跳过 + 保留文件」，绝不写库。
 * 返回 null 表示合格，否则返回人类可读的不合格原因。
 */
function snapshotInvalidReason(record: SnapshotRecord): string | null {
  const required: ReadonlyArray<readonly [string, unknown]> = [
    ['stableKey', record.stableKey],
    ['kind', record.kind],
    ['sessionId', record.sessionId],
    ['ref', record.ref],
    ['actor', record.actor],
    ['text', record.text],
  ]
  for (const [field, value] of required) {
    if (typeof value !== 'string' || value.trim().length === 0) return field + ' 不是非空字符串'
  }
  if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
    return 'recordedAt 不是可解析的时间'
  }
  if (record.file !== snapshotFileName(record.stableKey)) return 'stableKey 与文件名 sha1 不一致'
  return null
}

/** 读目录名；目录不存在 / 不可读一律当作空（首次启动时快照目录还不存在是常态）。 */
function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 启动扫描时清理陈旧临时文件（评审 P10）：只删 SNAPSHOT_TEMP_SUFFIX 结尾的文件。
 * rename 是原子的，所以 .tmp 只可能来自「写到一半进程死了」；清理幂等且安全。返回清理条数。
 */
export function cleanStaleSnapshotTemps(dir: string): number {
  let removed = 0
  for (const name of readDirNames(dir)) {
    if (!name.endsWith(SNAPSHOT_TEMP_SUFFIX)) continue
    try {
      unlinkSync(join(dir, name))
      removed += 1
    } catch {
      // 幂等：删不掉不影响启动。
    }
  }
  return removed
}
/**
 * 扫描目录中的快照记录：坏文件、形态不合法的记录一律跳过（不阻塞启动），并保留文件。
 * onInvalid(file, reason) 供调用方留下可见信号（评审 P8：静默跳过等于悄悄丢采集）。
 */
export function listSnapshots(
  dir: string,
  onInvalid?: (file: string, reason: string) => void,
): SnapshotRecord[] {
  const records: SnapshotRecord[] = []
  for (const name of readDirNames(dir)) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      onInvalid?.(name, 'JSON 解析失败')
      continue
    }
    const candidate = { ...(parsed as SnapshotRecord), file: name }
    const reason = snapshotInvalidReason(candidate)
    if (reason !== null) {
      onInvalid?.(name, reason)
      continue
    }
    records.push(candidate)
  }
  return records
}

/** 删除已确认落库的快照标记（不存在/已删都算成功）。 */
export function removeSnapshot(dir: string, file: string): void {
  try {
    unlinkSync(join(dir, file))
  } catch {
    // 幂等：删除失败不影响调用方。
  }
}

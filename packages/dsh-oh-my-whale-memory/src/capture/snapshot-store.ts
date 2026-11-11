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
function fileNameFor(stableKey: string): string {
  return createHash('sha1').update(stableKey, 'utf8').digest('hex') + SNAPSHOT_SUFFIX
}

/** 同步落盘（临时文件 + rename）。返回最终文件名。 */
export function writeSnapshot(dir: string, record: SnapshotRecord): string {
  mkdirSync(dir, { recursive: true })
  const file = fileNameFor(record.stableKey)
  const target = join(dir, file)
  const temp = target + '.tmp'
  writeFileSync(temp, JSON.stringify(record), 'utf8')
  renameSync(temp, target)
  return file
}

/** 扫描目录中的快照记录（坏文件跳过，不阻塞启动）。 */
export function listSnapshots(dir: string): SnapshotRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records: SnapshotRecord[] = []
  for (const name of names) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SnapshotRecord
      records.push({ ...parsed, file: name })
    } catch {
      // 坏快照不是可重放事实：跳过，保留文件供人工排查。
    }
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

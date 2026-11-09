/**
 * 记忆库路径（AC1 / AD-13）：`$DSH_HOME/profiles/<name>/memory/lbug.db`。
 *
 * profile 目录来自宿主注入的 `profileContext.dir`（= `$DSH_HOME/profiles/<name>`），
 * 不自行拼接 DSH_HOME——目录就是唯一事实来源，永远跟随 profile。
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { MemoryDbError } from './errors.js'

export const MEMORY_DB_DIR = 'memory'
export const MEMORY_DB_FILENAME = 'lbug.db'

/** 由 profile 目录解析库文件绝对路径。 */
export function resolveMemoryDbPath(profileDir: string): string {
  if (!profileDir || !profileDir.trim()) {
    throw new MemoryDbError('db_open_failed', 'profile 目录为空，无法定位记忆库（期望 profileContext.dir 指向 $DSH_HOME/profiles/<name>）')
  }
  return join(resolve(profileDir), MEMORY_DB_DIR, MEMORY_DB_FILENAME)
}

/** 建库前确保 `<profile>/memory/` 目录存在（AC1：目录不存在则创建）。 */
export async function ensureMemoryDbDirectory(dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true })
}

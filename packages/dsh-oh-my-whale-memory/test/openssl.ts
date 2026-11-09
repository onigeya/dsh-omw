/**
 * Windows 上 `@ladybugdb/core` 的 vector/fts 扩展动态链接 OpenSSL 3
 * （libssl-3-x64.dll / libcrypto-3-x64.dll），pnpm 不会随包分发它们。
 *
 * 唯一事实来源：abi-smoke.test.ts 与各 db-* 测试都从这里 import，不再各自复制。
 * 在打开数据库**之前**把首个存在的目录加入进程 PATH。
 * Linux/macOS 系统自带 OpenSSL 3 时等价于 no-op。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function injectOpenSslPath(): void {
  const userProfile = process.env.USERPROFILE
  const candidates = [
    'C:\\Program Files\\Git\\mingw64\\bin',
    userProfile
      ? join(userProfile, '.dsh', 'profiles', 'web', 'node_modules', '@dsh-ops', 'bash-win32-x64', 'ucrt64', 'bin')
      : null,
  ].filter((p): p is string => p !== null)
  for (const dir of candidates) {
    if (existsSync(dir)) {
      process.env.PATH = `${dir};${process.env.PATH}`
      return
    }
  }
}

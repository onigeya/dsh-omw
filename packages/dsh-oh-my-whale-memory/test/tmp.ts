/**
 * 共享测试临时目录脚手架。
 *
 * 各 db-* / 工具 / 入口测试都需要「mkdtemp → 登记到数组 → afterAll 逐个 rm（best-effort）」
 * 这套样板。本模块把三段收拢成两件事：
 * - `makeTempDir(prefix)` 建目录并登记，返回目录绝对路径；
 * - `cleanupTempDirs()` 在 `afterAll` 里调用一次，best-effort 删除所有登记过的目录。
 *
 * 故意**不**在这里注册 afterAll 钩子，也**不**注入 OpenSSL——前者在 import 期
 * 触发 vitest 钩子注册有文件级边界风险；后者不是所有测试都需要（db-writer-lock /
 * db-paths 不打开 LadybugDB）。调用方各保留一行 `afterAll(cleanupTempDirs)` 与
 * 自己的 `injectOpenSslPath()` 责任。
 *
 * 注意：需要「故意不存在的路径」的用例（如断 ENOENT）**不要**经 makeTempDir 登记，
 * 否则 cleanup 会把这条断言用到的路径真的建出来 / 删掉，掩盖被测行为。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

/** 建一个带前缀的临时目录并登记，供 cleanupTempDirs 统一清理。 */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** best-effort 删除 makeTempDir 登记过的所有目录；失败不抛（清理失败不 fail 测试）。 */
export async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

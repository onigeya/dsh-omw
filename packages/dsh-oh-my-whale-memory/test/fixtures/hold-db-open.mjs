/**
 * 跨进程"第一实例"夹具（Story 1.5 测试用，非生产代码）。
 *
 * 复刻宿主真实写者路径的顺序：**先 `withFileLock` 抢写者锁，再以读写打开库**——
 * 顺序反了 LadybugDB 会以 `Error: 33` 拒绝（存在只读句柄时读写打开必失败）。
 *
 * 用法：`node hold-db-open.mjs <dbPath>`
 * - 父进程经 stdin 写一行 JSON：`{"statements": ["..."]}`（建库语句由父进程从
 *   `src/db/schema.ts` 取，保证与本插件建库时执行的 DDL 单一事实来源）；
 * - 建库完成并持锁后向 stdout 打印 `ready`；
 * - 父进程关闭 stdin → 正常释放锁并退出（锁文件被移除）；
 * - 父进程直接 kill → 进程消失、锁文件残留，用于制造 AC3 的陈旧锁场景。
 *
 * OpenSSL 3 的 PATH 由父进程 `injectOpenSslPath()` 注入后随 spawn 继承——建
 * vector/fts 索引需要它（PATH 里没有 Git for Windows 时这一步会失败）。
 */
import { createInterface } from 'node:readline'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import * as lbug from '@ladybugdb/core'

const dbPath = process.argv[2]
if (!dbPath) {
  process.stderr.write('hold-db-open: 缺少 <dbPath> 参数\n')
  process.exit(2)
}

try {
  const lines = createInterface({ input: process.stdin })
  const request = JSON.parse(await new Promise((resolve) => lines.once('line', resolve)))

  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  lines.once('close', () => releaseGate())

  await withFileLock(
    dbPath,
    async () => {
      const database = new lbug.Database(dbPath)
      const connection = new lbug.Connection(database)
      for (const statement of request.statements) await connection.query(statement)
      process.stdout.write('ready\n')
      await gate
      connection.closeSync()
      database.closeSync()
    },
    { waitMs: 0 },
  )
  process.exit(0)
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`)
  process.exit(1)
}

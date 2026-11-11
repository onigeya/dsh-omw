/**
 * 跨进程"第一实例"夹具（Story 1.5 测试用，非生产代码）。
 *
 * 复刻宿主真实写者路径的顺序：**先 `withFileLock` 抢写者锁，再以读写打开库**——
 * 顺序反了 LadybugDB 会以 `Error: 33` 拒绝（存在只读句柄时读写打开必失败）。
 *
 * 用法：`node hold-db-open.mjs <dbPath>`
 * - 父进程经 stdin 写一行 JSON：`{"statements": [...], "delayMs": 0, "readyEarly": false}`
 *   （建库语句由父进程从 `src/db/schema.ts` 取，保证与本插件建库时执行的 DDL 单一事实来源）；
 *   `delayMs` / `readyEarly` 用于复现启动竞态：`readyEarly` 让 `ready` 在抢到锁后立刻打印
 *   （此时 DDL 尚未执行），`delayMs` 在建库前等待，从而制造"写者持锁但库文件还没落盘"的窗口；
 * - 建库完成并持锁后向 stdout 打印 `ready`；
 * - 父进程关闭 stdin → 正常释放锁并退出（锁文件被移除）；
 * - 父进程直接 kill → 进程消失、锁文件残留，用于制造 AC3 的陈旧锁场景。
 *
 * 建 vector/fts 索引需要 OpenSSL 3：其 DLL 目录必须已在父进程 PATH 中，
 * 由 spawn 继承（PATH 里没有时这一步会失败）。
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
  const statements = request.statements ?? []
  const delayMs = request.delayMs ?? 0
  const readyEarly = request.readyEarly === true

  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  lines.once('close', () => releaseGate())

  await withFileLock(
    dbPath,
    async () => {
      // readyEarly：抢到锁就宣告就绪，DDL 稍后再做——用于复现"写者持锁但库文件尚未落盘"。
      if (readyEarly) process.stdout.write('ready\n')
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const database = new lbug.Database(dbPath)
      const connection = new lbug.Connection(database)
      for (const statement of statements) await connection.query(statement)
      if (!readyEarly) process.stdout.write('ready\n')
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

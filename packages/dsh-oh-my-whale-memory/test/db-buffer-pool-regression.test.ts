/**
 * buffer pool 泄漏回归测试（2026-11-14 修复）。
 *
 * 背景（实测基线，@ladybugdb/core 0.22.3，native 后端，Windows 11 x64 / Node 24）：
 * LadybugDB 的 `QueryResult` 在存活期间持有 native 结果对象、持续 pin 住 buffer pool 的页。
 * 未释放的 `await connection.query(...)` 在 **bufferManagerSize = 64MB** 下第 **195** 次左右
 * 即抛 `Buffer manager exception: Unable to allocate memory! The buffer pool is full and no
 * memory could be freed!`（本机复测「query + getAll 但不 close」在第 174 次失败，阈值随语句
 * 形态与池内页分布小幅浮动）；一旦池满，**同连接的所有查询与写入**都抛该异常（上层 catch 会把
 * 它吞成静默失败/数据丢失）。修复后同一配置可跑上万次。
 *
 * 修复面（本文件保护的行为）：
 * - `src/db/backend.ts`：`closeQueryResult` / `runStatement` / `runPrepared` 成对释放结果；
 * - `src/db/rows.ts`：`collectRows`（`queryAll` 的实现）在 **finally** 里释放结果，取行抛错
 *   的错误路径也不泄漏。
 *
 * 本测试**直接建库**（不经 openMemoryDatabase），以便显式把 buffer pool 压到 64MB —— 插件
 * 生产路径用默认池，泄漏要更久才爆；64MB 让「不释放」在 ~195 次就失败，回归才有意义。
 *
 * Windows/LadybugDB 约束：同一进程内 `close()` 后不能重开同一库文件
 * （`IO exception: Could not set lock on file ... (Error: 33)`），所以**只开一次库**；
 * 数据行与表都留在这个库内。临时目录清理失败可忽略（句柄由进程退出回收）。
 */
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as lbug from '@ladybugdb/core'
import { runPrepared, runStatement } from '../src/db/backend'
import { queryAll } from '../src/db/rows'
import { cleanupTempDirs, makeTempDir } from './tmp'

/** 修复前实测 ~195 次即耗尽的池大小（见文件头）。 */
const BUFFER_POOL_BYTES = 64 * 1024 * 1024

/**
 * 循环次数：远高于 195 的失败阈值（12.8 倍），又能在单个测试的超时内跑完。
 * 取整到 2500 便于「每 250 次插一次写」的分段断言。
 */
const READ_ITERATIONS = 2500

let database: lbug.Database | undefined
let connection: lbug.Connection | undefined

afterAll(async () => {
  // best-effort：清理临时目录失败不 fail 测试（Windows 上库文件可能仍被占用）。
  try {
    connection?.closeSync?.()
  } catch {
    /* ignore */
  }
  try {
    database?.closeSync?.()
  } catch {
    /* ignore */
  }
  await cleanupTempDirs()
})

describe('buffer pool 泄漏回归（64MB 池 + 2500 次查询）', () => {
  it('queryAll 连续 2500 次不耗尽 buffer pool，且写语句走 runStatement/runPrepared 同样释放', async () => {
    const dir = await makeTempDir('omw-bufpool-')
    // 显式 64MB bufferManagerSize（native 签名：path, bufferManagerSize, enableCompression, readOnly）。
    // 池大小是本测试的关键参数：不改这里就等于放弃回归能力。
    database = new lbug.Database(join(dir, 'lbug.db'), BUFFER_POOL_BYTES, undefined, false)
    connection = new lbug.Connection(database)

    // 最小节点表 + 1 行（DDL 与写入都走修复后的 helper，它们内部会释放结果）。
    await runStatement(connection, 'CREATE NODE TABLE smoke(id STRING, n INT64, PRIMARY KEY(id))')
    const insert = await connection.prepare('CREATE (:smoke {id: $id, n: $n})')
    await runPrepared(connection, insert, { id: 'row-0', n: 0 })
    let expected = 1

    for (let i = 0; i < READ_ITERATIONS; i += 1) {
      // 每次查询都经过 rows.ts 的 queryAll：结果对象在 finally 里释放。
      // 若有人把释放删掉（回到「裸 await connection.query」），本循环会在 ~195 次后
      // 抛 "Buffer manager exception: ... The buffer pool is full ..."。
      const rows = await queryAll(connection, 'MATCH (n:smoke) RETURN count(n) AS c')
      expect(Number(rows[0]?.c)).toBe(expected)

      // 穿插写语句：写路径不释放结果同样会 pin 页，不能只测读。
      if (i % 250 === 0) {
        await runPrepared(connection, insert, { id: `write-${i}`, n: i })
        expected += 1
      }
      if (i % 125 === 0) {
        await runStatement(connection, `MATCH (n:smoke {id: 'row-0'}) SET n.n = ${i}`)
      }
    }

    // 循环结束后池内仍应可正常读（未释放的旧实现此时已池满，任何查询都抛异常）。
    const finalCount = await queryAll(connection, 'MATCH (n:smoke) RETURN count(n) AS c')
    expect(Number(finalCount[0]?.c)).toBe(expected)
  }, 60_000)
})

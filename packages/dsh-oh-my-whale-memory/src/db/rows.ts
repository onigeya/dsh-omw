/**
 * 查询结果行归一（Story 1.10 从 ./memory.ts 抽出）。
 *
 * LadybugDB 只在**多语句**时才把结果包成数组（见
 * node_modules/@ladybugdb/core/lbug.d.ts:250/287），单语句返回裸 QueryResult。
 * 这条非显然规则只在本文件陈述一次——写查询与读查询各自复制一份是 bug 源头。
 *
 * 抽成独立模块的原因：审计层（./audit.ts）与记忆层（./memory.ts）都要用它，
 * 而 ./memory.ts 反过来要 import 审计层；helper 留在 ./memory.ts 会形成模块环
 * （AGENTS.md「不假设 hoisting」）。
 */
import type * as lbug from '@ladybugdb/core'
import { closeQueryResult, collectResultRows } from './backend.js'

/**
 * 取第一条结果集的全部行（多语句时 query() 返回结果集数组），并**释放结果对象**。
 *
 * 取行与释放必须成对：结果对象存活即 pin 住 buffer pool 的页，泄漏会在若干次查询后把池
 * 塞满并让同连接的一切查询/写入失败（实测见 backend.ts 的 closeQueryResult）。
 * 释放放在 finally：取行抛错同样要回收，否则错误路径也在泄漏。
 */
export async function collectRows(
  result: lbug.QueryResult | lbug.QueryResult[],
): Promise<Record<string, unknown>[]> {
  try {
    // 取行方式按结果对象自身能力分派（native getAll / wasm getAllObjects），见 backend.ts。
    return await collectResultRows(result)
  } finally {
    await closeQueryResult(result)
  }
}

/** 无参查询取全部行。 */
export async function queryAll(
  connection: lbug.Connection,
  statement: string,
): Promise<Record<string, unknown>[]> {
  return collectRows(await connection.query(statement))
}

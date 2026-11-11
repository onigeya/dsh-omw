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

/** 取第一条结果集的全部行（多语句时 query() 返回结果集数组）。 */
export async function collectRows(
  result: lbug.QueryResult | lbug.QueryResult[],
): Promise<Record<string, unknown>[]> {
  const first = Array.isArray(result) ? result[0]! : result
  return (await first.getAll()) as Record<string, unknown>[]
}

/** 无参查询取全部行。 */
export async function queryAll(
  connection: lbug.Connection,
  statement: string,
): Promise<Record<string, unknown>[]> {
  return collectRows(await connection.query(statement))
}

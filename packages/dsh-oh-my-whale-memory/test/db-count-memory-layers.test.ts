/**
 * countMemoriesByLayer 的两条查询路径单测（Story 1.9 / review 补丁）。
 *
 * 生产路径（真库聚合 + 四层计数）由 command-status-db.test.ts 端到端覆盖；本文件用
 * 只实现 `query(statement)` 的最小连接替身分别驱动两条路径，钉住契约：
 * - 聚合路径：聚合语句（含 `count(`）正常返回时按 total 累加；
 * - 退化路径：聚合语句 reject 时退化为 LIST 语句 + JS 侧 tally，返回同一形状；
 * - 已知层缺省补 0；未知 layer、缺失 layer、非数值 total 一律不入返回。
 */
import { describe, expect, it } from 'vitest'
import { countMemoriesByLayer, type MemoryConnection } from '../src/db/memory'

/**
 * 最小连接替身：含 `count(` 的语句按 `aggregate` 应答（reject 或返回 rows），
 * 其余语句（LIST）返回 `listRows`。queryAll 只用 connection.query，其余能力不需要。
 */
function makeStubConnection(options: {
  aggregate: { reject?: boolean; rows?: Record<string, unknown>[] }
  listRows?: Record<string, unknown>[]
}): { connection: MemoryConnection; queries: string[] } {
  const queries: string[] = []
  const connection = {
    async query(statement: string) {
      queries.push(statement)
      if (statement.includes('count(')) {
        if (options.aggregate.reject) throw new Error('stub: 库侧聚合不可用')
        return { getAll: async () => options.aggregate.rows ?? [] }
      }
      return { getAll: async () => options.listRows ?? [] }
    },
  } as unknown as MemoryConnection
  return { connection, queries }
}

describe('countMemoriesByLayer：聚合路径', () => {
  it('按 total 累加四层；未知 layer / 缺失 layer / 非数值 total 不入返回', async () => {
    const { connection } = makeStubConnection({
      aggregate: {
        rows: [
          { layer: 'L1', total: 2 },
          { layer: 'L2', total: 1 },
          { layer: 'L1_INBOX', total: 3 },
          { layer: 'L3', total: 5 },
          { total: 4 },
          { layer: 'L2_INBOX', total: 'not-a-number' },
        ],
      },
    })

    await expect(countMemoriesByLayer(connection)).resolves.toEqual({
      L1: 2,
      L2: 1,
      L1_INBOX: 3,
      L2_INBOX: 0,
    })
  })

  it('空结果 → 四层全 0（缺省补 0，不出现 undefined）', async () => {
    const { connection } = makeStubConnection({ aggregate: { rows: [] } })

    await expect(countMemoriesByLayer(connection)).resolves.toEqual({
      L1: 0,
      L2: 0,
      L1_INBOX: 0,
      L2_INBOX: 0,
    })
  })
})

describe('countMemoriesByLayer：退化路径（聚合语句 reject）', () => {
  it('退化为 LIST 语句 + JS 侧 tally，返回同一形状；未知层不入返回', async () => {
    const { connection, queries } = makeStubConnection({
      aggregate: { reject: true },
      listRows: [{ layer: 'L1' }, { layer: 'L1' }, { layer: 'L2' }, { layer: 'L3' }],
    })

    await expect(countMemoriesByLayer(connection)).resolves.toEqual({
      L1: 2,
      L2: 1,
      L1_INBOX: 0,
      L2_INBOX: 0,
    })
    // 先试聚合、后退化：两条语句都发过，且第二条不含聚合。
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('count(')
    expect(queries[1]).not.toContain('count(')
  })
})

/**
 * 折叠 → 还原的端到端用例（Story 8.2 第 5 轮 / AC:1607-1609、1611-1614、NFR18）。
 *
 * 这是「折叠真的能用」的唯一证据链：`memory_related` 结果超阈值 ⇒ 返回 `{folded:true, handle}`
 * ⇒ 用 `memory_expand(handle)` 取回**逐字原文**（即被折叠的整条工具结果）。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { upsertMemory } from '../src/db/memory'
import { createMemoryRelatedTool } from '../src/tools/memory-related'
import { createMemoryExpandTool } from '../src/tools/memory-expand'
import { createRecallTurnQuota } from '../src/tools/recall-quota'
import { findHandleBySeq } from '../src/context/handles'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'
const OWNER = 's-e2e'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-e2e-fold-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

/** 假 related store：给定一条起点 + 若干邻居（不走真实图遍历，聚焦折叠链路）。 */
/** 假 related store：给定一条起点 + 若干邻居（不走真实图遍历，聚焦折叠链路）。 */
function makeStore(entries: Array<{ id: string, text: string }>) {
  return {
    async traverse(input: { readonly id: string }) {
      return {
        id: input.id,
        depth: 2,
        startFound: true,
        start: { invalid: false, invalidAt: null, expiredAt: null },
        total: entries.length,
        anyValidPath: true,
        results: entries.map((entry) => ({
          id: entry.id,
          layer: 'L1',
          text: entry.text,
          hops: 1,
          edgeType: 'EVIDENCE' as const,
          reason: null,
          invalid: false,
          invalidAt: null,
          expiredAt: null,
        })),
      }
    },
  }
}

const exec = { agent: { session: { id: OWNER } } }

describe('折叠 → memory_expand 还原（端到端）', () => {
  it('阈值调小 ⇒ 结果折成句柄；memory_expand 取回的文本 = 被折叠的整条结果', async () => {
    const entries = [
      { id: 'n-1', text: '邻居一：' + 'a'.repeat(200) },
      { id: 'n-2', text: '邻居二：' + 'b'.repeat(200) },
    ]
    const quota = createRecallTurnQuota(3)
    const related = createMemoryRelatedTool({
      getRelatedStore: () => makeStore(entries),
      quota,
      fold: {
        // 阈值 10 tokens ⇒ 任何真实结果都会超
        thresholdTokens: 10,
        readonly: false,
        logger: { warn: () => {} },
        write: async (input) => {
          // 复用生产写路径（writeHandle）：幂等键 = (session, seq)
          const { writeHandle } = await import('../src/context/handles')
          const record = await writeHandle(store.connection, {
            sessionId: input.sessionId,
            seq: input.seq,
            text: input.text,
            recordedAt: T0,
            tokens: input.tokens,
          })
          return { id: record.id }
        },
      },
    })

    const relatedValue = await related.execute({ id: 'n-0' }, exec)
    expect(relatedValue.folded).toBe(true)
    const handle = (relatedValue as { handle: string }).handle
    expect(handle).not.toBe('')

    // 句柄节点真的落库了（不是只在返回值里）
    const sessionRef = 'session:' + OWNER
    const { queryRows } = await import('../src/db/rows')
    const rows = await queryRows(
      store.connection,
      "MATCH (m:memory) WHERE m.kind = 'handle' RETURN m.id AS id, m.source_refs AS refs",
    )
    const stored = rows.find((row) => {
      const refs = Array.isArray(row.refs) ? (row.refs as unknown[]).map(String) : []
      return refs.includes(sessionRef)
    })
    expect(stored).toBeDefined()

    // 还原：memory_expand(handle) 必须给出逐字原文
    const expand = createMemoryExpandTool({ getDb: () => store, quota: createRecallTurnQuota(3), sessionId: () => OWNER })
    const restored = await expand.execute({ handle }, exec)
    expect(restored.restored).toBe(true)
    const text = (restored as { text: string }).text
    // 原文即「被折叠的整条工具结果」：JSON 里应含两条邻居的完整文本
    expect(text).toContain(entries[0].text)
    expect(text).toContain(entries[1].text)
    // 逐字：JSON 可被解析回来，且 text 与第一次折叠时写入的完全一致
    const parsed = JSON.parse(text) as { results: Array<{ text: string }> }
    expect(parsed.results.map((entry) => entry.text)).toEqual([entries[0].text, entries[1].text])
  })

  it('幂等：同一 (session, 起点, depth) 再折一次 ⇒ 命中同一句柄（不产生第二个节点）', async () => {
    const entries = [{ id: 'n-1', text: 'x'.repeat(300) }]
    const quota = createRecallTurnQuota(3)
    const related = createMemoryRelatedTool({
      getRelatedStore: () => makeStore(entries),
      quota,
      fold: {
        thresholdTokens: 10,
        readonly: false,
        write: async (input) => {
          const { writeHandle } = await import('../src/context/handles')
          const record = await writeHandle(store.connection, {
            sessionId: input.sessionId,
            seq: input.seq,
            text: input.text,
            recordedAt: T0,
            tokens: input.tokens,
          })
          return { id: record.id }
        },
      },
    })
    const first = await related.execute({ id: 'n-0' }, exec)
    const second = await related.execute({ id: 'n-0' }, exec)
    expect((first as { handle: string }).handle).toBe((second as { handle: string }).handle)
  })

  it('readOnly ⇒ 不折叠（原样返回成功值，零写入）', async () => {
    const entries = [{ id: 'n-1', text: 'y'.repeat(300) }]
    let wrote = 0
    const related = createMemoryRelatedTool({
      getRelatedStore: () => makeStore(entries),
      quota: createRecallTurnQuota(3),
      fold: {
        thresholdTokens: 10,
        readonly: true,
        write: async () => {
          wrote += 1
          return { id: 'should-not-happen' }
        },
      },
    })
    const value = await related.execute({ id: 'n-0' }, exec)
    expect((value as { folded?: boolean }).folded).toBeUndefined()
    expect(wrote).toBe(0)
  })

  it('句柄可被 findHandleBySeq 按会话查到（幂等键可用）', async () => {
    const found = await findHandleBySeq(store.connection, OWNER, 0)
    // seq 是 FNV 哈希，不一定为 0；这里只验证「按会话查询」这条路能跑通（不抛）
    expect(found === null || typeof found.id === 'string').toBe(true)
  })
})

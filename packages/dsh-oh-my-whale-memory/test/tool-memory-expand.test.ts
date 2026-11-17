/**
 * `memory_expand` 工具（Story 8.2 / AC:1615-1622）。
 *
 * 覆盖：非法 handle 不耗配额、库未就绪不耗配额、配额耗尽、成功逐字还原、
 * session_mismatch 不泄露正文、失败不 throw 不删。开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import { writeHandle } from '../src/context/handles'
import { createMemoryExpandTool } from '../src/tools/memory-expand'
import { createRecallTurnQuota } from '../src/tools/recall-quota'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-x-tool-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

/** 假 exec：只带 agent.session（quotaOwnerOf 用它取会话键）。 */
const exec = { agent: { session: { id: 's-tool' } } }

function makeTool(options: {
  readonly db?: MemoryDatabase
  readonly quota?: ReturnType<typeof createRecallTurnQuota>
  readonly thresholds?: { readonly expandCountThreshold: number, readonly chainDepthThreshold: number } | null
  readonly now?: () => Date
}) {
  const tool = createMemoryExpandTool({
    getDb: () => options.db,
    quota: options.quota ?? createRecallTurnQuota(3),
    // null = 显式不计数（纯还原用例）；
    ...(options.thresholds === null ? {} : {
      expandThresholds: options.thresholds ?? { expandCountThreshold: 2, chainDepthThreshold: 2 },
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return tool
}

/** 句柄节点的统计列（迁移 0008 的 expand_count / chain_depth / last_expanded_at）。 */
async function statsOf(id: string): Promise<{ expandCount: number | null, chainDepth: number | null, lastExpandedAt: unknown }> {
  const rows = await queryRows(
    store.connection,
    'MATCH (m:memory {id: $id}) RETURN m.expand_count AS expand_count, m.chain_depth AS chain_depth, ' +
    'm.last_expanded_at AS last_expanded_at',
    { id },
  )
  const row = rows[0]
  return {
    expandCount: row?.expand_count === null || row?.expand_count === undefined ? null : Number(row.expand_count),
    chainDepth: row?.chain_depth === null || row?.chain_depth === undefined ? null : Number(row.chain_depth),
    lastExpandedAt: row?.last_expanded_at ?? null,
  }
}

async function rewriteItems(): Promise<Array<{ id: string, kind: string, payload: string, sessionId: string }>> {
  const rows = await queryRows(
    store.connection,
    "MATCH (i:l1_inbox) WHERE i.kind = 'summary-rewrite' RETURN i.id AS id, i.kind AS kind, i.payload AS payload, i.session_id AS session_id",
  )
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    payload: String(row.payload),
    sessionId: String(row.session_id ?? ''),
  }))
}

describe('memory_expand 工具（AC:1615-1622）', () => {
  it('签名与描述：工具名 memory_expand、参数 handle 必填', () => {
    const tool = makeTool({ db: store })
    expect(tool.name).toBe('memory_expand')
    expect(String(tool.description)).toContain('100% 还原')
    expect(JSON.stringify(tool.parameters)).toContain('handle')
  })

  it('非法 handle ⇒ handle_not_found，且不耗配额', async () => {
    const quota = createRecallTurnQuota(3)
    const tool = makeTool({ db: store, quota })
    const value = await tool.execute({ handle: '   ' }, exec)
    expect(value.restored).toBe(false)
    expect((value as { error: { code: string } }).error.code).toBe('handle_not_found')
    // 配额未被吃掉：后续三次仍可用
    expect(quota.consume('s-tool')).toBe(true)
    expect(quota.consume('s-tool')).toBe(true)
    expect(quota.consume('s-tool')).toBe(true)
  })

  it('库未就绪 ⇒ db_unavailable（retryable），且不耗配额', async () => {
    const quota = createRecallTurnQuota(3)
    const tool = makeTool({ db: undefined, quota })
    const value = await tool.execute({ handle: 'abc' }, exec)
    expect(value.restored).toBe(false)
    const failure = value as { error: { code: string, retryable: boolean } }
    expect(failure.error.code).toBe('db_unavailable')
    expect(failure.error.retryable).toBe(true)
    expect(quota.consume('s-tool')).toBe(true)
  })

  it('成功：逐字还原 + total/bytes 正确', async () => {
    const text = '工具结果原文 🐋\n第二行'
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 1, text, recordedAt: T0 })
    const tool = makeTool({ db: store })
    const value = await tool.execute({ handle: record.id }, exec)
    expect(value.restored).toBe(true)
    const success = value as { text: string, total: number, bytes: number, handle: string }
    expect(success.text).toBe(text)
    expect(success.total).toBe(text.length)
    expect(success.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(success.handle).toBe(record.id)
  })

  it('也接受整段句柄块作为入参', async () => {
    const text = '块入参'
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 2, text, recordedAt: T0 })
    const tool = makeTool({ db: store })
    const value = await tool.execute({ handle: '[omw:handle=' + record.id + ' ~3 tokens]' }, exec)
    expect(value.restored).toBe(true)
  })

  it('其它 session ⇒ session_mismatch，且返回里不含正文；节点未被删除（INV-3）', async () => {
    const text = '别人的正文不该泄露'
    const record = await writeHandle(store.connection, { sessionId: 's-other', seq: 3, text, recordedAt: T0 })
    const before = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    const tool = makeTool({ db: store })
    const value = await tool.execute({ handle: record.id }, exec)
    expect(value.restored).toBe(false)
    const failure = value as { error: { code: string, retryable: boolean } }
    expect(failure.error.code).toBe('session_mismatch')
    expect(failure.error.retryable).toBe(false)
    expect(JSON.stringify(value)).not.toContain(text)
    const after = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c))
  })

  it('配额耗尽 ⇒ quota_exceeded（不 throw）', async () => {
    const quota = createRecallTurnQuota(1)
    const tool = makeTool({ db: store, quota })
    // 第一次消耗配额（句柄不存在也无妨，配额在查库前已扣）
    const first = await tool.execute({ handle: 'no-such-handle' }, exec)
    expect((first as { error: { code: string } }).error.code).toBe('handle_not_found')
    const second = await tool.execute({ handle: 'no-such-handle' }, exec)
    expect((second as { error: { code: string } }).error.code).toBe('quota_exceeded')
  })

  it('render 两分支都产出文本块，且不 throw', () => {
    const tool = makeTool({ db: store })
    const ok = tool.output.render({ handle: 'h' }, { handle: 'h', total: 3, text: 'abc', restored: true, bytes: 3 })
    const bad = tool.output.render({ handle: 'h' }, {
      restored: false,
      error: { code: 'handle_not_found', message: '没有', retryable: false },
    })
    expect(JSON.stringify(ok)).toContain('abc')
    expect(JSON.stringify(bad)).toContain('handle_not_found')
  })
})

describe('矩阵行 8 / 9：展开计数与摘要重写入队（Story 8.4 / T5、FR-29）', () => {
  const NOW = new Date('2026-07-01T00:00:00.000Z')

  it('成功展开 ⇒ expand_count += 1、last_expanded_at = now，并回显 expandCount', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 100, text: '计数用例', recordedAt: T0 })
    const tool = makeTool({ db: store, now: () => NOW })
    const first = await tool.execute({ handle: record.id }, exec)
    expect(first.restored).toBe(true)
    expect((first as { expandCount?: number }).expandCount).toBe(1)
    const stats = await statsOf(record.id)
    expect(stats.expandCount).toBe(1)
    expect(stats.lastExpandedAt).toBe(NOW.toISOString())

    const second = await tool.execute({ handle: record.id }, exec)
    expect((second as { expandCount?: number }).expandCount).toBe(2)
    expect((await statsOf(record.id)).expandCount).toBe(2)
  })

  it('第 N 次达到阈值 ⇒ 恰好一条重写条目（幂等键 rewrite:<handleId>，payload 带标记与 id）', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 101, text: '达阈用例', recordedAt: T0 })
    const tool = makeTool({ db: store, now: () => NOW })
    const itemId = 'rewrite:' + record.id

    await tool.execute({ handle: record.id }, exec)
    expect((await rewriteItems()).filter((item) => item.id === itemId)).toHaveLength(0)

    await tool.execute({ handle: record.id }, exec)
    const afterThreshold = (await rewriteItems()).filter((item) => item.id === itemId)
    expect(afterThreshold).toHaveLength(1)
    expect(afterThreshold[0]?.kind).toBe('summary-rewrite')
    expect(afterThreshold[0]?.sessionId).toBe('s-tool')
    expect(JSON.parse(afterThreshold[0]!.payload)).toEqual({
      rewrite: true,
      handleId: record.id,
      versionId: record.id,
    })

    // 再展开仍只有一条（MERGE ON CREATE 幂等）。
    await tool.execute({ handle: record.id }, exec)
    await tool.execute({ handle: record.id }, exec)
    expect((await rewriteItems()).filter((item) => item.id === itemId)).toHaveLength(1)
  })

  it('chain_depth 已达阈值 ⇒ 首次展开就入队（不必等 expandCount）', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 102, text: '链深用例', recordedAt: T0 })
    await queryRows(store.connection, 'MATCH (m:memory {id: $id}) SET m.chain_depth = 2', { id: record.id })
    const tool = makeTool({ db: store, now: () => NOW })
    await tool.execute({ handle: record.id }, exec)
    const items = (await rewriteItems()).filter((item) => item.id === 'rewrite:' + record.id)
    expect(items).toHaveLength(1)
  })

  it('阈值可覆盖（Config 运行期改大 ⇒ 不达阈不入队）', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 103, text: '阈值覆盖用例', recordedAt: T0 })
    const tool = makeTool({ db: store, thresholds: { expandCountThreshold: 5, chainDepthThreshold: 5 }, now: () => NOW })
    await tool.execute({ handle: record.id }, exec)
    await tool.execute({ handle: record.id }, exec)
    expect((await rewriteItems()).filter((item) => item.id === 'rewrite:' + record.id)).toHaveLength(0)
    expect((await statsOf(record.id)).expandCount).toBe(2)
  })

  it('矩阵行 9：只读实例 ⇒ 计数不写、不生成条目，但还原照常', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-tool', seq: 104, text: '只读实例用例', recordedAt: T0 })
    // 只读视图：同一连接上的只读 facade（真只读实例的整链零写在 epic8-readonly-zero-write-db 里断言）。
    const readonlyDb = { ...store, readonly: true } as unknown as MemoryDatabase
    const tool = makeTool({ db: readonlyDb, now: () => NOW })
    const value = await tool.execute({ handle: record.id }, exec)
    expect(value.restored).toBe(true)
    expect((value as { text: string }).text).toBe('只读实例用例')
    // 计数列保持默认 0，未写 last_expanded_at；也没有重写条目。
    const stats = await statsOf(record.id)
    expect(stats.expandCount).toBe(0)
    expect(stats.lastExpandedAt).toBeNull()
    expect((await rewriteItems()).filter((item) => item.id === 'rewrite:' + record.id)).toHaveLength(0)
  })
})

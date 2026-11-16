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

function makeTool(options: { readonly db?: MemoryDatabase, readonly quota?: ReturnType<typeof createRecallTurnQuota>, readonly sessionId?: string }) {
  const tool = createMemoryExpandTool({
    getDb: () => options.db,
    quota: options.quota ?? createRecallTurnQuota(3),
    sessionId: options.sessionId === undefined ? undefined : () => options.sessionId as string,
  })
  return tool
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
    const tool = makeTool({ db: store, sessionId: 's-tool' })
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
    const tool = makeTool({ db: store, sessionId: 's-tool' })
    const value = await tool.execute({ handle: '[omw:handle=' + record.id + ' ~3 tokens]' }, exec)
    expect(value.restored).toBe(true)
  })

  it('其它 session ⇒ session_mismatch，且返回里不含正文；节点未被删除（INV-3）', async () => {
    const text = '别人的正文不该泄露'
    const record = await writeHandle(store.connection, { sessionId: 's-other', seq: 3, text, recordedAt: T0 })
    const before = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    const tool = makeTool({ db: store, sessionId: 's-tool' })
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

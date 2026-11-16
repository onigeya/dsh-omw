/**
 * 折叠句柄与 `memory_expand` 还原（Story 8.2 第 1 轮）。
 *
 * 覆盖 spec 矩阵行 1-18：句柄格式/解析边界、幂等写、失效/越权分类、
 * 成功逐字还原（含 emoji/换行/超长）、失败信封（不 throw、不删）、配额共享。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import {
  clampTokenCount,
  formatHandleBlock,
  parseHandle,
  resolveHandleInput,
} from '../src/context/handle'
import {
  HANDLE_KIND,
  classifyHandle,
  findHandleBySeq,
  handleId,
  readHandle,
  writeHandle,
} from '../src/context/handles'
import { expandFailure, expandSuccess, isRetryableExpandError } from '../src/context/expand-result'
import { createRecallTurnQuota } from '../src/tools/recall-quota'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-h8-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('句柄格式（AC:1607-1609）', () => {
  it('生成：非负夹紧，负数/NaN ⇒ 0', () => {
    expect(clampTokenCount(-5)).toBe(0)
    expect(clampTokenCount(Number.NaN)).toBe(0)
    expect(clampTokenCount(12.9)).toBe(12)
    expect(formatHandleBlock('abc', 0)).toBe('[omw:handle=abc ~0 tokens]')
    expect(formatHandleBlock('abc', -3)).toBe('[omw:handle=abc ~0 tokens]')
  })

  it('生成：大数字原样十进制，不缩写', () => {
    expect(formatHandleBlock('h1', 123456789)).toBe('[omw:handle=h1 ~123456789 tokens]')
  })

  it('生成：非法 id 抛错（防注入到别的语法里）', () => {
    expect(() => formatHandleBlock('bad id', 1)).toThrowError(/非法句柄 id/)
    expect(() => formatHandleBlock('x'.repeat(129), 1)).toThrowError(/非法句柄 id/)
  })

  it('解析：精确句柄 / 前后空白 / 只取第一个', () => {
    expect(parseHandle('[omw:handle=abc ~12 tokens]')).toEqual({ id: 'abc', tokens: 12 })
    expect(parseHandle('  前缀 [omw:handle=abc ~12 tokens] 后缀 ')).toEqual({ id: 'abc', tokens: 12 })
    const two = parseHandle('[omw:handle=a ~1 tokens] 和 [omw:handle=b ~2 tokens]')
    expect(two).toEqual({ id: 'a', tokens: 1 })
  })

  it('解析：非法/缺字段 ⇒ null（不抛）', () => {
    expect(parseHandle('没有句柄')).toBeNull()
    expect(parseHandle('[omw:handle= ~1 tokens]')).toBeNull()
    expect(parseHandle('[omw:handle=bad id ~1 tokens]')).toBeNull()
  })

  it('resolveHandleInput：裸 id 与整段句柄都接受，空串/非法 ⇒ null', () => {
    expect(resolveHandleInput('  abc  ')).toBe('abc')
    expect(resolveHandleInput('[omw:handle=abc ~1 tokens]')).toBe('abc')
    expect(resolveHandleInput('   ')).toBeNull()
    expect(resolveHandleInput('bad id')).toBeNull()
  })
})

describe('句柄节点读写（AC:1630-1634、INV-3/4/6）', () => {
  it('写后可读：kind=handle、正文逐字、source_refs 带 session/seq', async () => {
    const text = '第一行\n第二行\ttab 🐋 emoji\n' + 'x'.repeat(500)
    const record = await writeHandle(store.connection, { sessionId: 's-1', seq: 7, text, recordedAt: T0, tokens: 42 })
    expect(record.text).toBe(text)
    expect(record.sessionId).toBe('s-1')
    expect(record.seq).toBe(7)
    const rows = await queryRows(store.connection, `MATCH (m:memory {id: '${record.id}'}) RETURN m.kind AS kind, m.support AS support`)
    expect(String(rows[0]?.kind)).toBe(HANDLE_KIND)
    expect(Number(rows[0]?.support)).toBe(42)
  })

  it('幂等：同 (sessionId, seq) 写两次 ⇒ 同一 id、节点数不变', async () => {
    const first = await writeHandle(store.connection, { sessionId: 's-1', seq: 7, text: '另一份正文', recordedAt: T0 })
    const before = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    // AD-4 的节点 id 是正文指纹（编码不了 session/seq），幂等靠 findHandleBySeq 先查后写：
    // 第二次即使正文不同也必须命中既有节点（同 session+seq）。
    const second = await writeHandle(store.connection, { sessionId: 's-1', seq: 7, text: '完全不同的正文', recordedAt: T0 })
    const after = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    expect(second.id).toBe(first.id)
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c))
    // 幂等键真的能查到（否则上面的断言只是碰巧）
    const found = await findHandleBySeq(store.connection, 's-1', 7)
    expect(found?.id).toBe(first.id)
    // 不同 seq ⇒ 不同节点
    const other = await writeHandle(store.connection, { sessionId: 's-1', seq: 8, text: '另一份正文', recordedAt: T0 })
    expect(other.id).not.toBe(first.id)
  })

  it('读不存在 ⇒ null（不抛）', async () => {
    expect(await readHandle(store.connection, 'no-such-handle')).toBeNull()
  })

  it('空正文拒绝写入（空句柄无法还原任何内容）', async () => {
    await expect(writeHandle(store.connection, { sessionId: 's-1', seq: 99, text: '', recordedAt: T0 }))
      .rejects.toMatchObject({ code: 'handle_text_empty' })
  })
})

describe('失败归因（AC:1619-1622）', () => {
  it('不存在 ⇒ handle_not_found（不可重试）', () => {
    expect(classifyHandle(null, 's-1')).toEqual({ ok: false, failure: 'handle_not_found' })
    expect(isRetryableExpandError('handle_not_found')).toBe(false)
  })

  it('其它 session ⇒ session_mismatch（不可重试，且失败信封不含正文）', () => {
    const record = { id: 'h', sessionId: 's-2', seq: 1, text: '别人的正文', invalidAt: null, expiredAt: null }
    expect(classifyHandle(record, 's-1')).toEqual({ ok: false, failure: 'session_mismatch' })
    const failure = expandFailure('session_mismatch')
    expect(failure.restored).toBe(false)
    expect(JSON.stringify(failure)).not.toContain('别人的正文')
    expect(failure.error.retryable).toBe(false)
  })

  it('已失效 ⇒ handle_expired（可重试）', () => {
    const record = { id: 'h', sessionId: 's-1', seq: 1, text: 'x', invalidAt: T0, expiredAt: null }
    expect(classifyHandle(record, 's-1')).toEqual({ ok: false, failure: 'handle_expired' })
    expect(isRetryableExpandError('handle_expired')).toBe(true)
    expect(expandFailure('handle_expired').error.retryable).toBe(true)
  })

  it('同 session 且未失效 ⇒ ok', () => {
    const record = { id: 'h', sessionId: 's-1', seq: 1, text: 'x', invalidAt: null, expiredAt: null }
    const verdict = classifyHandle(record, 's-1')
    expect(verdict.ok).toBe(true)
  })

  it('失败路径不删节点（INV-3）：分类失败后组件仍在', async () => {
    const before = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    classifyHandle(null, 's-1')
    expandFailure('handle_not_found')
    const after = await queryRows(store.connection, "MATCH (m:memory) WHERE m.kind = 'handle' RETURN count(m) AS c")
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c))
  })
})

describe('成功还原（NFR18：逐字 100%）', () => {
  it('text 逐字等于写入内容、total 等于字符数、bytes 是 UTF-8 字节数', async () => {
    const text = '中文 🐋\r\n第二行\t结束'
    const record = await writeHandle(store.connection, { sessionId: 's-9', seq: 1, text, recordedAt: T0 })
    const success = expandSuccess(record)
    expect(success.restored).toBe(true)
    expect(success.text).toBe(text)
    expect(success.total).toBe(text.length)
    expect(success.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(success.handle).toBe(record.id)
  })

  it('超长正文不被截断（100% 还原）', async () => {
    const text = 'y'.repeat(200_000)
    const record = await writeHandle(store.connection, { sessionId: 's-9', seq: 2, text, recordedAt: T0 })
    const success = expandSuccess(record)
    expect(success.text.length).toBe(200_000)
    expect(success.total).toBe(200_000)
  })
})

describe('配额共享（AC:1622）', () => {
  it('memory_expand 与 recall/related 合计 ≤ 3/轮', () => {
    const quota = createRecallTurnQuota(3)
    expect(quota.consume('s-1')).toBe(true)
    expect(quota.consume('s-1')).toBe(true)
    expect(quota.consume('s-1')).toBe(true)
    expect(quota.consume('s-1')).toBe(false)
    quota.reset('s-1')
    expect(quota.consume('s-1')).toBe(true)
  })

  it('配额耗尽返回 quota_exceeded 信封（不可重试）', () => {
    const failure = expandFailure('quota_exceeded')
    expect(failure.error.code).toBe('quota_exceeded')
    expect(failure.error.retryable).toBe(false)
    expect(failure.error.message).toContain('配额')
  })
})

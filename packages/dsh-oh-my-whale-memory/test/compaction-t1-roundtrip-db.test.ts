/**
 * T1 折叠的真库往返（Story 8.3 / 矩阵行 7、NFR18 / AC:1711）。
 *
 * 只开 1 次库：写句柄 → 读回逐字原文 → 同文本重放命中同一句柄（幂等）。
 * 依赖 Windows PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-l0.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { buildT1Summary, fnv1aAnchor, renderRegionText } from '../src/context/compaction-t1'
import { readHandle, writeHandle } from '../src/context/handles'
import { cleanupTempDirs, makeTempDir } from './tmp'

let store: MemoryDatabase

beforeAll(async () => {
  const dir = await makeTempDir('omw-compaction-t1-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

const ISO = '2026-11-17T00:00:00.000Z'

describe('T1 句柄往返（NFR18）', () => {
  it('写句柄后按 id 读回逐字原文；同文本重放命中同一条（幂等）', async () => {
    const text = '[user]\n第一行\n第二行\n\n[tool]\n结果'
    const seq = fnv1aAnchor(text)
    const first = await writeHandle(store.connection, {
      sessionId: 's-t1',
      seq,
      text,
      recordedAt: ISO,
      tokens: Math.ceil(text.length / 2),
    })
    expect(first.text).toBe(text)
    expect(first.sessionId).toBe('s-t1')
    expect(first.seq).toBe(seq)

    const second = await writeHandle(store.connection, { sessionId: 's-t1', seq, text, recordedAt: ISO })
    expect(second.id).toBe(first.id)

    const restored = await readHandle(store.connection, first.id)
    expect(restored?.text).toBe(text)
  })

  it('buildT1Summary 用真实 writer 产出句柄块，锚点与渲染文本一致', async () => {
    const messages = [
      { role: 'system', content: 'head' },
      { role: 'user', content: '原始需求' },
    ]
    const summary = await buildT1Summary({
      messages,
      sessionId: 's-t1b',
      writeHandle: async (input) => {
        const record = await writeHandle(store.connection, { ...input, recordedAt: ISO })
        return { id: record.id }
      },
    })
        const block = summary.summary[0]?.text ?? ''
    expect(block).toMatch(/^\[omw:handle=.+ ~\d+ tokens\]$/)
    const rendered = renderRegionText(messages)
    expect(rendered).toBe('[user]\n原始需求')
  })
})


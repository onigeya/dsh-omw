/**
 * 净化账本测试（Story 8.6 / T5、矩阵行 12 / AC:1890-1892）。
 *
 * 真库验证「一行 detail 六个字段」，以及三条 fail-open 纪律：
 * - 未注册写入方（只读实例 / 裸 ctx）⇒ 只 warn，不抛；
 * - 写失败（缺表 / 库不可用）⇒ 只 warn，不抛；
 * - 写失败不重复刷屏（每进程一次）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { queryAll } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { DEFAULT_PURIFY_OPTIONS, purifyMessages, type PurifyMessageLike } from '../src/context/purify'
import {
  PURIFY_LEDGER_ACTION,
  PURIFY_LEDGER_KIND,
  createPurifyLedgerWriter,
  recordPurifyRun,
  registerPurifyLedgerWriter,
  resetPurifyLedgerWriter,
  type PurifyLedgerEntry,
} from '../src/context/purify-ledger'
import { cleanupTempDirs, makeTempDir } from './tmp'

let dir: string
let store: MemoryDatabase

beforeAll(async () => {
  dir = await makeTempDir('omw-purify-ledger-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

afterEach(() => {
  resetPurifyLedgerWriter()
})

const NOW = new Date('2026-11-17T00:00:00.000Z')

async function ledgerRows(): Promise<Record<string, unknown>[]> {
  return queryAll(
    store.connection,
    "MATCH (g:generation_log) WHERE g.kind = '" + PURIFY_LEDGER_KIND + "' " +
    'RETURN g.action AS action, g.outcome AS outcome, g.reason AS reason, g.detail AS detail',
  )
}

/** 一段真实净化（矩阵行 12 的输入口径：ruleHits / removedChars / removedTokens 都非零）。 */
function purifyFixture(text: string): PurifyLedgerEntry {
  const messages: PurifyMessageLike[] = [{ role: 'assistant', content: [{ type: 'text', text }] }]
  const result = purifyMessages(messages, DEFAULT_PURIFY_OPTIONS)
  expect(result.changed).toBe(true)
  return {
    sessionId: 'sess-ledger',
    rangeStart: 0,
    rangeEnd: result.sourceChars,
    ruleHits: result.ruleHits,
    removedChars: result.removedChars,
    removedTokens: result.removedTokens,
  }
}

describe('矩阵行 12：每次净化一行 detail', () => {
  it('真库写入一行 purify_text，detail 六个字段齐全', async () => {
    registerPurifyLedgerWriter(createPurifyLedgerWriter({ connection: () => store.connection, now: () => NOW }))
    const entry = purifyFixture('Let me…\nGo.\nThe migration ordering is documented in AD-34 and matters for replay.')

    await expect(recordPurifyRun(entry)).resolves.toBe(true)

    const rows = await ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: PURIFY_LEDGER_ACTION, outcome: 'success' })
    const detail = JSON.parse(String(rows[0]!.detail)) as Record<string, unknown>
    expect(detail).toMatchObject({
      sessionId: 'sess-ledger',
      rangeStart: 0,
      ruleHits: expect.arrayContaining(['R1']),
    })
    expect(Number(detail.rangeEnd)).toBeGreaterThan(0)
    expect(Number(detail.removedChars)).toBeGreaterThan(0)
    expect(Number(detail.removedTokens)).toBeGreaterThanOrEqual(0)
    // reason 只放规则名（不含原文，NFR9）
    expect(String(rows[0]!.reason)).toContain('R1')
  })

  it('零改动的净化不记行（避免把填充密度低的会话刷成噪声）', async () => {
    registerPurifyLedgerWriter(createPurifyLedgerWriter({ connection: () => store.connection, now: () => NOW }))
    const wrote = await recordPurifyRun({
      sessionId: 'sess-noop',
      rangeStart: 0,
      rangeEnd: 10,
      ruleHits: [],
      removedChars: 0,
      removedTokens: 0,
    })
    expect(wrote).toBe(false)
    expect(await ledgerRows()).toHaveLength(1) // 只有上一条用例的行
  })

  it('空 sessionId 不记账（不可归属的行没有检索价值）', async () => {
    registerPurifyLedgerWriter(createPurifyLedgerWriter({ connection: () => store.connection, now: () => NOW }))
    const before = (await ledgerRows()).length
    await recordPurifyRun({ ...purifyFixture('Let me…\nGo.\nReal content that stays.'), sessionId: '' })
    expect((await ledgerRows()).length).toBe(before)
  })
})

describe('fail-open：只读 / 缺表 / 写失败只 warn', () => {
  it('未注册写入方（只读实例）⇒ 返回 false + warn 一次', async () => {
    const warn = vi.fn()
    const entry = purifyFixture('Let me…\nGo.\nReal content that stays.')
    await expect(recordPurifyRun(entry, { logger: { warn } })).resolves.toBe(false)
    await recordPurifyRun(entry, { logger: { warn } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('净化账本跳过')
  })

  it('库句柄缺失 / 写失败 ⇒ 返回 false + warn，不抛给调用方', async () => {
    const warn = vi.fn()
    registerPurifyLedgerWriter(createPurifyLedgerWriter({ connection: () => null, now: () => NOW }))
    const entry = purifyFixture('Let me…\nGo.\nReal content that stays.')
    await expect(recordPurifyRun(entry, { logger: { warn } })).resolves.toBe(false)
    await recordPurifyRun(entry, { logger: { warn } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('净化账本写入失败')
  })
})

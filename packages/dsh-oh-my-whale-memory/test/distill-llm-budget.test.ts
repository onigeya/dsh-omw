/**
 * LLM 时间预算回归钉（Story 2.3 / 评审 P11 / P18）。
 *
 * 为什么单独一个文件：LadybugDB 每个实例预留 8 TiB 虚拟地址空间、`close()` 不释放，
 * 同一进程内第 16 个实例起 `VirtualAlloc` 必失败（实测 failedAt=14，含 beforeEach 共第 16 次）。
 * `test/distill-processor.test.ts` 已有 15 个用例 = 15 次开库，正好卡在顶下；
 * 因此这条用例独立成文件（独立进程 = 独立地址空间），避免把该文件推过顶。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 distill-processor.test.ts。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { claimNextInboxItem, enqueueInboxItem, type InboxItem } from '../src/inbox/queue'
import { InboxRefineError } from '../src/inbox/consumer'
import { createInboxProcessor, type InboxProcessorDeps } from '../src/distill/processor'
import type { LlmPort } from '../src/distill/llm-refine'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'test-embed-model'
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase

beforeEach(async () => {
  const dir = await makeTempDir('omw-llm-budget-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

function makeProcessor(llm: LlmPort, overrides: Partial<InboxProcessorDeps> = {}) {
  return createInboxProcessor({
    connection: () => store.connection,
    llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    ...overrides,
  })
}

async function claimFixture(tag: string, payload: string): Promise<InboxItem> {
  const id = 'budget-' + tag + '-' + process.pid
  await enqueueInboxItem(store.connection, { id, payload, kind: 'work_fact', sessionId: 'sess-1', now: NOW })
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

const refsOf = (row: Record<string, unknown>, column: string): string[] => {
  const value = row[column]
  return Array.isArray(value) ? value.map(String) : []
}

async function refineLogsFor(id: string): Promise<Record<string, unknown>[]> {
  const logs = await queryAll(
    store.connection,
    'MATCH (g:generation_log) RETURN g.kind AS kind, g.reason AS reason, g.l0_refs AS l0_refs',
  )
  return logs.filter((row) => String(row.kind) === 'refine' && refsOf(row, 'l0_refs').includes(id))
}

describe('评审 P11 / P18：LLM 子预算先于总预算掐断', () => {
  it('评审 P11：LLM 子预算先于总预算掐断（撤掉子预算即变红）', async () => {
    const item = await claimFixture('sub-budget', '原文')
    // 端口只在「传给它的 signal 中止」时结束 ⇒ 这条用例测的正是「中止的是哪个预算」：
    // 子预算 50ms / 总预算 1500ms，正确实现 ~50ms 掐断；撤成总预算则 ~1500ms 才断（<500ms 断言即红）。
    let t0 = 0
    let abortGap = -1
    const seen: { signal?: AbortSignal } = {}
    const budgetProbe: LlmPort = {
      stream(options) {
        seen.signal = (options as { signal?: AbortSignal }).signal
        return (async function* generate() {
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              abortGap = Date.now() - t0
              reject(new Error('aborted by budget'))
            }, { once: true })
          })
        })()
      },
    }

    t0 = Date.now()
    await expect(makeProcessor(budgetProbe, { timeoutMs: 1_500, llmTimeoutMs: 50 })(item))
      .rejects.toBeInstanceOf(InboxRefineError)

    expect(abortGap).toBeGreaterThanOrEqual(0)
    expect(abortGap).toBeLessThan(500)
    expect(seen.signal?.aborted).toBe(true)
    const logs = await refineLogsFor(item.id)
    expect(logs).toHaveLength(1)
    expect(String(logs[0]!.reason)).toBe('llm-timeout')
  })
})

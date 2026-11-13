/**
 * 评审 P24（变异审计 M10）：丢弃路径也必须服从 at-most-once。
 *
 * `discardCandidate` 开头的 `if (!(await l2InboxQueue.markDone(...))) return` 保护的是
 * 「条目已被别处处理」这一窗口：此时若照常写失败账目与 gate-fail，就会制造「无产出却有失败账」
 * 的假象，并让来源被误标。
 *
 * 为什么单独一个文件：本用例必须把 `markDone` 换成恒 false 的替身来制造该窗口（真库上无法
 * 稳定复现 processing→done 的并发跳变）。单库共享 + 只在队列对象上做替身 ⇒ 避开
 * LadybugDB 每进程约 15 个实例的上限。
 *
 * 变异敏感度：去掉 discardCandidate 的 markDone 守卫 ⇒ 本条变红（恒 false 也照样写账目）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { l2InboxQueue } from '../src/inbox/queue'
import { createL2PromotionProcessor, L2_INBOX_KIND } from '../src/distill/promotion'
import { cleanupTempDirs, makeTempDir } from './tmp'

// 恒 false：模拟「这条已经被别处结算过」（只有 markDone 被动，其余队列能力仍是真实现）。
const guard = vi.hoisted(() => ({ stale: true }))

vi.mock('../src/inbox/queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inbox/queue')>()
  const real = actual.l2InboxQueue
  return {
    ...actual,
    l2InboxQueue: {
      ...real,
      markDone: async (...args: Parameters<typeof real.markDone>) =>
        guard.stale ? false : real.markDone(...args),
    },
  }
})

const DIM = 4
const NOW = new Date('2026-11-11T00:00:00.000Z')

let store: MemoryDatabase

beforeAll(async () => {
  const dir = await makeTempDir('omw-l2-guard-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

describe('评审 P24（变异审计 M10）：丢弃路径的 markDone 守卫', () => {
  it('markDone 落空（条目已被别处结算）⇒ 不写失败账目、不改状态', async () => {
    const id = 'l2-guard-test'
    await l2InboxQueue.enqueue(store.connection, {
      id,
      payload: 'not-json',
      kind: L2_INBOX_KIND,
      sessionId: 'sess-guard',
      now: NOW,
    })
    const item = await l2InboxQueue.claimNext(store.connection, { owner: 'test-owner', now: NOW })
    expect(item?.id).toBe(id)

    const run = createL2PromotionProcessor({
      connection: () => store.connection,
      llm: { stream: () => (async function* generate() {})() } as never,
      resolveRoute: () => ({ provider: 'p', model: 'm' }),
      now: () => NOW,
    })
    await run(item as never)

    // 守卫命中 ⇒ 一条失败账目都不该写（否则就是「无产出却有失败账」）。
    const audits = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'l2_promotion' RETURN count(g) AS total",
    )
    expect(Number(audits[0]!.total)).toBe(0)
    const status = await queryAll(store.connection, "MATCH (q:l2_inbox {id: '" + id + "'}) RETURN q.status AS status")
    expect(String(status[0]!.status)).toBe('processing')
  })
})
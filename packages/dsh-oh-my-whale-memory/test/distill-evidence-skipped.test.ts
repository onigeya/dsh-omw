/**
 * EVIDENCE 端点缺失 ⇒ 精炼降级可见（Story 2.6 评审 P6/P16，AD-21）。
 *
 * 独立成文件的原因：LadybugDB 每实例预留 8 TiB、单进程约 15 个库封顶，而
 * `distill-processor.test.ts` 的 beforeEach 每个用例各开一个库（已 15 例 = 贴顶）。
 * 本文件 1 个用例 = 1 次开库。
 *
 * 钉住的行为（Lead m02961 裁定，不许省）：INBOX 条目的 id 在 l0_raw 里**不存在**时，
 * `writeEvidenceEdges` 记为 `endpoint-missing` 跳过 ⇒ 精炼**照常成功写库**，同时多一条
 * `write_evidence_skipped` 的 uncertain 审计把降级摊开（AD-21：降级必须可见）。
 * 删掉 processor 里那段 skipped 记账，本用例即变红。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { claimNextInboxItem, enqueueInboxItem, type InboxItem } from '../src/inbox/queue'
import { createInboxProcessor } from '../src/distill/processor'
import { WRITE_EVIDENCE_SKIPPED_ACTION } from '../src/db/audit'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase

beforeEach(async () => {
  const dir = await makeTempDir('omw-dskip-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed' })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

function scriptedLlm(text: string) {
  return {
    stream() {
      return (async function* generate() {
        yield delta(text)
        yield finish({ kind: 'stop' })
      })()
    },
  }
}

async function logsFor(id: string): Promise<Array<{ action: string; outcome: string; reason: string }>> {
  const rows = await queryAll(
    store.connection,
    'MATCH (g:generation_log) RETURN g.action AS action, g.outcome AS outcome, g.reason AS reason, g.l0_refs AS l0_refs',
  )
  return rows
    .filter((row) => Array.isArray(row.l0_refs) && row.l0_refs.map(String).includes(id))
    .map((row) => ({ action: String(row.action), outcome: String(row.outcome), reason: String(row.reason ?? '') }))
}

describe('P6/P16：EVIDENCE 端点缺失时的降级可见性', () => {
  it('INBOX 条目缺 l0_raw 端点 ⇒ 记忆照常落库 + write_evidence_skipped 审计', async () => {
    const id = 'dskip-' + process.pid
    // 刻意**不**写 l0_raw 行（与 claimFixture 的正常夹具相反）：EVIDENCE 边的 L0 端点不存在。
    await enqueueInboxItem(store.connection, { id, payload: '用户: 端点缺失', kind: 'work_fact', sessionId: 's', now: NOW })
    const item = await claimNextInboxItem(store.connection, { owner: 'owner', now: NOW })
    if (!item || item.id !== id) throw new Error('夹具取不到队头：' + id)

    const processor = createInboxProcessor({
      connection: () => store.connection,
      llm: scriptedLlm(JSON.stringify({ facts: [{ text: '端点缺失也要记住', kind: 'work_fact', priority: 0 }] })) as never,
      resolveRoute: () => ROUTE,
      now: () => NOW,
    })
    const result = await processor(item as InboxItem)
    expect(result).toEqual({ completed: true, kinds: ['work_fact'] })

    // ① 记忆照常落库（降级绝不能丢数据）。
    const nodes = await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS c')
    expect(Number(nodes[0]?.c ?? 0)).toBe(1)
    // ② 没有边（端点缺失）。
    const edges = await queryAll(store.connection, 'MATCH (:l0_raw)-[e:EVIDENCE]->(:memory) RETURN count(e) AS c')
    expect(Number(edges[0]?.c ?? -1)).toBe(0)

    const logs = await logsFor(id)
    const success = logs.filter((row) => row.action === 'refine_inbox' && row.outcome === 'success')
    expect(success).toHaveLength(1)
    // ③ 降级必须可见：独立 action（不是 refine_inbox 的 reason 文本），status 的降级计数才统计得到。
    // 必须落在这个 action 上（不是 refine_inbox 的 reason 文本）——countRelatedSkips 只按 action 统计。
    const skipped = logs.filter((row) => row.action === WRITE_EVIDENCE_SKIPPED_ACTION)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.outcome).toBe('uncertain')
    expect(skipped[0]?.reason).toContain('skipped=1')
    // 反向桩：这条降级行**不**计入 refine_inbox 的成功/失败记账口径（它是独立 action）。
    expect(logs.filter((row) => row.action === 'refine_inbox')).toHaveLength(1)
  })
})

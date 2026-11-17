/**
 * 精炼 hydrate（Story 10.2 / AC：按 seq 经 db/host-log.ts 读回 → renderMessage 拼接 → 喂 LLM；
 * 解析失败抛 InboxRefineError 可重试、不丢条目；成功则 sourceRefs / EVIDENCE 多源，l0Refs 为 seq 列表）。
 *
 * 真库 + 假宿主日志服务 + 脚本化 llm；每个用例独立临时库（LadybugDB 每进程约 15 库封顶）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { UNRESOLVABLE_POINTERS_ACTION, countPointerAudits } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { writeEvidenceEdges } from '../src/db/edges'
import type { HostLogHandleLike, HostLogServiceLike } from '../src/db/host-log'
import { l0PointerId, writeL0Pointer } from '../src/db/l0'
import { queryAll, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { runInTransaction } from '../src/db/transaction'
import { createInboxConsumer, InboxRefineError } from '../src/inbox/consumer'
import { createIdleGate } from '../src/inbox/idle-gate'
import {
  claimNextInboxItem,
  enqueueInboxItem,
  formatInboxPointerPayload,
  type InboxItem,
} from '../src/inbox/queue'
import { createInboxProcessor, UNRESOLVABLE_POINTERS_REASON, type InboxProcessorDeps } from '../src/distill/processor'
import type { LlmPort } from '../src/distill/llm-refine'
import { MEMORY_REMEMBER_LAYER } from '../src/tools/memory-remember'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'test-embed-model'
const NOW = new Date('2026-11-17T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase

beforeEach(async () => {
  const dir = await makeTempDir('omw-hydrate-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const textDelta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finishChunk = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

function scriptedLlm(facts: readonly unknown[]): { llm: LlmPort; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options as unknown as Record<string, unknown>)
        return (async function* generate() {
          yield textDelta(JSON.stringify({ facts }))
          yield finishChunk({ kind: 'stop' })
        })()
      },
    },
  }
}

/** 从一次 llm.stream 调用里取拼接后的提示词（精炼把 transcript 放在 user 文本里）。 */
function promptOf(call: Record<string, unknown> | undefined): string {
  const messages = call?.messages as readonly { content?: readonly { text?: string }[] }[] | undefined
  return (messages ?? [])
    .flatMap((message) => (message.content ?? []).map((block) => String(block.text ?? '')))
    .join('\n')
}

/** 假宿主日志服务：按 session 返回脚本化事件；`failOpen` 模拟读不到日志。 */
function fakeHostLog(
  events: readonly { seq: number, type: string, message: unknown }[],
  options: { readonly failOpen?: boolean, readonly failRead?: boolean } = {},
): HostLogServiceLike & { readonly opens: number } {
  const state = { opens: 0 }
  return {
    get opens() { return state.opens },
    async open(): Promise<HostLogHandleLike> {
      state.opens += 1
      if (options.failOpen) throw new Error('session log missing')
      return {
        async read(offset = 0, length?: number) {
          if (options.failRead) throw new Error('read failed')
          const sliced = events
            .filter((event) => event.seq >= offset)
            .slice(0, length ?? events.length)
            .map((event) => ({ seq: event.seq, type: event.type, time: 0, data: { message: event.message } }))
          return { events: sliced }
        },
        async close() {},
      }
    },
  }
}

/** 造一条指针 INBOX 条目（pointer 行 + 指针 payload 同 session），不 claim。 */
async function enqueuePointerItem(
  sessionId: string,
  events: readonly { seq: number, type: string }[],
): Promise<string> {
  await runInTransaction(store.connection, async () => {
    for (const event of events) {
      await writeL0Pointer(store.connection, {
        id: l0PointerId(sessionId, event.seq),
        sessionId,
        seq: event.seq,
        eventType: event.type,
        recordedAt: NOW,
      })
    }
  })
  const id = l0PointerId(sessionId, events[0]!.seq)
  await enqueueInboxItem(store.connection, {
    id,
    payload: formatInboxPointerPayload({
      sessionId,
      seqs: events.map((event) => event.seq),
      eventTypes: events.map((event) => event.type),
    }),
    sessionId,
    kind: 'turn',
    now: NOW,
  })
  return id
}

/** 造一条指针 INBOX 条目并 claim（直接调 processor 的夹具）。 */
async function claimPointerItem(
  sessionId: string,
  events: readonly { seq: number, type: string }[],
): Promise<InboxItem> {
  const id = await enqueuePointerItem(sessionId, events)
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

/** 造一条旧文本 payload 条目（10.2 之前入队）并 claim。 */
async function claimLegacyItem(sessionId: string, text: string): Promise<InboxItem> {
  const id = 'legacy-' + sessionId
  await enqueueInboxItem(store.connection, { id, payload: text, sessionId, kind: 'turn', now: NOW })
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

function makeProcessor(
  llm: LlmPort,
  overrides: Partial<InboxProcessorDeps> = {},
): (item: InboxItem) => Promise<unknown> {
  return createInboxProcessor({
    connection: () => store.connection,
    llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    logger: { warn: () => {} },
    ...overrides,
  })
}

const refsOf = (row: Record<string, unknown>, column: string): string[] => {
  const value = row[column]
  return Array.isArray(value) ? value.map(String) : []
}

async function nodesFor(refs: readonly string[]): Promise<Record<string, unknown>[]> {
  const rows = await queryAll(
    store.connection,
    'MATCH (m:memory) RETURN m.id AS id, m.layer AS layer, m.text AS text, m.source_refs AS source_refs',
  )
  return rows.filter((row) => refs.every((ref) => refsOf(row, 'source_refs').includes(ref)))
}

/** 本用例库里的 refine 审计行（每个用例独立库，故不需要按条目再筛）。 */
async function refineAudits(): Promise<Record<string, unknown>[]> {
  return queryAll(
    store.connection,
    'MATCH (g:generation_log) WHERE g.kind = \'refine\' RETURN g.id AS id, g.action AS action, ' +
    'g.outcome AS outcome, g.l0_refs AS l0_refs, g.reason AS reason',
  )
}

async function inboxStatus(id: string): Promise<string | null> {
  const rows = await queryAll(store.connection, "MATCH (q:l1_inbox) WHERE q.id = '" + id + "' RETURN q.status AS status, q.attempts AS attempts")
  return rows[0] === undefined ? null : String(rows[0].status)
}

describe('hydrate 成功（AC：按 seq 读回 → renderMessage → 多源证据）', () => {
  it('读回两段事件并渲染成 transcript；sourceRefs / EVIDENCE 多源，l0Refs 为 seq 列表', async () => {
    const item = await claimPointerItem('s-hyd', [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
    ])
    const hostLog = fakeHostLog([
      { seq: 0, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: '我偏好中文回复' }] } },
      { seq: 1, type: 'assistant/message', message: { role: 'assistant', content: '已记住' } },
    ])
    const { llm, calls } = scriptedLlm([{ text: '用户偏好中文回复', kind: 'user_portrait', priority: 2 }])

    const result = await makeProcessor(llm, { hostLog })(item)

    expect(result).toEqual({ completed: true, kinds: ['user_portrait'] })
    expect(hostLog.opens).toBe(1)
    expect(promptOf(calls[0])).toContain('user: 我偏好中文回复')
    expect(promptOf(calls[0])).toContain('assistant: 已记住')

    const pointerIds = [l0PointerId('s-hyd', 0), l0PointerId('s-hyd', 1)]
    const nodes = await nodesFor(pointerIds)
    expect(nodes).toHaveLength(1)
    expect(refsOf(nodes[0]!, 'source_refs').sort()).toEqual([...pointerIds].sort())

    const edges = await queryAll(
      store.connection,
      'MATCH (a:l0_raw)-[e:EVIDENCE]->(b:memory) RETURN a.id AS from_id, b.id AS to_id, e.reason AS reason',
    )
    expect(edges.map((edge) => String(edge.from_id)).sort()).toEqual([...pointerIds].sort())
    expect(edges.every((edge) => String(edge.reason) === 'refine')).toBe(true)

    const audits = (await refineAudits()).filter((row) => String(row.action) === 'refine_inbox')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ outcome: 'success' })
    // AC 逐字：generation_log.l0Refs 为 seq 列表（不是 L0 id 列表）。
    expect(refsOf(audits[0]!, 'l0_refs')).toEqual(['0', '1'])
    expect(await inboxStatus(item.id)).toBe('done')
  })

  it('旧文本 payload 仍可消费：不读宿主日志，sourceRefs 沿用单 L0 id', async () => {
    const item = await claimLegacyItem('s-legacy', '用户: 旧格式正文')
    const hostLog = fakeHostLog([])
    const { llm, calls } = scriptedLlm([{ text: '旧格式事实', kind: 'work_fact', priority: 0 }])

    await makeProcessor(llm, { hostLog })(item)

    expect(hostLog.opens).toBe(0)
    expect(promptOf(calls[0])).toContain('用户: 旧格式正文')
    const nodes = await nodesFor([item.id])
    expect(nodes).toHaveLength(1)
    expect(refsOf(nodes[0]!, 'source_refs')).toEqual([item.id])
    const audits = (await refineAudits()).filter((row) => String(row.action) === 'refine_inbox')
    expect(refsOf(audits[0]!, 'l0_refs')).toEqual([item.id])
  })
})

describe('hydrate 失败（AC：可重试、不丢条目、status 计 unresolvable_pointers）', () => {
  it('hostLog 缺失 ⇒ InboxRefineError(unresolvable-pointers, fatal=false) + 审计行；条目不 done', async () => {
    const item = await claimPointerItem('s-nohost', [{ seq: 0, type: 'user/message' }])
    const { llm, calls } = scriptedLlm([{ text: '不应产出', kind: 'work_fact', priority: 0 }])

    const error = await makeProcessor(llm, { hostLog: null })(item).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(InboxRefineError)
    expect((error as InboxRefineError).reason).toBe(UNRESOLVABLE_POINTERS_REASON)
    expect((error as InboxRefineError).fatal).toBe(false)
    expect(calls).toHaveLength(0)
    const audits = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = '" + UNRESOLVABLE_POINTERS_ACTION + "' RETURN g.reason AS reason",
    )
    expect(audits).toHaveLength(1)
    expect(String(audits[0]!.reason)).toContain(UNRESOLVABLE_POINTERS_REASON)
    expect(await inboxStatus(item.id)).toBe('processing')
    expect((await countPointerAudits(store.connection)).unresolvablePointers).toBe(1)
  })

  it('读日志抛错 ⇒ 同样可重试；消费者把它放回 pending（attempts+1），条目不丢', async () => {
    const itemId = await enqueuePointerItem('s-readfail', [{ seq: 0, type: 'user/message' }])
    const consumer = createInboxConsumer({
      connection: () => store.connection,
      gate: createIdleGate(),
      owner: 'test-owner',
      now: () => NOW,
      logger: { warn: () => {} },
      process: makeProcessor(scriptedLlm([]).llm, {
        hostLog: fakeHostLog([], { failOpen: true }),
      }),
    })

    expect(await consumer.runOnce()).toBe(0)
    consumer.stop()

    const rows = await queryAll(
      store.connection,
      "MATCH (q:l1_inbox) WHERE q.id = '" + itemId + "' RETURN q.status AS status, q.attempts AS attempts",
    )
    expect(String(rows[0]?.status)).toBe('pending')
    expect(Number(rows[0]?.attempts)).toBe(1)
    expect((await countPointerAudits(store.connection)).unresolvablePointers).toBe(1)
  })

  it('部分 seq 缺失 ⇒ 可用部分照常精炼；缺失计入 unresolvable_pointers，不伪造', async () => {
    const item = await claimPointerItem('s-partial', [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'assistant/message' },
    ])
    const hostLog = fakeHostLog([
      { seq: 0, type: 'user/message', message: { role: 'user', content: '只读得到这一段' } },
    ])
    const { llm, calls } = scriptedLlm([{ text: '部分可用的事实', kind: 'work_fact', priority: 0 }])

    const result = await makeProcessor(llm, { hostLog })(item)

    expect(result).toEqual({ completed: true, kinds: ['work_fact'] })
    expect(promptOf(calls[0])).toContain('user: 只读得到这一段')
    expect(promptOf(calls[0])).not.toContain('assistant:')
    const source = [l0PointerId('s-partial', 0)]
    const nodes = await nodesFor(source)
    expect(nodes).toHaveLength(1)
    expect(refsOf(nodes[0]!, 'source_refs')).toEqual(source)
    expect((await countPointerAudits(store.connection)).unresolvablePointers).toBe(1)
    expect(await inboxStatus(item.id)).toBe('done')
  })
})

describe('多源证据的幂等与写边顺序（回归）', () => {
  it('多个 L1 fact × 多个 pointer seq ⇒ 每个节点各得 N 条 EVIDENCE 边（MERGE 幂等）', async () => {
    const item = await claimPointerItem('s-multi', [
      { seq: 0, type: 'user/message' },
      { seq: 1, type: 'tool/result' },
    ])
    const hostLog = fakeHostLog([
      { seq: 0, type: 'user/message', message: { role: 'user', content: '甲' } },
      { seq: 1, type: 'tool/result', message: { role: 'tool', content: '乙' } },
    ])
    const { llm } = scriptedLlm([
      { text: '事实一', kind: 'work_fact', priority: 0 },
      { text: '事实二', kind: 'work_fact', priority: 0 },
    ])

    await makeProcessor(llm, { hostLog })(item)

    const edges = await queryAll(
      store.connection,
      'MATCH (a:l0_raw)-[e:EVIDENCE]->(b:memory) RETURN a.id AS from_id, b.id AS to_id',
    )
    // 2 个 L1 节点 × 2 个 pointer L0 = 4 条边。
    expect(edges).toHaveLength(4)
    expect(new Set(edges.map((edge) => String(edge.to_id))).size).toBe(2)
    expect(new Set(edges.map((edge) => String(edge.from_id))).size).toBe(2)
    // 显式写一次同边：MERGE 幂等，不新增。
    const [first] = edges
    const memoryId = String(first!.to_id)
    await writeEvidenceEdges(store.connection, [
      {
        fromId: String(first!.from_id),
        fromLayer: 'L0',
        toId: memoryId,
        toLayer: 'L1',
        reason: 'refine',
      },
    ])
    const again = await queryAll(store.connection, 'MATCH (a:l0_raw)-[e:EVIDENCE]->(b:memory) RETURN a.id AS from_id')
    expect(again).toHaveLength(4)
    // 确保这个节点确实是 L1（不是 kNN 合并进别的层）。
    const node = await queryAll(store.connection, "MATCH (m:memory) WHERE m.id = '" + memoryId + "' RETURN m.layer AS layer")
    expect(String(node[0]?.layer)).toBe(MEMORY_REMEMBER_LAYER)
    // 顺带钉住 upsert 直写路径未被本 story 改动（夹具自检）。
    expect(await upsertMemory(store.connection, { layer: MEMORY_REMEMBER_LAYER, text: '探针' })).toBeTruthy()
  })
})

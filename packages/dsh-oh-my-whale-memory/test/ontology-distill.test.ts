/**
 * 抽取路径接线测试（Story 9.1 / T6、矩阵行 8-10）。
 *
 * 断言：
 * - off 档与未启用本体时**逐条一致**（节点行与 refine 审计行同形，且零 ontology_discard）；
 * - align 档丢弃不合形状候选、按维记账，L0 与已有节点不受影响；
 * - 本体索引缺失时整闸 fail-open（AD-31:437），只告警不丢候选。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { writeL0Raw } from '../src/db/l0'
import { queryAll, upsertMemory } from '../src/db/memory'
import { claimNextInboxItem, enqueueInboxItem, type InboxItem } from '../src/inbox/queue'
import { createInboxProcessor, type InboxProcessorDeps } from '../src/distill/processor'
import { buildOntologyIndex } from '../src/ontology/index'
import type { OntologyGatePolicy } from '../src/ontology/gate'
import { MEMORY_REMEMBER_LAYER } from '../src/shared/memory-vocab'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = new Date('2026-11-18T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }

let store: MemoryDatabase
let seq = 0
const nextId = (tag: string): string => 'onto-' + tag + '-' + process.pid + '-' + seq++

beforeEach(async () => {
  const dir = await makeTempDir('omw-ontology-distill-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed-model' })
})

afterEach(async () => {
  try { await store?.close() } catch { /* ignore */ }
})

afterAll(cleanupTempDirs)

const textDelta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finishChunk = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk
const okOutput = (facts: readonly unknown[]): readonly StreamChunk[] => [
  textDelta(JSON.stringify({ facts })),
  finishChunk({ kind: 'stop' }),
]

function scriptedLlm(facts: readonly unknown[] = [
  { text: '用户偏好中文回复', kind: 'work_fact', priority: 0 },
  { text: '用户是产品负责人', kind: 'user_portrait', priority: 0 },
]): { llm: InboxProcessorDeps['llm']; calls: unknown[] } {
  const calls: unknown[] = []
  const script = okOutput(facts)
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* generate() {
          for (const chunk of script) yield chunk
        })()
      },
    },
  }
}

function makeProcessor(llm: InboxProcessorDeps['llm'], overrides: Partial<InboxProcessorDeps> = {}) {
  return createInboxProcessor({
    connection: () => store.connection,
    llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    ...overrides,
  })
}

async function claimFixture(tag: string): Promise<InboxItem> {
  const id = nextId(tag)
  await writeL0Raw(store.connection, { id, text: '原文', recordedAt: NOW, actor: 'sess-1' })
  await enqueueInboxItem(store.connection, { id, payload: '原文', kind: 'work_fact', sessionId: 'sess-1', now: NOW })
  const item = await claimNextInboxItem(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

const refsOf = (row: Record<string, unknown>, column: string): string[] => {
  const value = row[column]
  return Array.isArray(value) ? value.map(String) : []
}

async function memoryRowsFor(id: string): Promise<Array<{ layer: string; kind: string; priority: number; text: string }>> {
  const rows = await queryAll(
    store.connection,
    'MATCH (m:memory) RETURN m.layer AS layer, m.kind AS kind, m.priority AS priority, ' +
    'm.text AS text, m.source_refs AS source_refs',
  )
  return rows
    .filter((row) => refsOf(row, 'source_refs').includes(id))
    .map((row) => ({
      layer: String(row.layer),
      kind: String(row.kind),
      priority: Number(row.priority),
      text: String(row.text),
    }))
    .sort((left, right) => left.text.localeCompare(right.text))
}

async function refineAuditShapeFor(id: string): Promise<Array<{ action: string; outcome: string; reason: string | null }>> {
  const rows = await queryAll(
    store.connection,
    'MATCH (g:generation_log) RETURN g.kind AS kind, g.action AS action, g.outcome AS outcome, ' +
    'g.reason AS reason, g.l0_refs AS l0_refs',
  )
  return rows
    .filter((row) => String(row.kind) === 'refine' && refsOf(row, 'l0_refs').includes(id))
    .map((row) => ({
      action: String(row.action),
      outcome: String(row.outcome),
      reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    }))
    .sort((left, right) => left.action.localeCompare(right.action))
}

async function l0Exists(id: string): Promise<boolean> {
  const rows = await queryAll(store.connection, `MATCH (l:l0_raw {id: '${id}'}) RETURN l.id AS id`)
  return rows.length === 1
}

describe('矩阵行 8：off 档与未启用本体逐条一致', () => {
  it('节点行与 refine 审计行同形，且零 ontology_discard', async () => {
    const baselineItem = await claimFixture('baseline')
    await makeProcessor(scriptedLlm().llm)(baselineItem)

    const offItem = await claimFixture('off')
    const { llm } = scriptedLlm()
    await makeProcessor(llm, {
      ontology: {
        index: buildOntologyIndex({ entityTypes: ['work_fact'] }),
        policy: { level: 'off' } as OntologyGatePolicy,
      },
    })(offItem)

    expect(await memoryRowsFor(offItem.id)).toEqual(await memoryRowsFor(baselineItem.id))
    expect(await refineAuditShapeFor(offItem.id)).toEqual(await refineAuditShapeFor(baselineItem.id))
    expect(await l0Exists(offItem.id)).toBe(true)

    const discardRows = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'ontology_discard' RETURN g.id AS id",
    )
    expect(discardRows).toHaveLength(0)
  })
})

describe('T6：align 丢弃不合形状候选，L0 / 已有节点不受影响', () => {
  it('未声明 kind 的候选被丢弃、按维记账；L0 照常写、既有节点仍在', async () => {
    // 已有节点：本体变更不得回溯删除它（AD-18 / AD-19）。
    await upsertMemory(store.connection, {
      layer: MEMORY_REMEMBER_LAYER,
      text: '既有节点',
      kind: 'user_portrait',
      priority: 0,
    })
    const item = await claimFixture('align')
    const result = await makeProcessor(scriptedLlm().llm, {
      ontology: {
        index: buildOntologyIndex({ entityTypes: ['work_fact'] }),
        policy: { level: 'align' },
      },
    })(item)

    expect(result).toEqual({ completed: true, kinds: ['work_fact'] })
    const nodes = await memoryRowsFor(item.id)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe('work_fact')
    // L0 是 append-only 观测：候选被丢弃不影响它。
    expect(await l0Exists(item.id)).toBe(true)
    // 已有节点未被回溯删除。
    const existing = await queryAll(store.connection, "MATCH (m:memory) WHERE m.text = '既有节点' RETURN m.id AS id")
    expect(existing).toHaveLength(1)

    // 账本：一维一行，detail 记条数；本用例只有 user_portrait 一条被 ③ 丢弃。
    const discardRows = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'ontology_discard' RETURN g.detail AS detail",
    )
    expect(discardRows).toHaveLength(1)
    expect(JSON.parse(String(discardRows[0]?.detail))).toEqual({ dimension: 'entityType', dropped: 1 })
  })

  it('全部候选被丢弃时事务仍完成：零 L1、L0 在、条目 done、按维记账', async () => {
    const item = await claimFixture('align-all-dropped')
    const result = await makeProcessor(scriptedLlm([
      { text: '用户是产品负责人', kind: 'user_portrait', priority: 0 },
    ]).llm, {
      ontology: {
        index: buildOntologyIndex({ entityTypes: ['work_fact'] }),
        policy: { level: 'align' },
      },
    })(item)

    expect(result).toEqual({ completed: true, kinds: [] })
    expect(await memoryRowsFor(item.id)).toHaveLength(0)
    expect(await l0Exists(item.id)).toBe(true)
    const status = await queryAll(store.connection, `MATCH (q:l1_inbox {id: '${item.id}'}) RETURN q.status AS status`)
    expect(String(status[0]?.status)).toBe('done')
    const discardRows = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'ontology_discard' RETURN g.detail AS detail",
    )
    expect(discardRows).toHaveLength(1)
    expect(JSON.parse(String(discardRows[0]?.detail))).toEqual({ dimension: 'entityType', dropped: 1 })
  })
})

describe('AD-31:437：索引缺失 ⇒ 整闸 fail-open', () => {
  it('只告警一次、全部候选放行、不写丢弃账本', async () => {
    const warn = vi.fn()
    const first = await claimFixture('failopen-1')
    const second = await claimFixture('failopen-2')
    const processor = makeProcessor(scriptedLlm().llm, {
      logger: { warn },
      ontology: { index: null, policy: { level: 'align' } },
    })

    const firstResult = await processor(first)
    const secondResult = await processor(second)

    expect(firstResult.kinds).toEqual(['work_fact', 'user_portrait'])
    expect(secondResult.kinds).toEqual(['work_fact', 'user_portrait'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('fail-open')
    const discardRows = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'ontology_discard' RETURN g.id AS id",
    )
    expect(discardRows).toHaveLength(0)
  })
})

/**
 * Epic 8 服务层 E2E：**经 `apply` 装配的真实链路**（不只是直接调工厂）。
 *
 * 现状缺口：`context-compaction-*` 都是单元级（假连接 / 直接调 wiring 工厂），
 * `command-status-db` 只覆盖了 `runs=0`。本文件补的是「装好的插件真的会把
 * `compaction/summary` 变成 INBOX 行 + `compaction_run` 行 + status 里的 runs/last」，
 * 以及 AC:1536-1538（失败隔离）与 AC:1544（孤儿解阻塞留账）在装配面上的行为。
 *
 * **无 sleep**：等待一律用 `vi.waitFor` 等一个**正向完成信号**（审计行 / warn 调用），
 * 不用固定延时。
 *
 * 开库预算：1 个库（apply 建库 → 同路径复用句柄读断言）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const TS = '2026-06-01T00:00:00.000Z'
const CONFIG = {
  embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 },
  // 孤儿解阻塞超时调小，避免用例真的等 60s（默认值由 compaction-orphan 的常量用例守住）。
  compactionOrphanTimeoutMs: 40,
}

type Listener = (session: unknown, event: unknown) => void | Promise<void>

interface Captured {
  readonly listeners: Listener[]
  readonly commands: MemoryCommandDefinition[]
  readonly warn: ReturnType<typeof vi.fn>
  readonly closers: Array<() => unknown>
}

let dir: string
let dbPath: string
let store: MemoryDatabase
let captured: Captured

/** 裸 ctx（同 command-status-db）：捕获 session/event 监听器、命令定义与 closers。 */
function makeCtx(capture: Captured): Parameters<typeof apply>[0] {
  return {
    logger: { warn: capture.warn, info: vi.fn() },
    llm: { stream: () => (async function* empty() {})() },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    get: (key: string) => {
      if (key === 'profileContext') return { dir }
      if (key === 'commands') {
        return {
          register: (definition: MemoryCommandDefinition) => {
            capture.commands.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    on: (event: string, listener: Listener) => {
      if (event === 'session/event') capture.listeners.push(listener)
      return () => {}
    },
    effect: (factory: () => () => unknown) => capture.closers.push(factory()),
    tools: { register: () => () => {} },
  } as unknown as Parameters<typeof apply>[0]
}

/** stock 形态的 `compaction/summary`（dsh-compaction-basic index.js:634-649，**无 sessionId/turn**）。 */
function stockSummary(overrides: Record<string, unknown> = {}) {
  return {
    type: 'compaction/summary',
    compactionId: 'c-1',
    summary: '压缩摘要正文：这一段被折叠了',
    shadowedSeqs: [1, 2, 3],
    shadowedRange: { start: 1, end: 3 },
    shadowedTokenCount: 120,
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    ...overrides,
  }
}

async function dispatch(sessionId: string, event: Record<string, unknown>): Promise<void> {
  for (const listener of captured.listeners) await listener({ id: sessionId }, event)
}

async function countRows(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  const rows = await queryRows(store.connection, cypher, params)
  return Number(rows[0]?.total ?? 0)
}

/** 每次成功入图都会写一条 `compaction_summary_ingested` 审计行 —— 用作**完成屏障**。 */
async function ingestedCount(): Promise<number> {
  return countRows(
    "MATCH (g:generation_log) WHERE g.action = 'compaction_summary_ingested' RETURN count(g) AS total",
  )
}

async function orphanCount(): Promise<number> {
  return countRows(
    "MATCH (g:generation_log) WHERE g.action = 'compaction_orphan_unblocked' RETURN count(g) AS total",
  )
}

async function inboxCount(): Promise<number> {
  return countRows('MATCH (i:l1_inbox) RETURN count(i) AS total')
}

async function runCount(): Promise<number> {
  return countRows('MATCH (r:compaction_run) RETURN count(r) AS total')
}

async function statusText(): Promise<string> {
  const command = captured.commands.find((definition) => definition.name === 'memory')
  if (command === undefined) throw new Error('apply 未注册 /memory 命令')
  const result = await command.handler({ rawInput: ' status' })
  if (result.kind !== 'success') throw new Error('status 返回非 success：' + JSON.stringify(result))
  return result.text
}

beforeAll(async () => {
  dir = await makeTempDir('omw-epic8-apply-')
  dbPath = resolveMemoryDbPath(dir)
  captured = { listeners: [], commands: [], warn: vi.fn(), closers: [] }
  await apply(makeCtx(captured), CONFIG as Parameters<typeof apply>[1])
  // 同路径复用 apply 已建好的句柄（database.ts 按绝对路径去重）。
  store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'bge-m3' })
})

afterAll(async () => {
  await store?.close()
  for (const closer of captured.closers.reverse()) await closer()
  await cleanupTempDirs()
})

describe('装配面上 compaction/summary 真的入图（AC:1528-1539）', () => {
  it('一条 summary ⇒ INBOX 一行（幂等键作 id）+ compaction_run 一行', async () => {
    await dispatch('s-apply', stockSummary())
    await vi.waitFor(async () => {
      expect(await ingestedCount()).toBe(1)
    }, { timeout: 3000, interval: 25 })

    expect(await inboxCount()).toBe(1)
    const inbox = await queryRows(
      store.connection,
      'MATCH (i:l1_inbox) RETURN i.id AS id, i.payload AS payload, i.kind AS kind',
    )
    expect(String(inbox[0]?.id)).toBe('compaction:s-apply#c-1')
    expect(String(inbox[0]?.payload)).toContain('压缩摘要正文')
    expect(String(inbox[0]?.kind)).toBe('compaction-summary')

    expect(await runCount()).toBe(1)
    const run = await queryRows(
      store.connection,
      'MATCH (r:compaction_run) RETURN r.compaction_id AS cid, r.session_id AS sid, r.shadowed_seqs_json AS seqs',
    )
    expect(String(run[0]?.cid)).toBe('c-1')
    // 会话归属来自**事件目标 session**（stock payload 里没有 sessionId）
    expect(String(run[0]?.sid)).toBe('s-apply')
    expect(String(run[0]?.seqs)).toBe('[1,2,3]')
  })

  it('status 的 compaction 行反映真实 runs 与最近一次（此前只覆盖 runs=0）', async () => {
    const text = await statusText()
    expect(text).toMatch(/^compaction: runs=1 last=c-1@\d{4}-\d{2}-\d{2}T/m)
  })

  it('同一 (session, compactionId) 重投 ⇒ 幂等：INBOX 与 run 都不增', async () => {
    await dispatch('s-apply', stockSummary({ summary: '正文不同也同键' }))
    // 完成屏障：第二次入图同样会写一条审计行，等它出现即可确定流程走完。
    await vi.waitFor(async () => {
      expect(await ingestedCount()).toBe(2)
    }, { timeout: 3000, interval: 25 })
    expect(await inboxCount()).toBe(1)
    expect(await runCount()).toBe(1)
  })
})

describe('失败隔离与孤儿留账（AC:1536-1538、AC:1544）', () => {
  it('summary 缺 compactionId ⇒ 只 warn 不抛，且不新增行', async () => {
    const before = { inbox: await inboxCount(), runs: await runCount() }
    captured.warn.mockClear()
    await expect(dispatch('s-apply', stockSummary({ compactionId: undefined }))).resolves.toBeUndefined()
    // 完成屏障：失败路径的唯一可观测信号就是 warn。
    await vi.waitFor(() => {
      expect(captured.warn.mock.calls.some((call) => String(call[0]).includes('compaction/summary 入图失败'))).toBe(true)
    }, { timeout: 3000, interval: 25 })
    expect(await inboxCount()).toBe(before.inbox)
    expect(await runCount()).toBe(before.runs)
  })

  it('未配对的 compaction/start ⇒ 超时后解阻塞并写一条 generation_log（AC:1544）', async () => {
    const before = await orphanCount()
    await dispatch('s-orphan', { type: 'compaction/start', turn: 2 })
    await vi.waitFor(async () => {
      expect(await orphanCount()).toBe(before + 1)
    }, { timeout: 3000, interval: 25 })

    const rows = await queryRows(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = 'compaction_orphan_unblocked' RETURN g.outcome AS outcome, g.reason AS reason",
    )
    expect(String(rows[0]?.outcome)).toBe('uncertain')
    expect(String(rows[0]?.reason)).toContain('session=s-orphan')
    expect(String(rows[0]?.reason)).toContain('turn=2')
  })
})

describe('时间戳来源', () => {
  it('compaction_run.started_at 是 UTC ISO-8601（不是本地时区）', async () => {
    const rows = await queryRows(store.connection, 'MATCH (r:compaction_run) RETURN r.started_at AS started')
    const started = String(rows[0]?.started)
    expect(started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(started >= TS).toBe(true)
  })
})

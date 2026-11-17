/**
 * Epic 8 服务层 E2E：`memory_expand` **经 apply 注册的真实链路**。
 *
 * 现状缺口：`tool-memory-expand.test.ts` 直接调 `createMemoryExpandTool`（自造 quota/会话注入），
 * 因此「apply 之后拿到的那一个工具实例」的装配正确性（quota 实例共享、会话来源）没有覆盖。
 * 本文件补这一层：真 apply → 真库 → 真句柄 → 逐字还原 + 与 recall 共享配额。
 *
 * 开库预算：1 个库（apply 建库 → 同路径复用句柄）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { writeHandle } from '../src/context/handles'
import { cleanupTempDirs, makeTempDir } from './tmp'

const TS = '2026-06-01T00:00:00.000Z'
const OWNER = 's-expand-apply'
const CONFIG = { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } }

interface CapturedTool {
  readonly name: string
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
  readonly output: { render: (args: unknown, value: unknown) => unknown }
}

let dir: string
let store: MemoryDatabase
let tools: CapturedTool[]
let closers: Array<() => unknown>

function execOf(sessionId: string): unknown {
  return { agent: { session: { id: sessionId } } }
}

beforeAll(async () => {
  dir = await makeTempDir('omw-epic8-expand-')
  tools = []
  closers = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    llm: { stream: () => (async function* empty() {})() },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
    on: () => () => {},
    effect: (factory: () => () => unknown) => closers.push(factory()),
    tools: {
      register: (definition: CapturedTool) => {
        tools.push(definition)
        return () => {}
      },
    },
  } as unknown as Parameters<typeof apply>[0]
  await apply(ctx, CONFIG as Parameters<typeof apply>[1])
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'bge-m3' })
})

afterAll(async () => {
  await store?.close()
  for (const closer of closers.reverse()) await closer()
  await cleanupTempDirs()
})

function expandTool(): CapturedTool {
  const tool = tools.find((candidate) => candidate.name === 'memory_expand')
  if (tool === undefined) throw new Error('apply 未注册 memory_expand 工具')
  return tool
}

describe('apply 注册的 memory_expand（AC:1611-1622）', () => {
  it('真库 + 真句柄 ⇒ 逐字还原（含换行/emoji/长文本）', async () => {
    const text = '原文 🐋\r\n第二行\t制表\n' + 'z'.repeat(5000)
    const record = await writeHandle(store.connection, {
      sessionId: OWNER,
      seq: 11,
      text,
      recordedAt: TS,
    })
    const value = await expandTool().execute({ handle: record.id }, execOf(OWNER))
    expect(value.restored).toBe(true)
    expect(value.text).toBe(text)
    expect(value.total).toBe(text.length)
    expect(value.bytes).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('整段句柄块入参也能还原（模型抄表面里的那一串）', async () => {
    const text = '块入参正文'
    const record = await writeHandle(store.connection, { sessionId: OWNER, seq: 12, text, recordedAt: TS })
    const value = await expandTool().execute(
      { handle: '[omw:handle=' + record.id + ' ~4 tokens]' },
      execOf(OWNER),
    )
    expect(value.restored).toBe(true)
    expect(value.text).toBe(text)
  })

  it('其它会话的句柄 ⇒ session_mismatch，且返回值不含正文', async () => {
    const text = '别人的正文不该出现'
    const record = await writeHandle(store.connection, { sessionId: 's-other', seq: 13, text, recordedAt: TS })
    const value = await expandTool().execute({ handle: record.id }, execOf(OWNER))
    expect(value.restored).toBe(false)
    expect((value.error as { code: string }).code).toBe('session_mismatch')
    expect(JSON.stringify(value)).not.toContain(text)
  })

  it('与 recall/related 共享同一配额实例：第 4 次调用被拒（FR-10 合计 ≤3）', async () => {
    const record = await writeHandle(store.connection, { sessionId: 's-quota-apply', seq: 21, text: '配额用例', recordedAt: TS })
    const exec = execOf('s-quota-apply')
    const tool = expandTool()
    for (let index = 0; index < 3; index += 1) {
      const ok = await tool.execute({ handle: record.id }, exec)
      expect(ok.restored).toBe(true)
    }
    const blocked = await tool.execute({ handle: record.id }, exec)
    expect(blocked.restored).toBe(false)
    expect((blocked.error as { code: string, retryable: boolean }).code).toBe('quota_exceeded')
    expect((blocked.error as { retryable: boolean }).retryable).toBe(false)
  })

  it('非法入参不消耗配额（手抄错不该吃掉本轮额度）', async () => {
    const exec = execOf('s-invalid-apply')
    const tool = expandTool()
    const record = await writeHandle(store.connection, { sessionId: 's-invalid-apply', seq: 31, text: 'x', recordedAt: TS })
    for (let index = 0; index < 3; index += 1) {
      const bad = await tool.execute({ handle: '   ' }, exec)
      expect((bad.error as { code: string }).code).toBe('handle_not_found')
    }
    // 三次非法入参之后，配额仍然可用
    const ok = await tool.execute({ handle: record.id }, exec)
    expect(ok.restored).toBe(true)
  })

  it('render 对失败值产出可读文本（不抛）', () => {
    const tool = expandTool()
    const blocks = tool.output.render({}, {
      restored: false,
      error: { code: 'handle_expired', message: '已失效', retryable: true },
    }) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('handle_expired')
    expect(blocks[0]?.text).toContain('retryable=true')
  })
})

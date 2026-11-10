/**
 * memory_remember 工具测试（Story 1.6 / spec I/O 矩阵）。
 *
 * 契约：
 * - 工具名 `memory_remember`，参数 `content`（必填）/ `context`（可选 → source_refs）；
 * - 固定写 layer='L1'；不产 embedding（三列向量 NULL，绝不写零向量）；
 * - 同指纹重复 → 同一 id（幂等）+ source_refs 并集去重 + recorded_at 保留最早 + 节点数不变；
 * - 库未就绪（无 profile / 无句柄）→ failed db_unavailable，retryable=false；
 * - 归一化后为空（'。…'）→ failed empty_fingerprint_text；
 * - 写入期异常 → MemoryDbError 透传其 code / 其他错误兜底 db_write_failed；
 * - execute 绝不 throw（宿主把 throw 渲染成 isError）——所有失败走 canonical failed 值；
 * - description 护栏必须声明"不是 ephemeral/transient content"。
 *
 * 工具定义经 apply → ctx.tools.register 捕获（真实 defineTool 编译产物），
 * execute 走真实 LadybugDB 驱动（依赖 Windows OpenSSL 3 注入，同 abi-smoke）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { MemoryDbError } from '../src/db/errors'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import { createMemoryRememberTool, MEMORY_REMEMBER_LAYER, MEMORY_REMEMBER_TOOL_NAME } from '../src/tools/memory-remember'
import { injectOpenSslPath } from './openssl'

/** ctx.tools.register 捕获到的真实 ToolDefinition（defineTool 编译产物）。 */
interface CapturedTool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, { type?: string; required?: boolean; description?: string }>
    required?: string[]
  }
  output: {
    schema: {
      oneOf?: Array<{ type: string; properties: { action?: { const?: string } } }>
    }
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: Record<string, string>, exec?: unknown) => Promise<{
    action: string
    id?: string
    error?: { code: string; message: string; retryable: boolean }
  }>
}

function fakeCtx(opts: { dir?: string; registered: CapturedTool[] }) {
  const closers: Array<() => unknown> = []
  const warn = vi.fn()
  const info = vi.fn()
  const ctx = {
    logger: { warn, info },
    get: (key: string) => (key === 'profileContext' && opts.dir !== undefined ? { dir: opts.dir } : undefined),
    effect: (factory: () => () => unknown) => {
      closers.push(factory())
    },
    tools: {
      register: (def: CapturedTool) => {
        opts.registered.push(def)
        return () => {}
      },
    },
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, closers }
}

let dir: string
let dbPath: string
let store: MemoryDatabase
let registered: CapturedTool[]
let tool: CapturedTool

beforeAll(async () => {
  injectOpenSslPath()
  dir = await mkdtemp(join(tmpdir(), 'omw-tool-remember-'))
  dbPath = resolveMemoryDbPath(dir)
  registered = []
  const { ctx } = fakeCtx({ dir, registered })
  await apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
  expect(registered).toHaveLength(1)
  tool = registered[0]
  // 复用同一绝对路径的句柄（database.ts 按绝对路径去重），用于行级断言。
  store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'bge-m3' })
})

afterAll(async () => {
  try {
    await store?.close()
  } catch {
    /* ignore */
  }
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function rowsFor(id: string) {
  return queryAll(
    store.connection,
    `MATCH (m:memory {id: '${id}'}) RETURN m.layer AS layer, m.text AS text, m.recorded_at AS recorded_at, m.source_refs AS refs, m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim`,
  )
}

describe('memory_remember 工具（Story 1.6）', () => {
  it('名称 / 描述护栏 / 参数规则（I/O 矩阵 + FR-1）', () => {
    expect(tool.name).toBe(MEMORY_REMEMBER_TOOL_NAME)
    expect(tool.name).toBe('memory_remember')
    // 护栏：description 必须声明排除 ephemeral/transient 内容。
    expect(tool.description).toMatch(/ephemeral/)
    expect(tool.description).toMatch(/transient/)
    expect(tool.description).toMatch(/长期/)

    // 参数：content 必填 string，context 可选 string。
    expect(tool.parameters.properties.content.type).toBe('string')
    expect(tool.parameters.required).toContain('content')
    expect(tool.parameters.required ?? []).not.toContain('context')
    expect(tool.parameters.properties.context.type).toBe('string')

    // 输出 schema：oneOf 两个 canonical 分支（stored / failed）。
    const branches = tool.output.schema.oneOf ?? []
    expect(branches.map((b) => b.properties?.action?.const)).toEqual(['stored', 'failed'])
  })

  it('首次写入：stored + layer L1 + recorded_at UTC ISO-8601 + 三列向量 NULL + source_refs []', async () => {
    const value = await tool.execute({ content: '用户偏好深色主题' })
    expect(value.action).toBe('stored')
    expect(value.id).toBeTypeOf('string')

    const rows = await rowsFor(value.id!)
    expect(rows).toHaveLength(1)
    expect(rows[0]['layer']).toBe(MEMORY_REMEMBER_LAYER)
    expect(rows[0]['layer']).toBe('L1')
    expect(rows[0]['text']).toBe('用户偏好深色主题')
    expect(typeof rows[0]['recorded_at']).toBe('string')
    // 库层产出规范 UTC ISO-8601：round-trip 应得到自身。
    expect(new Date(rows[0]['recorded_at'] as string).toISOString()).toBe(rows[0]['recorded_at'])
    expect(rows[0]['refs']).toEqual([])
    expect(rows[0]['embedding']).toBeNull()
    expect(rows[0]['model_id']).toBeNull()
    expect(rows[0]['dim']).toBeNull()
  })

  it('带 context → source_refs=[context]（缺省为 []，而非空串或 undefined）', async () => {
    const value = await tool.execute({ content: '部署端点是 https://api.example.com', context: 'msg-42' })
    expect(value.action).toBe('stored')
    const rows = await rowsFor(value.id!)
    expect(rows[0]['refs']).toEqual(['msg-42'])
  })

  it('context 为空串或纯空白 → source_refs 为空数组（不落空串）', async () => {
    const empty = await tool.execute({ content: 'empty-context-fact', context: '' })
    expect(empty.action).toBe('stored')
    const emptyRows = await rowsFor(empty.id!)
    expect(emptyRows[0]['refs']).toEqual([])

    const blank = await tool.execute({ content: 'blank-context-fact', context: '   ' })
    expect(blank.action).toBe('stored')
    const blankRows = await rowsFor(blank.id!)
    expect(blankRows[0]['refs']).toEqual([])
  })

  it('同指纹幂等：大小写/标点/空白变体 + 不同 context → 同一 id、refs 并集、recorded_at 保留最早、节点数不变', async () => {
    const first = await tool.execute({ content: 'Theme Pref: Dark', context: 'msg-a' })
    const rowsBefore = await rowsFor(first.id!)
    const firstRecordedAt = rowsBefore[0]['recorded_at']

    const second = await tool.execute({ content: '  theme pref  dark!!! ', context: 'msg-b' })
    expect(second.action).toBe('stored')
    expect(second.id).toBe(first.id)

    const rows = await rowsFor(second.id!)
    expect(rows).toHaveLength(1) // 节点数不变
    // text 保留首次原文（ON MATCH 不改写）。
    expect(rows[0]['text']).toBe('Theme Pref: Dark')
    expect(rows[0]['refs']).toEqual(['msg-a', 'msg-b'])
    expect(rows[0]['recorded_at']).toBe(firstRecordedAt) // 保留最早
    expect(rows[0]['embedding']).toBeNull()
  })

  it('context 缺省重复写入：source_refs 保持 []', async () => {
    const first = await tool.execute({ content: 'no-context-fact' })
    const second = await tool.execute({ content: 'no-context-fact' })
    expect(second.id).toBe(first.id)
    const rows = await rowsFor(second.id!)
    expect(rows).toHaveLength(1)
    expect(rows[0]['refs']).toEqual([])
  })

  it('库未就绪（无 profile）：工具已注册但 execute 返回 db_unavailable', async () => {
    const bareRegistered: CapturedTool[] = []
    const { ctx } = fakeCtx({ registered: bareRegistered })
    await apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
    expect(bareRegistered).toHaveLength(1)

    const value = await bareRegistered[0].execute({ content: 'anything' })
    expect(value.action).toBe('failed')
    expect(value.error).toMatchObject({ code: 'db_unavailable', retryable: false })
    // 诊断信息不含凭据（本路径无凭据注入）。
    expect(value.error!.message).not.toMatch(/sk-test|token/)
  })

  it('直接工厂：getDb 返回 undefined → db_unavailable（无句柄）', async () => {
    const toolDef = createMemoryRememberTool(() => undefined) as unknown as CapturedTool
    const value = await toolDef.execute({ content: 'x' })
    expect(value.action).toBe('failed')
    expect(value.error).toMatchObject({ code: 'db_unavailable', retryable: false })
  })

  it('归一化后为空：纯空白与纯标点 → empty_fingerprint_text', async () => {
    const ws = await tool.execute({ content: '   ' })
    expect(ws.action).toBe('failed')
    expect(ws.error).toMatchObject({ code: 'empty_fingerprint_text', retryable: false })

    const punct = await tool.execute({ content: '。。。' })
    expect(punct.action).toBe('failed')
    expect(punct.error).toMatchObject({ code: 'empty_fingerprint_text', retryable: false })
  })

  it('写入期异常：MemoryDbError 透传 code / 其他错误兜底 db_write_failed，均不 throw', async () => {
    const throwing = createMemoryRememberTool(() => ({
      upsertMemory: async () => {
        throw new Error('driver exploded')
      },
    })) as unknown as CapturedTool
    const generic = await throwing.execute({ content: 'x' })
    expect(generic.action).toBe('failed')
    expect(generic.error).toMatchObject({
      code: 'db_write_failed',
      message: 'driver exploded',
      retryable: false,
    })

    const dimErr = createMemoryRememberTool(() => ({
      upsertMemory: async () => {
        throw new MemoryDbError('embedding_dim_mismatch', '向量长度 2 与 dim 4 不符')
      },
    })) as unknown as CapturedTool
    const typed = await dimErr.execute({ content: 'x' })
    expect(typed.action).toBe('failed')
    expect(typed.error).toMatchObject({ code: 'embedding_dim_mismatch', retryable: false })
  })

  it('render：stored / failed 两分支都产出文本块，不 throw', () => {
    const storedText = tool.output.render({}, { action: 'stored', id: 'node-1' })
    expect(storedText[0]).toMatchObject({ type: 'text' })
    expect(storedText[0].text).toContain('node-1')

    const failedText = tool.output.render(
      {},
      { action: 'failed', error: { code: 'db_unavailable', message: 'm', retryable: false } },
    )
    expect(failedText[0].type).toBe('text')
    expect(failedText[0].text).toContain('db_unavailable')
    expect(failedText[0].text).toContain('retryable=false')
  })
})

/**
 * memory_forget 工具契约测试（Story 4.1 / spec I/O 矩阵；假 store，0 开库）。
 *
 * 覆盖：工具形态（名字 / 参数 / oneOf 两分支）、成功值字段与钉死的 hint、
 * 空白 id（行 4，不查库）、库未就绪（db_unavailable）、只读实例（行 12，readonly_mode）、
 * 不存在（行 3，memory_not_found）、异常兜底（db_read_failed）、presenter 两分支都不 throw。
 *
 * 关键不变量：本工具**没有执行通道** —— 所有权用用例都不产生任何写入，也不 import db/forget。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import {
  MEMORY_FORGET_CONFIRMATION_HINT,
  MEMORY_FORGET_TOOL_NAME,
  createMemoryForgetTool,
  type MemoryForgetStore,
} from '../src/tools/memory-forget'

interface CapturedValue {
  action: 'confirmation_required' | 'failed'
  id?: string
  layer?: string
  text?: string
  hint?: string
  error?: { code: string; message: string; retryable: boolean }
}

interface CapturedTool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, { type?: string; required?: boolean }>
    required?: string[]
  }
  output: {
    schema: { oneOf?: Array<{ type: string; properties: { action?: { const?: string } } }> }
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: { id: string }, exec?: unknown) => Promise<CapturedValue>
}

function makeStore(overrides: Partial<MemoryForgetStore> = {}): MemoryForgetStore {
  return {
    readonly: false,
    preview: vi.fn(async (id: string) => ({ id, layer: 'L1', text: '一条待遗忘的记忆' })),
    ...overrides,
  }
}

function makeTool(store: MemoryForgetStore | undefined): CapturedTool {
  return createMemoryForgetTool({ getForgetStore: () => store }) as unknown as CapturedTool
}

describe('memory_forget 工具形态', () => {
  it('名字、必填参数 id、描述明说「不执行遗忘」', () => {
    const tool = makeTool(makeStore())
    expect(tool.name).toBe(MEMORY_FORGET_TOOL_NAME)
    expect(MEMORY_FORGET_TOOL_NAME).toBe('memory_forget')
    expect(tool.parameters.required).toContain('id')
    expect(tool.description).toContain('不会执行遗忘')
    expect(tool.description).toContain('/memory forget')
  })

  it('输出 schema 是 oneOf 两分支：confirmation_required 与 failed', () => {
    const schema = makeTool(makeStore()).output.schema
    expect(schema.oneOf).toHaveLength(2)
    expect(schema.oneOf?.[0]?.properties.action?.const).toBe('confirmation_required')
    expect(schema.oneOf?.[1]?.properties.action?.const).toBe('failed')
  })
})

describe('memory_forget execute（假 store）', () => {
  it('默认分支：confirmation_required + 目标字段 + 钉死的 hint（不写库、无执行通道）', async () => {
    const store = makeStore()
    const value = await makeTool(store).execute({ id: ' id-1 ' })

    expect(value).toEqual({
      action: 'confirmation_required',
      id: 'id-1',
      layer: 'L1',
      text: '一条待遗忘的记忆',
      hint: MEMORY_FORGET_CONFIRMATION_HINT,
    })
    // 钉死的 hint 逐字（spec「memory_forget 成功值」）。
    expect(MEMORY_FORGET_CONFIRMATION_HINT).toBe(
      '确认必须由用户的斜杠命令完成：/memory forget <id>。Agent 侧没有确认后自动执行的通道。',
    )
    expect(store.preview).toHaveBeenCalledWith('id-1')
  })

  it('摘要化：text 折行与超长按 summarizeMemoryText 收敛（presenter 不破行）', async () => {
    const long = '很长'.repeat(80)
    const value = await makeTool(makeStore({
      preview: async (id) => ({ id, layer: 'L2', text: `第一行\n第二行 ${long}` }),
    })).execute({ id: 'id-1' })

    expect(value.action).toBe('confirmation_required')
    expect(value.text!.startsWith('第一行 第二行 很长')).toBe(true)
    expect(value.text).toContain('…')
    expect(value.text).not.toContain('\n')
  })

  it('矩阵行 4：空白 id ⇒ failed/invalid_query，不查库', async () => {
    const store = makeStore()
    const value = await makeTool(store).execute({ id: '   ' })
    expect(value.action).toBe('failed')
    expect(value.error?.code).toBe('invalid_query')
    expect(store.preview).not.toHaveBeenCalled()
  })

  it('库未就绪 ⇒ failed/db_unavailable（不查库）', async () => {
    const value = await makeTool(undefined).execute({ id: 'id-1' })
    expect(value.action).toBe('failed')
    expect(value.error?.code).toBe('db_unavailable')
  })

  it('矩阵行 12：只读实例 ⇒ failed/readonly_mode，且在查库之前就拒', async () => {
    const store = makeStore({ readonly: true })
    const value = await makeTool(store).execute({ id: 'id-1' })
    expect(value.action).toBe('failed')
    expect(value.error?.code).toBe('readonly_mode')
    expect(value.error?.retryable).toBe(false)
    expect(store.preview).not.toHaveBeenCalled()
  })

  it('矩阵行 3：不存在 ⇒ failed/memory_not_found +「未找到 id 为 <id> 的记忆。」', async () => {
    const value = await makeTool(makeStore({ preview: async () => null })).execute({ id: 'id-x' })
    expect(value.action).toBe('failed')
    expect(value.error?.code).toBe('memory_not_found')
    expect(value.error?.message).toBe('未找到 id 为 id-x 的记忆。')
  })

  it('preview 抛 MemoryDbError ⇒ 透传 code/retryable；抛普通错误 ⇒ 兜底 db_read_failed', async () => {
    const dbError = await makeTool(makeStore({
      preview: async () => { throw new MemoryDbError('db_read_failed', '底层读失败') },
    })).execute({ id: 'id-1' })
    expect(dbError.error?.code).toBe('db_read_failed')
    expect(dbError.error?.retryable).toBe(false)

    const plain = await makeTool(makeStore({
      preview: async () => { throw new Error('驱动炸了') },
    })).execute({ id: 'id-1' })
    expect(plain.error?.code).toBe('db_read_failed')
    expect(plain.error?.message).toBe('驱动炸了')
  })
})

describe('memory_forget presenter（纯函数）', () => {
  const tool = makeTool(makeStore())

  it('成功分支：渲染 id/layer/摘要 + hint，不 throw', () => {
    const text = tool.output.render({ id: 'id-1' }, {
      action: 'confirmation_required',
      id: 'id-1',
      layer: 'L1',
      text: '一条记忆',
      hint: MEMORY_FORGET_CONFIRMATION_HINT,
    })
    expect(text).toHaveLength(1)
    expect(text[0]!.text).toContain('id-1 [L1] 一条记忆')
    expect(text[0]!.text).toContain(MEMORY_FORGET_CONFIRMATION_HINT)
  })

  it('失败分支：渲染错误码与诊断，不 throw', () => {
    const text = tool.output.render({ id: 'id-1' }, {
      action: 'failed',
      error: { code: 'readonly_mode', message: '只读', retryable: false },
    })
    expect(text).toHaveLength(1)
    expect(text[0]!.text).toContain('readonly_mode')
    expect(text[0]!.text).toContain('retryable=false')
  })
})

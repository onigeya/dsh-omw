/**
 * memory_recall 工具契约测试（Story 3.1 / spec I/O 矩阵）。
 *
 * 假 store 注入（照 tool-memory-remember 范本）：
 * - 成功：{ query, total, results, hint }（degraded 只在降级时出现）；
 * - 无命中：total 0 的正常成功值（不是错误）；
 * - 降级：embeddingEnabled=false / embedQuery 失败或抛错 ⇒ queryVector=null 传给内核；
 * - 配额超限：{ action:'failed', error:{code:'recall_quota_exceeded', retryable:false} }；
 * - 库未就绪：db_unavailable；
 * - limit 夹紧 [1,20]（缺省 5）；
 * - 内核抛错：failed 信封（MemoryDbError 透传 code，其它兜底 recall_failed）；
 * - execute 绝不 throw。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import {
  MEMORY_RECALL_LAYERS,
  MEMORY_RECALL_TOOL_DESCRIPTION,
  MEMORY_RECALL_TOOL_NAME,
  createMemoryRecallTool,
  type MemoryRecallStore,
} from '../src/tools/memory-recall'
import { createRecallTurnQuota } from '../src/tools/recall-quota'

/** defineTool 编译产物的结构描述（照 tool-memory-remember 的 CapturedTool 形态收敛）。 */
interface CapturedTool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, { type?: string; required?: boolean; enum?: readonly string[] }>
    required?: string[]
  }
  output: {
    schema: { oneOf?: Array<{ type: string; properties: { action?: { const?: string } } }> }
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: {
    query: string
    limit?: number
    layer?: (typeof MEMORY_RECALL_LAYERS)[number]
  }, exec?: unknown) => Promise<{
    query?: string
    total?: number
    results?: Array<{ id: string; layer: string; kind: string; priority: number; text: string; truncated?: boolean; evidence?: string[] }>
    hint?: string
    degraded?: boolean
    action?: 'failed'
    error?: { code: string; message: string; retryable: boolean }
  }>
}

const HIT = {
  id: 'id-1',
  layer: 'L1',
  kind: 'work_fact',
  priority: 10,
  text: '用户偏好 ESM',
  evidence: ['msg-1'],
}

function makeStore(overrides: Partial<MemoryRecallStore> = {}): MemoryRecallStore {
  return {
    embeddingEnabled: true,
    embedQuery: async () => [1, 0, 0, 0],
    recall: vi.fn(async () => ({
      total: 1,
      results: [HIT],
      degraded: false,
      hint: '混合检索（语义向量路 + 关键词路，RRF 融合排序）。',
    })),
    ...overrides,
  }
}

function makeTool(store: MemoryRecallStore | undefined, quota = createRecallTurnQuota()): CapturedTool {
  return createMemoryRecallTool({
    getRecallStore: () => store,
    quota,
  }) as unknown as CapturedTool
}

/** `ToolRunContext` 的最小结构视图：配额 owner 只取 `exec.agent.session`（spec D7）。 */
function execOf(sessionId: string): unknown {
  return { agent: { session: { id: sessionId } } }
}

describe('memory_recall 工具形态', () => {
  const tool = makeTool(makeStore())

  it('名称 / 描述护栏 / 参数规则（query 必填，limit integer 可选，layer 枚举 L1/L2）', () => {
    expect(tool.name).toBe(MEMORY_RECALL_TOOL_NAME)
    expect(tool.name).toBe('memory_recall')
    expect(MEMORY_RECALL_TOOL_DESCRIPTION).toMatch(/混合检索/)
    expect(MEMORY_RECALL_TOOL_DESCRIPTION).toMatch(/recall_quota_exceeded/)

    expect(tool.parameters.properties.query.type).toBe('string')
    expect(tool.parameters.required).toContain('query')
    expect(tool.parameters.properties.limit?.type).toBe('integer')
    expect(tool.parameters.required ?? []).not.toContain('limit')
    expect(tool.parameters.properties.layer?.type).toBe('string')
    expect([...(tool.parameters.properties.layer?.enum ?? [])]).toEqual([...MEMORY_RECALL_LAYERS])
    expect(tool.parameters.required ?? []).not.toContain('layer')

    // 输出 schema：oneOf（成功分支无 action 字段；失败分支 action const 'failed'）。
    const branches = tool.output.schema.oneOf ?? []
    expect(branches).toHaveLength(2)
    expect(branches[1]?.properties?.action?.const).toBe('failed')
  })

  it('render：成功（含降级标注）/ 失败 两分支都产出文本块，不 throw', () => {
    const hitText = tool.output.render({}, {
      query: 'q',
      total: 1,
      results: [HIT],
      hint: 'h',
    })
    expect(hitText[0]?.type).toBe('text')
    expect(hitText[0]?.text).toContain('id-1')
    expect(hitText[0]?.text).toContain('按 RRF 排序')
    expect(hitText[0]?.text).not.toContain('降级检索')

    const degradedText = tool.output.render({}, {
      query: 'q',
      total: 1,
      results: [HIT],
      hint: 'h',
      degraded: true,
    })
    expect(degradedText[0]?.text).toContain('降级检索')

    const emptyText = tool.output.render({}, { query: 'q', total: 0, results: [], hint: 'h' })
    expect(emptyText[0]?.text).toContain('无匹配记忆')

    const failedText = tool.output.render(
      {},
      { action: 'failed', error: { code: 'recall_quota_exceeded', message: 'm', retryable: false } },
    )
    expect(failedText[0]?.type).toBe('text')
    expect(failedText[0]?.text).toContain('recall_quota_exceeded')
    expect(failedText[0]?.text).toContain('retryable=false')
  })
})

describe('memory_recall execute（假 store）', () => {
  it('成功：透传内核结果，degraded 只在降级时出现', async () => {
    const store = makeStore()
    const tool = makeTool(store)
    const value = await tool.execute({ query: 'RRF', limit: 5 })
    expect(value.query).toBe('RRF')
    expect(value.total).toBe(1)
    expect(value.results?.[0]).toEqual(HIT)
    expect(value.degraded).toBeUndefined()
    expect(value.hint).toContain('混合检索')
  })

  it('无命中：total 0 的正常成功值（不是错误）', async () => {
    const store = makeStore({ recall: async () => ({ total: 0, results: [], degraded: false, hint: '无匹配记忆。' }) })
    const tool = makeTool(store)
    const value = await tool.execute({ query: 'zzz' })
    expect(value.total).toBe(0)
    expect(value.results).toEqual([])
    expect(value.action).toBeUndefined()
  })

  it('embeddingEnabled=false ⇒ 只走关键词单路（queryVector=null 传给内核）', async () => {
    const recall = vi.fn(async () => ({ total: 0, results: [], degraded: true, hint: '降级检索。' }))
    const store = makeStore({ embeddingEnabled: false, recall })
    const tool = makeTool(store)
    const value = await tool.execute({ query: 'RRF' })
    expect(recall).toHaveBeenCalledExactlyOnceWith({ query: 'RRF', queryVector: null, limit: 5, layer: undefined })
    expect(value.degraded).toBe(true)
  })

  it('embedQuery 失败（返回 null 或抛错）⇒ 降级单路，绝不因网络错失败', async () => {
    const recall = vi.fn(async () => ({ total: 1, results: [HIT], degraded: true, hint: '降级检索。' }))
    const nullStore = makeStore({ embedQuery: async () => null, recall })
    const value = await makeTool(nullStore).execute({ query: 'RRF' })
    expect(recall).toHaveBeenCalledExactlyOnceWith({ query: 'RRF', queryVector: null, limit: 5, layer: undefined })
    expect(value.degraded).toBe(true)

    const throwingStore = makeStore({
      embedQuery: async () => {
        throw new Error('network down')
      },
      recall,
    })
    recall.mockClear()
    const degraded = await makeTool(throwingStore).execute({ query: 'RRF' })
    expect(recall).toHaveBeenCalledExactlyOnceWith({ query: 'RRF', queryVector: null, limit: 5, layer: undefined })
    expect(degraded.degraded).toBe(true)
  })

  it('limit 夹紧：缺省 5 / 0 → 1 / 99 → 20；layer 透传', async () => {
    const recall = vi.fn(async (_input: {
      query: string
      queryVector: readonly number[] | null
      limit: number
      layer?: string
    }) => ({ total: 0, results: [], degraded: false, hint: '无匹配记忆。' }))
    const store = makeStore({ recall })
    // 4 次调用会超出缺省配额 3——这里取大配额，只测 limit 夹紧。
    const tool = makeTool(store, createRecallTurnQuota(10))

    await tool.execute({ query: 'a' })
    expect(recall.mock.calls[0]?.[0].limit).toBe(5)

    await tool.execute({ query: 'a', limit: 0 })
    expect(recall.mock.calls[1]?.[0].limit).toBe(1)

    await tool.execute({ query: 'a', limit: 99 })
    expect(recall.mock.calls[2]?.[0].limit).toBe(20)

    await tool.execute({ query: 'a', limit: 3, layer: 'L1' })
    expect(recall.mock.calls[3]?.[0]).toMatchObject({ limit: 3, layer: 'L1' })
  })

  it('配额超限：第 4 次调用拒绝（recall_quota_exceeded，不抛异常），turn 边界重置后恢复', async () => {
    const quota = createRecallTurnQuota()
    const store = makeStore()
    const tool = makeTool(store, quota)
    const exec = execOf('session-quota')
    for (let i = 0; i < 3; i += 1) {
      const allowed = await tool.execute({ query: 'q' }, exec)
      expect(allowed.total).toBe(1)
    }
    const blocked = await tool.execute({ query: 'q' }, exec)
    expect(blocked.action).toBe('failed')
    expect(blocked.error).toMatchObject({ code: 'recall_quota_exceeded', retryable: false })
    expect(store.recall).toHaveBeenCalledTimes(3)

    // turn 边界重置（配额监听器在 index 接线；此处直接驱动同一配额对象的同一会话键）。
    quota.reset('session-quota')
    const after = await tool.execute({ query: 'q' }, exec)
    expect(after.total).toBe(1)
  })

  it('配额按会话键隔离：exec.agent.session 不同的调用各算各的（spec D7）', async () => {
    const quota = createRecallTurnQuota(1)
    const tool = makeTool(makeStore(), quota)
    const s1 = execOf('session-a')
    const s2 = execOf('session-b')
    expect((await tool.execute({ query: 'q' }, s1)).total).toBe(1)
    // s1 已用完；s2 完全不受影响。
    expect((await tool.execute({ query: 'q' }, s1)).action).toBe('failed')
    expect((await tool.execute({ query: 'q' }, s2)).total).toBe(1)
  })

  it('库未就绪：getRecallStore → undefined ⇒ db_unavailable（不抛异常）', async () => {
    const tool = makeTool(undefined)
    const value = await tool.execute({ query: 'q' })
    expect(value.action).toBe('failed')
    expect(value.error).toMatchObject({ code: 'db_unavailable', retryable: false })
    expect(value.error?.message).not.toMatch(/token/)
  })

  it('内核抛 MemoryDbError 透传 code；其它错误兜底 recall_failed（均不 throw）', async () => {
    const dbErrorStore = makeStore({
      recall: async () => {
        throw new MemoryDbError('db_backend_unavailable', '扩展未装载')
      },
    })
    const typed = await makeTool(dbErrorStore).execute({ query: 'q' })
    expect(typed.action).toBe('failed')
    expect(typed.error).toMatchObject({ code: 'db_backend_unavailable', message: '扩展未装载', retryable: false })

    const genericStore = makeStore({
      recall: async () => {
        throw new Error('driver exploded')
      },
    })
    const generic = await makeTool(genericStore).execute({ query: 'q' })
    expect(generic.action).toBe('failed')
    expect(generic.error).toMatchObject({ code: 'recall_failed', message: 'driver exploded', retryable: false })
  })
})

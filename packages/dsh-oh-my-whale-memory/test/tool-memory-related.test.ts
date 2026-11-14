/**
 * memory_related 工具契约测试（Story 3.2 / spec I/O 矩阵；假 store，0 开库）。
 *
 * 覆盖：输出/参数形态、成功形状（edge_type/reason/invalid 标记）、四类 hint
 * （未找到 / evidence expired / partial / 起点已失效）、失败信封（db_unavailable 不耗配额、
 * quota_exceeded、dp_read_failed）、空白 id 拒绝（不耗配额）、256-token 截断、不 throw。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import {
  RELATED_HINT_EVIDENCE_EXPIRED,
  RELATED_HINT_PARTIAL,
  RELATED_HINT_START_INVALID,
  RELATED_HINT_START_MISSING,
  MEMORY_RELATED_TOOL_NAME,
  createMemoryRelatedTool,
  type MemoryRelatedStore,
} from '../src/tools/memory-related'
import { createRecallTurnQuota } from '../src/tools/recall-quota'

interface CapturedEntry { id: string; layer: string; hops: number; edge_type: string; reason?: string; text: string; truncated?: boolean; invalid?: boolean; invalid_at?: string }

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
  execute: (args: { id: string; depth?: number }, exec?: unknown) => Promise<{
    id?: string
    depth?: number
    total?: number
    results?: CapturedEntry[]
    hint?: string
    partial?: boolean
    action?: 'failed'
    error?: { code: string; message: string; retryable: boolean }
  }>
}

const START_OK = { invalid: false, invalidAt: null, expiredAt: null }
const VALID_ITEM = {
  id: 'B',
  layer: 'L1',
  text: 'B 的内容',
  hops: 1,
  edgeType: 'RELATED' as const,
  reason: 'rel-a-b',
  invalid: false,
  invalidAt: null,
  expiredAt: null,
  pathValid: true,
}

function makeStore(overrides: Partial<MemoryRelatedStore> = {}): MemoryRelatedStore {
  return {
    traverse: vi.fn(async (input) => ({
      id: input.id,
      depth: input.depth ?? 2,
      startFound: true,
      start: START_OK,
      total: 1,
      results: [VALID_ITEM],
    })),
    ...overrides,
  }
}

function makeTool(store: MemoryRelatedStore | undefined, quota = createRecallTurnQuota()): CapturedTool {
  return createMemoryRelatedTool({ getRelatedStore: () => store, quota }) as unknown as CapturedTool
}

function execOf(sessionId: string): unknown {
  return { agent: { session: { id: sessionId } } }
}

describe('memory_related 工具形态', () => {
  const tool = makeTool(makeStore())

  it('名称 / 描述 / 参数规则（id 必填 string、depth 可选 integer）', () => {
    expect(tool.name).toBe(MEMORY_RELATED_TOOL_NAME)
    expect(tool.name).toBe('memory_related')
    expect(tool.description).toMatch(/EVIDENCE/)
    expect(tool.description).toMatch(/quota_exceeded/)

    expect(tool.parameters.properties.id?.type).toBe('string')
    expect(tool.parameters.required).toContain('id')
    expect(tool.parameters.properties.depth?.type).toBe('integer')
    expect(tool.parameters.required ?? []).not.toContain('depth')

    const branches = tool.output.schema.oneOf ?? []
    expect(branches).toHaveLength(2)
    expect(branches[1]?.properties?.action?.const).toBe('failed')
  })

  it('render：成功（含失效标记）/ 空结果 hint / 失败三分支，均不 throw', () => {
    const hit = tool.output.render({}, {
      id: 'A',
      depth: 2,
      total: 2,
      results: [
        { id: 'B', layer: 'L1', hops: 1, edge_type: 'EVIDENCE', text: '证据' },
        { id: 'C', layer: 'L1', hops: 2, edge_type: 'RELATED', text: '关联', invalid: true },
      ],
    })
    expect(hit[0]?.text).toContain('记忆关联（共 2 条，显示 2 条）')
    expect(hit[0]?.text).toContain('1跳 [EVIDENCE]')
    expect(hit[0]?.text).toContain('（已失效）')

    const empty = tool.output.render({}, { id: 'A', depth: 2, total: 0, results: [], hint: RELATED_HINT_EVIDENCE_EXPIRED })
    expect(empty[0]?.text).toBe(RELATED_HINT_EVIDENCE_EXPIRED)

    const failed = tool.output.render({}, {
      action: 'failed',
      error: { code: 'quota_exceeded', message: 'm', retryable: false },
    })
    expect(failed[0]?.text).toContain('quota_exceeded')
    expect(failed[0]?.text).toContain('retryable=false')
  })
})

describe('memory_related execute（假 store）', () => {
  it('成功：透传 {id, depth, total, results}，edge_type/reason/截断标记按需出现', async () => {
    const store = makeStore()
    const tool = makeTool(store)
    const value = await tool.execute({ id: 'A', depth: 2 }, execOf('s1'))

    expect(store.traverse).toHaveBeenCalledExactlyOnceWith({ id: 'A', depth: 2, timeoutMs: 300 })
    expect(value.id).toBe('A')
    expect(value.depth).toBe(2)
    expect(value.total).toBe(1)
    expect(value.results?.[0]).toMatchObject({ id: 'B', layer: 'L1', hops: 1, edge_type: 'RELATED', reason: 'rel-a-b' })
    expect(value.hint).toBeUndefined()
    expect(value.partial).toBeUndefined()
  })

  it('起点不存在 ⇒ 成功值空结果 + 未找到 hint（AC:882-884）', async () => {
    const store = makeStore({
      traverse: async () => ({ id: 'absent', depth: 2, startFound: false, start: START_OK, total: 0, results: [] }),
    })
    const value = await makeTool(store).execute({ id: 'absent' }, execOf('s-missing'))
    expect(value).toMatchObject({ total: 0, results: [], hint: RELATED_HINT_START_MISSING })
    expect(value.action).toBeUndefined()
  })

  it('邻居全无有效路径 ⇒ 空结果 + evidence expired（AC:889）', async () => {
    const store = makeStore({
      traverse: async () => ({
        id: 'A',
        depth: 2,
        startFound: true,
        start: START_OK,
        total: 1,
        results: [{ ...VALID_ITEM, invalid: true, invalidAt: '2026-03-01T00:00:00.000Z', pathValid: false }],
      }),
    })
    const value = await makeTool(store).execute({ id: 'A' }, execOf('s-expired'))
    expect(value).toMatchObject({ total: 0, results: [], hint: RELATED_HINT_EVIDENCE_EXPIRED })
  })

  it('起点自身失效 ⇒ 照常返回 + hint 说明（D5 ②）', async () => {
    const store = makeStore({
      traverse: async () => ({
        id: 'A',
        depth: 2,
        startFound: true,
        start: { invalid: true, invalidAt: '2026-03-01T00:00:00.000Z', expiredAt: null },
        total: 1,
        results: [VALID_ITEM],
      }),
    })
    const value = await makeTool(store).execute({ id: 'A' }, execOf('s-start-invalid'))
    expect(value.results).toHaveLength(1)
    expect(value.hint).toContain(RELATED_HINT_START_INVALID)
  })

  it('超时 ⇒ depth=1 重试成功给 partial + hint:partial（AC:891-893，独立预算）', async () => {
    const traverse = vi.fn()
      .mockRejectedValueOnce(new Error('budget'))
      .mockResolvedValueOnce({
        id: 'A',
        depth: 1,
        startFound: true,
        start: START_OK,
        total: 1,
        results: [{ ...VALID_ITEM, hops: 1 }],
      })
    // 注意：只有 RelatedTraversalTimeoutError 触发重试，故用真实错误类替换首个 rejection。
    const { RelatedTraversalTimeoutError } = await import('../src/db/edges')
    traverse.mockReset()
    traverse
      .mockRejectedValueOnce(new RelatedTraversalTimeoutError(300))
      .mockResolvedValueOnce({
        id: 'A',
        depth: 1,
        startFound: true,
        start: START_OK,
        total: 1,
        results: [{ ...VALID_ITEM, hops: 1 }],
      })
    const value = await makeTool(makeStore({ traverse })).execute({ id: 'A', depth: 3 }, execOf('s-partial'))

    expect(traverse.mock.calls[0]?.[0]).toMatchObject({ depth: 3, timeoutMs: 300 })
    expect(traverse.mock.calls[1]?.[0]).toMatchObject({ depth: 1, timeoutMs: 300 })
    expect(value).toMatchObject({ depth: 1, partial: true, hint: RELATED_HINT_PARTIAL })
  })

  it('超时且 depth=1 也无结果 ⇒ 失败信封 db_read_failed（不降级成空成功值）', async () => {
    const { RelatedTraversalTimeoutError } = await import('../src/db/edges')
    const traverse = vi.fn()
      .mockRejectedValueOnce(new RelatedTraversalTimeoutError(300))
      .mockResolvedValueOnce({ id: 'A', depth: 1, startFound: true, start: START_OK, total: 0, results: [] })
    const value = await makeTool(makeStore({ traverse })).execute({ id: 'A' }, execOf('s-timeout'))
    expect(value.action).toBe('failed')
    expect(value.error?.code).toBe('db_read_failed')
  })

  it('库未就绪 ⇒ db_unavailable 且不耗配额（随后可用满 3 次）', async () => {
    const quota = createRecallTurnQuota()
    const unavailable = makeTool(undefined, quota)
    for (let i = 0; i < 4; i += 1) {
      expect((await unavailable.execute({ id: 'A' }, execOf('s-db'))).error?.code).toBe('db_unavailable')
    }
    expect(quota.used('s-db')).toBe(0)

    const ready = makeTool(makeStore(), quota)
    for (let i = 0; i < 3; i += 1) expect((await ready.execute({ id: 'A' }, execOf('s-db'))).total).toBe(1)
  })

  it('配额：第 4 次拒绝 quota_exceeded；与 memory_recall 同桶（同一 RecallQuota 实例）', async () => {
    const quota = createRecallTurnQuota()
    const tool = makeTool(makeStore(), quota)
    const exec = execOf('s-quota')
    for (let i = 0; i < 3; i += 1) expect((await tool.execute({ id: 'A' }, exec)).total).toBe(1)
    const blocked = await tool.execute({ id: 'A' }, exec)
    expect(blocked.error).toMatchObject({ code: 'quota_exceeded', retryable: false })
  })

  it('空白 id ⇒ invalid_query（不耗配额、不遍历）', async () => {
    const quota = createRecallTurnQuota()
    const store = makeStore()
    const tool = makeTool(store, quota)
    const value = await tool.execute({ id: '   ' }, execOf('s-blank'))
    expect(value.error?.code).toBe('invalid_query')
    expect(store.traverse).not.toHaveBeenCalled()
    expect(quota.used('s-blank')).toBe(0)
  })

  it('256-token 截断：超长 text 截断为摘要 + truncated:true（复用 3.1 规则）', async () => {
    const store = makeStore({
      traverse: async () => ({
        id: 'A',
        depth: 1,
        startFound: true,
        start: START_OK,
        total: 1,
        results: [{ ...VALID_ITEM, text: 'x'.repeat(1200) }],
      }),
    })
    const value = await makeTool(store).execute({ id: 'A' }, execOf('s-trunc'))
    const entry = value.results?.[0]
    expect(entry?.truncated).toBe(true)
    expect(entry?.text.endsWith('…')).toBe(true)
    expect(entry?.text.length).toBeLessThan(1200)
  })

  it('内核抛错 ⇒ MemoryDbError 透传 code，其它兜底 db_read_failed，均不 throw', async () => {
    const dbError = makeStore({
      traverse: async () => {
        throw new MemoryDbError('db_backend_unavailable', '扩展未装载')
      },
    })
    const typed = await makeTool(dbError).execute({ id: 'A' }, execOf('s-err1'))
    expect(typed.error).toMatchObject({ code: 'db_backend_unavailable', message: '扩展未装载' })

    const generic = makeStore({
      traverse: async () => {
        throw new Error('driver exploded')
      },
    })
    const fallback = await makeTool(generic).execute({ id: 'A' }, execOf('s-err2'))
    expect(fallback.error).toMatchObject({ code: 'db_read_failed', message: 'driver exploded' })
  })
})

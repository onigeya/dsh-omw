/**
 * `/memory recall` 命令测试（Story 3.1 / 解析 + 渲染 + 错误收敛）。
 *
 * 命令层 dep 全部为假：断言传给 `recallMemories` 的参数（query + 默认 5 条）、
 * 钉死的渲染文案（id + layer + 摘要、degraded 标注）、无 query 的 usage error、
 * 无命中的正常 success、出错收敛为 `{ kind:'error' }`——均不抛异常。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_SUBCOMMAND,
  MEMORY_RECALL_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
} from '../src/command'
import { RECALL_DEFAULT_LIMIT } from '../src/recall/core'

function makeDeps(overrides: Partial<MemoryCommandDependencies> = {}): MemoryCommandDependencies {
  return {
    writeInbox: async () => {},
    listMemories: async () => [],
    getMemoryById: async () => null,
    getStatus: async () => ({
      layers: { L1: 0, L2: 0 },
      inboxes: { L1: 0, L2: 0 },
      failed: 0,
      embeddingMode: 'enabled',
      systemOne: 'enabled',
      unembedded: 0,
      readonly: false,
    }),
    recallMemories: async () => ({ total: 0, results: [], degraded: false, hint: '' }),
    ...overrides,
  }
}

const ENTRY = {
  id: 'id-rrf',
  layer: 'L2',
  kind: 'work_fact',
  priority: 0,
  text: 'RRF 融合只在应用层做',
}

describe('parseMemoryCommand（recall 分支）', () => {
  it("'recall <query>' → { kind:'recall', query }（trim 首尾、保留内部空白）", () => {
    expect(parseMemoryCommand(' recall RRF 融合')).toEqual({ kind: 'recall', query: 'RRF 融合' })
    expect(parseMemoryCommand('recall   RRF  融合  ')).toEqual({ kind: 'recall', query: 'RRF  融合' })
  })

  it("'recall' 缺 query → invalid + recall usage（矩阵行「命令无 query」）", () => {
    expect(parseMemoryCommand(' recall')).toEqual({ kind: 'invalid', usage: MEMORY_RECALL_USAGE })
    expect(parseMemoryCommand('recall   ')).toEqual({ kind: 'invalid', usage: MEMORY_RECALL_USAGE })
  })

  it('常量符合契约；总用法扩到五条子命令', () => {
    expect(MEMORY_RECALL_SUBCOMMAND).toBe('recall')
    // F-10：命令面缺省 limit **直接复用内核常量**（单一来源，不再两份字面量）；
    // 同时钉住它出现在 usage 文案里，改值不会漏改文案。
    expect(MEMORY_RECALL_DEFAULT_LIMIT).toBe(RECALL_DEFAULT_LIMIT)
    expect(MEMORY_RECALL_USAGE).toContain(`最多 ${RECALL_DEFAULT_LIMIT} 条`)
    expect(MEMORY_RECALL_USAGE).toContain('/memory recall <query>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory remember <内容>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory list [关键词]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory show <id>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory status')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory recall <query>')
  })
})

describe('handler：recall 的参数与渲染', () => {
  it('dep 收到 { query, limit: 5 }；命中按 RRF 顺序渲染 id + layer + 摘要', async () => {
    const recallMemories = vi.fn(async () => ({
      total: 7,
      results: [
        { ...ENTRY, id: 'id-2', layer: 'L1', text: '第二条' },
        ENTRY,
      ],
      degraded: false,
      hint: '混合检索',
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ recallMemories }))

    const result = await definition.handler({ rawInput: ' recall RRF' })

    expect(recallMemories).toHaveBeenCalledExactlyOnceWith({ query: 'RRF', limit: MEMORY_RECALL_DEFAULT_LIMIT })
    expect(result.kind).toBe('success')
    // F-07：首行报**截断前** total（7），并显示实际渲染条数（2）——不再把 5/2 条当总数。
    expect(result.text).toBe([
      '记忆召回（共 7 条，显示 2 条，按 RRF 排序）：',
      '- id-2 [L1] 第二条',
      '- id-rrf [L2] RRF 融合只在应用层做',
      '混合检索',
    ].join('\n'))
    expect(result.text).not.toContain('降级检索')
  })

  it('摘要按 60 code point 截断加 …', async () => {
    const recallMemories = vi.fn(async () => ({
      total: 1,
      results: [{ ...ENTRY, text: 'z'.repeat(61) }],
      degraded: false,
      hint: '',
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ recallMemories }))
    const result = await definition.handler({ rawInput: ' recall zzz' })
    expect(result.text).toBe([
      '记忆召回（共 1 条，显示 1 条，按 RRF 排序）：',
      `- id-rrf [L2] ${'z'.repeat(60)}…`,
    ].join('\n'))
  })

  it('降级检索：hint 由内核承载并原样展示（不再各拼文案）', async () => {
    const recallMemories = vi.fn(async () => ({
      total: 1,
      results: [ENTRY],
      degraded: true,
      hint: '降级检索：embedding 不可用，本次仅走关键词单路（语义向量路未参与）。',
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ recallMemories }))
    const result = await definition.handler({ rawInput: ' recall RRF' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('降级检索：embedding 不可用')
  })

  it("无命中 → success '无匹配记忆。'（矩阵行「命令命中为空」）", async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      recallMemories: async () => ({ total: 0, results: [], degraded: false, hint: '无匹配记忆。' }),
    }))
    const result = await definition.handler({ rawInput: ' recall 量子' })
    expect(result).toEqual({ kind: 'success', text: '无匹配记忆。' })
  })

  it('出错 → error 形态（矩阵行「命令出错」），不抛异常', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      recallMemories: async () => {
        throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆')
      },
    }))
    const result = await definition.handler({ rawInput: ' recall RRF' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
  })

  it('无 query → error 形态且正文是 usage（不静默忽略输入）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps())
    const result = await definition.handler({ rawInput: ' recall' })
    expect(result).toEqual({ kind: 'error', text: MEMORY_RECALL_USAGE })
  })
})

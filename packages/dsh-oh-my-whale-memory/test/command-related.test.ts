/**
 * `/memory related` 命令测试（Story 3.2 / 解析 + 渲染 + 错误收敛；假 deps，0 开库）。
 *
 * 覆盖：`related <id> [depth]` 解析（缺 id / 非整数 depth / 多余 token ⇒ usage）、
 * 渲染形态（首行共 N 条 + `- <id> <hops>跳 [<edge_type>] <摘要>` + 失效标记 + hint 末行）、
 * 空结果 hint、出错收敛为 `{ kind:'error' }`——均不抛异常；命令面**不计配额**（无 quota dep）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_RELATED_SUBCOMMAND,
  MEMORY_RELATED_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
} from '../src/command'

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
    relatedMemories: async () => ({ id: '', depth: 2, total: 0, results: [] }),
    ...overrides,
  }
}

const RESULT = {
  id: 'id-1',
  depth: 2,
  total: 3,
  results: [
    { id: 'id-2', layer: 'L1', hops: 1, edgeType: 'EVIDENCE' as const, reason: 'ev', text: '证据原文' },
    { id: 'id-3', layer: 'L1', hops: 2, edgeType: 'RELATED' as const, text: '关联原文', invalid: true, invalidAt: '2026-03-01T00:00:00.000Z' },
  ],
}

describe('parseMemoryCommand（related 分支）', () => {
  it("'related <id>' → { kind:'related', id }；带整数 depth → depth 透传", () => {
    expect(parseMemoryCommand(' related id-1')).toEqual({ kind: 'related', id: 'id-1' })
    expect(parseMemoryCommand('related   id-1   2  ')).toEqual({ kind: 'related', id: 'id-1', depth: 2 })
  })

  it("缺 id / depth 非正整数 / 多余 token → invalid + related usage", () => {
    expect(parseMemoryCommand(' related')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
    expect(parseMemoryCommand('related   ')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
    expect(parseMemoryCommand('related id-1 abc')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
    expect(parseMemoryCommand('related id-1 0')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
    expect(parseMemoryCommand('related id-1 -1')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
    expect(parseMemoryCommand('related id-1 2 extra')).toEqual({ kind: 'invalid', usage: MEMORY_RELATED_USAGE })
  })

  it('常量与总用法：六条子命令', () => {
    expect(MEMORY_RELATED_SUBCOMMAND).toBe('related')
    expect(MEMORY_RELATED_USAGE).toContain('/memory related <id> [depth]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory related <id> [depth]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory recall <query>')
  })
})

describe('handler：related 的 deps 调用与渲染', () => {
  it('deps 收到 { id } / { id, depth }；文本含首行共 N 条、hops、edge_type、摘要与失效标记', async () => {
    const relatedMemories = vi.fn(async () => RESULT)
    const definition = createMemoryCommandDefinition(makeDeps({ relatedMemories }))

    const withoutDepth = await definition.handler({ rawInput: ' related id-1' })
    expect(relatedMemories).toHaveBeenLastCalledWith({ id: 'id-1' })
    expect(withoutDepth.kind).toBe('success')
    expect(withoutDepth.text).toBe([
      '记忆关联（共 3 条，显示 2 条）：',
      '- id-2 1跳 [EVIDENCE] 证据原文',
      '- id-3 2跳 [RELATED] 关联原文（已失效）',
    ].join('\n'))

    const withDepth = await definition.handler({ rawInput: ' related id-1 3' })
    expect(relatedMemories).toHaveBeenLastCalledWith({ id: 'id-1', depth: 3 })
    expect(withDepth.kind).toBe('success')
  })

  it('hint 作为末行展示（partial / evidence expired）', async () => {
    const partial = createMemoryCommandDefinition(makeDeps({
      relatedMemories: async () => ({ ...RESULT, hint: 'partial', partial: true }),
    }))
    const partialResult = await partial.handler({ rawInput: ' related id-1' })
    expect(partialResult.text?.split('\n').at(-1)).toBe('partial')

    const expired = createMemoryCommandDefinition(makeDeps({
      relatedMemories: async () => ({ id: 'id-1', depth: 2, total: 0, results: [], hint: 'evidence expired' }),
    }))
    expect(await expired.handler({ rawInput: ' related id-1' })).toEqual({ kind: 'success', text: 'evidence expired' })
  })

  it('空结果且无 hint ⇒ 无匹配记忆（成功值）；缺 id ⇒ usage error', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      relatedMemories: async () => ({ id: 'id-1', depth: 2, total: 0, results: [] }),
    }))
    expect(await definition.handler({ rawInput: ' related id-1' })).toEqual({ kind: 'success', text: '无匹配记忆。' })
    expect(await definition.handler({ rawInput: ' related' })).toEqual({ kind: 'error', text: MEMORY_RELATED_USAGE })
  })

  it('deps 抛错 ⇒ error 形态（不抛异常）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      relatedMemories: async () => {
        throw new Error('记忆库未就绪')
      },
    }))
    const result = await definition.handler({ rawInput: ' related id-1' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
  })
})

/**
 * `/memory resolve` 命令层测试（Story 7.1 / 解析 + 渲染 + 错误收敛；假 deps，0 开库）。
 *
 * 覆盖 spec 矩阵行 4、5、6、7、8：
 * - 解析：合法两种旗标、旗标与 id 顺序无关、缺旗标/两旗标/未知旗标/多余 token ⇒ usage；
 * - 渲染：两种裁决文案逐字；
 * - 收敛：不存在 id ⇒ error 结果（不抛）、只读 ⇒ 只读文案、deps 抛错 ⇒ error 结果。
 *
 * 真实落库与计数递减由 `db-pending-decision.test.ts` 覆盖。
 */
import { describe, expect, it } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_RESOLVE_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
  type MemoryCommandResolveResult,
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
      auditGap: 0,
      evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
      relatedSkipped: 0,
    }),
    recallMemories: async () => ({ total: 0, results: [], degraded: false, hint: '' }),
    relatedMemories: async () => ({ id: '', depth: 2, total: 0, results: [] }),
    forgetMemory: async () => ({ id: 'id-1', alreadyExpired: false, affected: [] }),
    resolvePendingDecision: async () => ({ id: 'p-1', newMemoryId: 'm-1', action: 'supersede' }),
    ...overrides,
  }
}

const ACCEPT_RESULT: MemoryCommandResolveResult = { id: 'p-1', newMemoryId: 'm-new', action: 'supersede' }
const KEEP_RESULT: MemoryCommandResolveResult = { id: 'p-1', newMemoryId: 'm-new', action: 'merge' }

async function run(deps: MemoryCommandDependencies, rawInput: string): Promise<{ kind: string, text?: string }> {
  const definition = createMemoryCommandDefinition(deps)
  return definition.handler({ rawInput } as never) as Promise<{ kind: string, text?: string }>
}

describe('parseMemoryCommand（resolve 分支）', () => {
  it("' resolve <id> --accept' → { kind:'resolve', resolution:'accept' }", () => {
    expect(parseMemoryCommand(' resolve p-1 --accept')).toEqual({
      kind: 'resolve',
      id: 'p-1',
      resolution: 'accept',
    })
  })

  it("' resolve --keep <id>'：旗标与 id 顺序无关", () => {
    expect(parseMemoryCommand(' resolve --keep p-1')).toEqual({
      kind: 'resolve',
      id: 'p-1',
      resolution: 'keep',
    })
  })

  it('缺旗标 ⇒ usage（不静默默认成 accept）', () => {
    expect(parseMemoryCommand(' resolve p-1')).toEqual({ kind: 'invalid', usage: MEMORY_RESOLVE_USAGE })
  })

  it('两个旗标 / 未知旗标 / 缺 id / 多余 token ⇒ usage', () => {
    for (const input of [
      ' resolve p-1 --accept --keep',
      ' resolve p-1 --force',
      ' resolve --accept',
      ' resolve p-1 --accept extra',
    ]) {
      expect(parseMemoryCommand(input), input).toEqual({ kind: 'invalid', usage: MEMORY_RESOLVE_USAGE })
    }
  })

  it('未知子命令仍走总 usage（resolve 的加入没有放宽默认分支）', () => {
    expect(parseMemoryCommand(' nope')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
  })
})

describe('resolve 的渲染与错误收敛', () => {
  it('--accept 文案逐字：已接受新值（旧值作废）+ 新记忆 id', async () => {
    const result = await run(makeDeps({ resolvePendingDecision: async () => ACCEPT_RESULT }), ' resolve p-1 --accept')
    expect(result.kind).toBe('success')
    expect(result.text).toBe('已接受新值（旧值作废）：p-1\n- 新记忆：m-new')
  })

  it('--keep 文案逐字：已保留并存 + 新记忆 id', async () => {
    const result = await run(makeDeps({ resolvePendingDecision: async () => KEEP_RESULT }), ' resolve p-1 --keep')
    expect(result.kind).toBe('success')
    expect(result.text).toBe('已保留并存：p-1\n- 新记忆：m-new')
  })

  it('不存在的待裁决 id ⇒ error 结果（不抛），文案透传', async () => {
    const deps = makeDeps({
      resolvePendingDecision: async () => {
        throw new MemoryDbError('pending_decision_not_found', '未找到待裁决记录（id=p-x）')
      },
    })
    const result = await run(deps, ' resolve p-x --keep')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未找到待裁决记录（id=p-x）')
  })

  it('只读实例 ⇒ 只读文案（与 forget 同一句）；库未就绪 ⇒ error 结果', async () => {
    const readonly = await run(makeDeps({
      resolvePendingDecision: async () => {
        throw new MemoryDbError('readonly_mode', '记忆库处于只读模式（另一个实例正持有写锁）')
      },
    }), ' resolve p-1 --accept')
    expect(readonly.kind).toBe('error')
    expect(readonly.text).toContain('只读模式')

    const notReady = await run(makeDeps({
      resolvePendingDecision: async () => {
        throw new Error('记忆库尚未就绪')
      },
    }), ' resolve p-1 --accept')
    expect(notReady.kind).toBe('error')
    expect(notReady.text).toContain('记忆库尚未就绪')
  })
})

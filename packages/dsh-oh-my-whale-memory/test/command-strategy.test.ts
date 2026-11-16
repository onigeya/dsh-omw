/**
 * `/memory strategy` 命令层测试（Story 7.3 / AC:1498；假 deps，0 开库）。
 *
 * 覆盖：解析（无 payload 合法、带多余参数 ⇒ usage）、渲染（候选/过门/未过门/过期 + 配置三项）、
 * `evidence: none` 的显式提示、错误收敛（库未就绪 ⇒ error 结果而不抛）。
 */
import { describe, expect, it } from 'vitest'
import {
  MEMORY_STRATEGY_SUBCOMMAND,
  MEMORY_STRATEGY_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
  type MemoryCommandStrategyResult,
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
    getStrategyStats: async () => ({
      candidates: 0,
      pending: 0,
      adopted: 0,
      rejected: 0,
      expired: 0,
      noEvidence: 0,
      minConfidence: 0.6,
      expiryDays: 7,
      maxPendingPerSession: 5,
    }),
    ...overrides,
  }
}

const STATS: MemoryCommandStrategyResult = {
  candidates: 5,
  pending: 2,
  adopted: 1,
  rejected: 1,
  expired: 1,
  noEvidence: 1,
  minConfidence: 0.6,
  expiryDays: 7,
  maxPendingPerSession: 5,
}

async function run(deps: MemoryCommandDependencies, rawInput: string): Promise<{ kind: string, text?: string }> {
  const definition = createMemoryCommandDefinition(deps)
  return definition.handler({ rawInput } as never) as Promise<{ kind: string, text?: string }>
}

describe('parseMemoryCommand（strategy 分支）', () => {
  it("' strategy' / 'strategy' ⇒ { kind:'strategy' }", () => {
    expect(parseMemoryCommand(' strategy')).toEqual({ kind: 'strategy' })
    expect(parseMemoryCommand('strategy')).toEqual({ kind: 'strategy' })
  })

  it('带多余参数 ⇒ usage（不静默忽略）', () => {
    expect(parseMemoryCommand(' strategy x')).toEqual({ kind: 'invalid', usage: MEMORY_STRATEGY_USAGE })
  })

  it('子命令常量是 `strategy`（小写无斜杠，宿主约定）', () => {
    expect(MEMORY_STRATEGY_SUBCOMMAND).toBe('strategy')
  })
})

describe('strategy 渲染与错误收敛', () => {
  it('候选数 / 过门数 / 未过门数 + 配置三项逐字', async () => {
    const result = await run(makeDeps({ getStrategyStats: async () => STATS }), ' strategy')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('策略候选：5（pending 2 / 过门 1 / 未过门 1 / 过期 1）')
    expect(result.text).toContain('采纳门：minConfidence=0.6 expiryDays=7 maxPendingPerSession=5')
    // evidence: none 必须显式提示，不能看起来像「0 个失败」
    expect(result.text).toContain('无 case 集（evidence: none）')
  })

  it('无 evidence=none 时不打扰用户（不出现该提示）', async () => {
    const result = await run(makeDeps({
      getStrategyStats: async () => ({ ...STATS, noEvidence: 0 }),
    }), ' strategy')
    expect(result.text).not.toContain('evidence: none')
  })

  it('库未就绪 ⇒ error 结果（不抛）', async () => {
    const result = await run(makeDeps({
      getStrategyStats: async () => {
        throw new Error('记忆库尚未就绪')
      },
    }), ' strategy')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库尚未就绪')
  })
})

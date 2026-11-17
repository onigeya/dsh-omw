/**
 * `/memory status` 命令层测试（Story 1.9 / 解析 + 渲染 + 错误收敛）。
 *
 * 这里只测命令层：dep 全部是假的，因此能精确断言「钉死的输出格式」与
 * 「getStatus 的调用时机」。真实库上的层计数、空库、embedding 降级、只读标注与
 * 「不发起网络请求」由 command-status-db.test.ts 覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_LIST_SUBCOMMAND,
  MEMORY_REMEMBER_SUBCOMMAND,
  MEMORY_SHOW_SUBCOMMAND,
  MEMORY_STATUS_SUBCOMMAND,
  MEMORY_STATUS_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  renderMemoryStatus,
  type MemoryCommandDependencies,
  type MemoryHealthView,
  type MemoryStatusSnapshot,
} from '../src/command'

/** 五个 dep 都能被单测替换；未覆盖的 dep 给默认实现。 */
function makeDeps(overrides: Partial<MemoryCommandDependencies> = {}): MemoryCommandDependencies {
  return {
    writeInbox: async () => {},
    listMemories: async () => [],
    getMemoryById: async () => null,
    getStatus: async () => STATUS_BASE,
    recallMemories: async () => ({ total: 0, results: [], degraded: false, hint: '' }),
    relatedMemories: async () => ({ id: '', depth: 2, total: 0, results: [] }),
    forgetMemory: async () => ({ id: '', alreadyExpired: false, affected: [] }),
    ...overrides,
  }
}

const STATUS_BASE: MemoryStatusSnapshot = {
  layers: { L1: 2, L2: 1 },
  inboxes: { L1: 3, L2: 0 },
  failed: 0,
  embeddingMode: 'enabled',
  systemOne: 'enabled',
  unembedded: 0,
  readonly: false,
  auditGap: 0,
  evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
  relatedSkipped: 0,
}

describe('parseMemoryCommand（status 分支）', () => {
  it("' status' / 'status' / 带尾随空白 → {kind:'status'}（无 payload）", () => {
    expect(parseMemoryCommand(' status')).toEqual({ kind: 'status' })
    expect(parseMemoryCommand('status')).toEqual({ kind: 'status' })
    expect(parseMemoryCommand('   status   ')).toEqual({ kind: 'status' })
  })

  it("' status x' → invalid + MEMORY_STATUS_USAGE（矩阵行「status 带多余参数」）", () => {
    expect(parseMemoryCommand(' status x')).toEqual({ kind: 'invalid', usage: MEMORY_STATUS_USAGE })
    expect(parseMemoryCommand('status   x   ')).toEqual({ kind: 'invalid', usage: MEMORY_STATUS_USAGE })
  })

  it('未知子命令仍是总 usage（不因新增 status 而放宽）', () => {
    expect(parseMemoryCommand(' foo')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
    expect(parseMemoryCommand(' Status')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
  })

  it('子命令常量与总 usage 符合契约', () => {
    expect(MEMORY_STATUS_SUBCOMMAND).toBe('status')
    expect(MEMORY_STATUS_USAGE).toBe('/memory status')
    // 总 usage 必须同时给出四个子命令（Story 1.9）。
    expect(MEMORY_COMMAND_USAGE).toContain('/memory remember <内容>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory list [关键词]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory show <id>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory status')
  })

  it('既有子命令常量未因本次改动被覆盖', () => {
    expect(MEMORY_REMEMBER_SUBCOMMAND).toBe('remember')
    expect(MEMORY_LIST_SUBCOMMAND).toBe('list')
    expect(MEMORY_SHOW_SUBCOMMAND).toBe('show')
  })
})

describe('renderMemoryStatus（spec「输出格式钉死」）', () => {
  it('enabled × 非只读：逐行钉死，计数为十进制，非降级态也显式打印', () => {
    expect(renderMemoryStatus(STATUS_BASE)).toBe([
      '记忆状态',
      'L1: 2',
      'L2: 1',
      'L1_INBOX: 3',
      'L2_INBOX: 0',
      'failed: 0',
      'audit_gap: 0',
      'embedding: enabled',
      'systemOne: enabled',
      'readonly: false',
      // Story 3.3 / B4：注入状态恒打印一行（夹具未注入，未知）。
      'injection: 未知（本实例尚未触发开局注入）',
    ].join('\n'))
  })

  it('disabled × 非只读：显式标注「降级检索」', () => {
    const text = renderMemoryStatus({ ...STATUS_BASE, embeddingMode: 'disabled' })
    expect(text).toContain('embedding: disabled（降级检索）')
    expect(text).toContain('readonly: false')
    expect(text).not.toContain('embedding: enabled')
  })

  it('Story 4.1 / D-B：audit_gap 是 keyed + 边侧三集的合计；任一算不出来即「未知」', () => {
    // 两集都可算 ⇒ 合计（AD-21:300 的三集合并口径）。
    expect(renderMemoryStatus({
      ...STATUS_BASE,
      auditGap: 2,
      evidenceGap: { total: 3, eiiViolations: 2, drift: 1 },
    })).toContain('audit_gap: 5')
    // 审计表缺失 ⇒ 未知（不再只报 keyed 口径）。
    const missingAudit = renderMemoryStatus({ ...STATUS_BASE, auditGap: null })
    expect(missingAudit).toContain('audit_gap: 未知（审计表或边表缺失）')
    expect(missingAudit).not.toContain('audit_gap: 0')
    // 边表缺失（null）同样算不出来。
    const missingEdge = renderMemoryStatus({ ...STATUS_BASE, evidenceGap: null })
    expect(missingEdge).toContain('audit_gap: 未知（审计表或边表缺失）')
  })

  it('enabled × 只读：原因逐字渲染', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      readonly: true,
      readonlyReason: 'another instance owns the writer lock',
    })
    expect(text).toContain("readonly: true, reason: 'another instance owns the writer lock'")
    expect(text).toContain('embedding: enabled')
  })

  it('Story 2.4 / U5：enabled 且存在未嵌入节点时，embedding 行追加条数（0 时逐字不变）', () => {
    const zero = renderMemoryStatus({ ...STATUS_BASE, unembedded: 0 })
    expect(zero).toContain('embedding: enabled')
    expect(zero).not.toContain('未嵌入')

    const some = renderMemoryStatus({ ...STATUS_BASE, unembedded: 7 })
    expect(some).toContain('embedding: enabled（未嵌入 7 条）')

    // disabled 行逐字固定：即便有未嵌入节点也不渲染计数（回填不可用，数字无意义）。
    const disabled = renderMemoryStatus({ ...STATUS_BASE, embeddingMode: 'disabled', unembedded: 7 })
    expect(disabled).toContain('embedding: disabled（降级检索）')
    expect(disabled).not.toContain('未嵌入')
  })
  it('Story 2.6 / D7：evidence_gap 仅 total>0 时追加，null（边表缺失）渲染成未知', () => {
    const zero = renderMemoryStatus({ ...STATUS_BASE, evidenceGap: { total: 0, eiiViolations: 0, drift: 0 } })
    expect(zero).not.toContain('evidence_gap')
    const some = renderMemoryStatus({ ...STATUS_BASE, evidenceGap: { total: 3, eiiViolations: 2, drift: 1 } })
    expect(some).toContain('evidence_gap: 3（EII 2 / 漂移 1）')
    const missing = renderMemoryStatus({ ...STATUS_BASE, evidenceGap: null })
    expect(missing).toContain('evidence_gap: 未知（边表缺失）')
    expect(missing).not.toContain('evidence_gap: 0')
  })

  it('Story 2.6 / AD-21：related_skipped 仅 > 0 时追加，null 渲染成未知', () => {
    expect(renderMemoryStatus({ ...STATUS_BASE, relatedSkipped: 0 })).not.toContain('related_skipped')
    expect(renderMemoryStatus({ ...STATUS_BASE, relatedSkipped: 4 })).toContain('related_skipped: 4')
    expect(renderMemoryStatus({ ...STATUS_BASE, relatedSkipped: null })).toContain('related_skipped: 未知（审计表缺失）')
  })

  it('Story 2.5 / 评审 P7（T7）：systemOne 三态逐字渲染（degraded 是运行态的独立一行）', () => {
    expect(renderMemoryStatus({ ...STATUS_BASE, systemOne: 'enabled' })).toContain('systemOne: enabled')
    const degraded = renderMemoryStatus({ ...STATUS_BASE, systemOne: 'degraded' })
    expect(degraded).toContain('systemOne: degraded（已降级回 ctx.llm）')
    expect(degraded).not.toContain('systemOne: enabled')
    const off = renderMemoryStatus({ ...STATUS_BASE, systemOne: 'disabled-by-config' })
    expect(off).toContain('systemOne: disabled-by-config（已降级回 ctx.llm）')
    expect(off).not.toContain('systemOne: enabled')
  })

  it('Story 2.5 / 评审 P8（T8+T27）：l2_failed 与 uncertain 仅 >0 时追加，null 渲染成未知', () => {
    // 0 / 未给：既有快照逐字不变（两条行都不出现）。
    const zero = renderMemoryStatus({ ...STATUS_BASE, l2Failed: 0, uncertain: 0 })
    expect(zero).not.toContain('l2_failed')
    expect(zero).not.toContain('uncertain')
    // N>0：两条行出现（L2 死信与疑似失效账目各有出口，T8/T27）。
    const some = renderMemoryStatus({ ...STATUS_BASE, l2Failed: 2, uncertain: 5 })
    expect(some).toContain('l2_failed: 2')
    expect(some).toContain('uncertain: 5')
    // 审计表缺失：照 2.6 的 null 范式渲染「未知」，不静默报 0。
    const missing = renderMemoryStatus({ ...STATUS_BASE, uncertain: null })
    expect(missing).toContain('uncertain: 未知（审计表缺失）')
    expect(missing).not.toContain('uncertain: 0')
  })

  it('Story 2.5 / 评审 P8：l2_failed > 0 时附最近条目明细（值过 renderSingleLine）', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      l2Failed: 1,
      l2FailedEntries: [{ id: 'l2-x', kind: 'l2-promotion', attempts: 4, updatedAt: '2026-11-11T00:00:01.000Z', lastError: 'boom', stale: false }],
    })
    expect(text).toContain('l2_failed: 1')
    expect(text).toContain('l2_failed 最近条目:')
    expect(text).toContain('l2-x')
  })

  it('disabled × 只读：两种降级同时可见', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      embeddingMode: 'disabled',
      unembedded: 0,
      readonly: true,
      readonlyReason: 'another instance owns the writer lock',
    })
    expect(text.split('\n')).toEqual([
      '记忆状态',
      'L1: 2',
      'L2: 1',
      'L1_INBOX: 3',
      'L2_INBOX: 0',
      'failed: 0',
      'audit_gap: 0',
      'embedding: disabled（降级检索）',
      'systemOne: enabled',
      "readonly: true, reason: 'another instance owns the writer lock'",
      'injection: 未知（本实例尚未触发开局注入）',
    ])
  })
})

describe('renderMemoryStatus：开局注入两行（Story 3.3 / B4）', () => {
  const INJECTION = {
    sessionKey: 'session-1',
    items: 3,
    tokens: 1200,
    degraded: false,
    truncated: false,
    overBudget: false,
    keptInviolable: 0,
    unit: 'tokens' as const,
    elapsedMs: 12,
    at: '2026-11-14T00:00:00.000Z',
  }

  it('已注入：显式标注「预算单位=tokens」+ 条数/tokens；无降级/截断后缀', () => {
    const text = renderMemoryStatus({ ...STATUS_BASE, injection: INJECTION, injectionEnabled: true })
    expect(text).toContain('injection: enabled（预算单位=tokens；上次注入 3 条 / 1200 tokens）')
    expect(text).not.toContain('injection: 预算超限')
  })

  it('降级+截断后缀；overBudget 追加「预算超限（不可删集合先保留）」末行', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      injection: { ...INJECTION, degraded: true, truncated: true, overBudget: true, keptInviolable: 1 },
      injectionEnabled: true,
    })
    expect(text).toContain('injection: enabled（预算单位=tokens；上次注入 3 条 / 1200 tokens，降级，已截断）')
    expect(text.split('\n').at(-1)).toBe('injection: 预算超限（不可删集合先保留）')
  })

  it('Config 关闭：打印 disabled 行（即使有 lastInjection 也不显示 enabled）', () => {
    const text = renderMemoryStatus({ ...STATUS_BASE, injection: INJECTION, injectionEnabled: false })
    expect(text).toContain('injection: disabled（Config injectOnNewSession=false）')
    expect(text).not.toContain('injection: enabled')
  })

  it('从未注入：null 与缺省都渲染「未知」（不静默报 0）', () => {
    expect(renderMemoryStatus({ ...STATUS_BASE, injection: null, injectionEnabled: true }))
      .toContain('injection: 未知（本实例尚未触发开局注入）')
    expect(renderMemoryStatus(STATUS_BASE)).toContain('injection: 未知（本实例尚未触发开局注入）')
  })
})

describe('createMemoryCommandDefinition（status 分支）', () => {
  it('description / hint 必须同时反映四个子命令，否则文案回归无人发现', () => {
    const definition = createMemoryCommandDefinition(makeDeps())
    expect(definition.description).toContain('remember')
    expect(definition.description).toContain('list')
    expect(definition.description).toContain('show')
    expect(definition.description).toContain('status')
    expect(definition.input?.hint).toContain('/memory remember')
    expect(definition.input?.hint).toContain('list [关键词]')
    expect(definition.input?.hint).toContain('show <id>')
    expect(definition.input?.hint).toContain('status')
  })

  it('无参数：getStatus 被调用一次，正文即 renderMemoryStatus 输出', async () => {
    const getStatus = vi.fn(async () => STATUS_BASE)
    const definition = createMemoryCommandDefinition(makeDeps({ getStatus }))

    const result = await definition.handler({ rawInput: ' status' })

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe('success')
    expect(result.text).toBe(renderMemoryStatus(STATUS_BASE))
  })

  it('带多余参数：返回 MEMORY_STATUS_USAGE，不查库（usage 错误先于读依赖）', async () => {
    const getStatus = vi.fn(async () => STATUS_BASE)
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryCommandDefinition(makeDeps({ getStatus, writeInbox }))

    const result = await definition.handler({ rawInput: ' status x' })

    expect(result).toEqual({ kind: 'error', text: MEMORY_STATUS_USAGE })
    expect(getStatus).not.toHaveBeenCalled()
    expect(writeInbox).not.toHaveBeenCalled()
  })

  it('getStatus 抛 Error → 收敛为 error 结果而非抛出（库未就绪文案透传）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      getStatus: async () => {
        throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆')
      },
    }))

    const result = await definition.handler({ rawInput: ' status' })

    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
    expect(result.text).not.toContain('L1: 0')
  })

  it('getStatus 抛非 Error 值也收敛为 error 结果', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      getStatus: async () => { throw 'plain-string-failure' },
    }))

    const result = await definition.handler({ rawInput: ' status' })

    expect(result).toEqual({ kind: 'error', text: 'plain-string-failure' })
  })
})

describe('Story 4.3：健康五行（T2 / 矩阵行 2/3/11）', () => {
  it('health 缺省 ⇒ 一行都不追加（既有钉死块逐字不变）', () => {
    const withoutHealth = renderMemoryStatus(STATUS_BASE)
    expect(withoutHealth).not.toContain('inbox_backlog')
    expect(withoutHealth).not.toContain('last_refine_at')
    expect(withoutHealth).not.toContain('rerank_latency')
    expect(withoutHealth.split('\n').at(-1)).toBe('injection: 未知（本实例尚未触发开局注入）')
  })

  it('有 health ⇒ 五行追加在 injection 之后，顺序固定（pending_conflicts 现为真实行）', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      health: {
        inboxBacklog: { status: 'ok', value: { l1Ms: 90_000, l2Ms: 30_000 } },
        lastRefineAt: { status: 'ok', value: '2026-11-01T00:30:00.000Z' },
      },
      // Story 7.1：pending_conflicts 从占位变成真实数据；无待裁决时渲染 0。
      pendingConflicts: 0,
    })
    const lines = text.split('\n')
    const tail = lines.slice(-5)
    expect(tail).toEqual([
      'inbox_backlog: 90s（L1 90s / L2 30s）',
      'last_refine_at: 2026-11-01T00:30:00.000Z',
      'rerank_latency: n/a (v1 无精排)',
      'pending_conflicts: 0',
      'strategy_gate: n/a（Epic 7 真源在 Story 7.3）',
    ])
    // 既有行（injection 之前）逐字不变。
    expect(lines.slice(0, -5).join('\n')).toBe(renderMemoryStatus(STATUS_BASE))
  })

  it('单队列积压：另一队列渲染 n/a（无积压），整行取较大者', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      health: {
        inboxBacklog: { status: 'ok', value: { l1Ms: 90_000, l2Ms: null } },
        lastRefineAt: { status: 'none' },
      },
    })
    expect(text).toContain('inbox_backlog: 90s（L1 90s / L2 n/a（无积压））')
    expect(text).toContain('last_refine_at: n/a（从未完成精炼）')
  })

  it('三态文案固定：无积压 / 表缺失 / 采集失败 / 超预算', () => {
    const withMetric = (health: MemoryHealthView): string => renderMemoryStatus({ ...STATUS_BASE, health })
    expect(withMetric({
      inboxBacklog: { status: 'none' },
      lastRefineAt: { status: 'none' },
    })).toContain('inbox_backlog: n/a（无积压）')
    expect(withMetric({
      inboxBacklog: { status: 'missing-table' },
      lastRefineAt: { status: 'missing-table' },
    })).toContain('inbox_backlog: n/a（队列表缺失）')
    expect(withMetric({
      inboxBacklog: { status: 'failed' },
      lastRefineAt: { status: 'failed' },
    })).toContain('last_refine_at: n/a（采集失败）')
    expect(withMetric({
      inboxBacklog: { status: 'budget' },
      lastRefineAt: { status: 'budget' },
    })).toContain('last_refine_at: n/a（超出 10s 观测预算）')
  })

  it('积压 0 秒是 `0s` 而不是 n/a（有积压与无积压必须可区分）', () => {
    const text = renderMemoryStatus({
      ...STATUS_BASE,
      health: {
        inboxBacklog: { status: 'ok', value: { l1Ms: 0, l2Ms: null } },
        lastRefineAt: { status: 'none' },
      },
    })
    expect(text).toContain('inbox_backlog: 0s（L1 0s / L2 n/a（无积压））')
    expect(text).not.toContain('inbox_backlog: n/a（无积压）')
  })
})

describe('Story 5.1 / AC:1171：存储后端行（backend）', () => {
  it('缺省（undefined）时不追加任何行——既有逐行输出逐字不变', () => {
    const withoutBackend = renderMemoryStatus({ ...STATUS_BASE, health: undefined })
    expect(withoutBackend.split('\n').some((line) => line.startsWith('backend:'))).toBe(false)
  })

  it('native / wasm 各渲染一行，且位置在末尾', () => {
    const native = renderMemoryStatus({ ...STATUS_BASE, backend: 'native' })
    expect(native.split('\n').at(-1)).toBe('backend: native')
    const wasm = renderMemoryStatus({ ...STATUS_BASE, backend: 'wasm' })
    expect(wasm.split('\n').at(-1)).toBe('backend: wasm')
  })
})


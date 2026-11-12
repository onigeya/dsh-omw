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
  type MemoryStatusSnapshot,
} from '../src/command'

/** 四个 dep 都能被单测替换；未覆盖的 dep 给默认实现。 */
function makeDeps(overrides: Partial<MemoryCommandDependencies> = {}): MemoryCommandDependencies {
  return {
    writeInbox: async () => {},
    listMemories: async () => [],
    getMemoryById: async () => null,
    getStatus: async () => STATUS_BASE,
    ...overrides,
  }
}

const STATUS_BASE: MemoryStatusSnapshot = {
  layers: { L1: 2, L2: 1 },
  inboxes: { L1: 3, L2: 0 },
  failed: 0,
  embeddingMode: 'enabled',
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
      'readonly: false',
    ].join('\n'))
  })

  it('disabled × 非只读：显式标注「降级检索」', () => {
    const text = renderMemoryStatus({ ...STATUS_BASE, embeddingMode: 'disabled' })
    expect(text).toContain('embedding: disabled（降级检索）')
    expect(text).toContain('readonly: false')
    expect(text).not.toContain('embedding: enabled')
  })

  it('audit_gap 未知（审计表缺失）：显式标注而不是印 0', () => {
    const text = renderMemoryStatus({ ...STATUS_BASE, auditGap: null })
    expect(text).toContain('audit_gap: 未知（审计表缺失）')
    expect(text).not.toContain('audit_gap: 0')
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
      "readonly: true, reason: 'another instance owns the writer lock'",
    ])
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

/**
 * `/memory remember` 解析与 handler 分支测试（Story 1.7 / AC2、AC3、AC4 的库外部分）。
 *
 * 覆盖：`parseMemoryCommand` 的 `remember` 分支（带/不带前导空白、无 payload、空输入、
 * 未知子命令），以及 handler 的 success / usage-error / writeInbox 抛错转 error
 * 三条路径。命令定义是纯工厂，不依赖宿主 ctx 与真实库；落库事实由
 * command-remember-db.test.ts 覆盖，`list` / `show` 分支由 command-list-show.test.ts 覆盖。
 *
 * Story 1.8：工厂改名 `createMemoryCommandDefinition` 并收 3 个 dep；
 * `invalid` 结果携带对应 usage（remember 缺内容仍是 `MEMORY_REMEMBER_USAGE`）。
 * Story 1.9：dep 增至 4 个（新增 `getStatus`），子命令增至 4 个（新增 `status`）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_NAME,
  MEMORY_COMMAND_USAGE,
  MEMORY_REMEMBER_SUBCOMMAND,
  MEMORY_REMEMBER_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
} from '../src/command'

/** 四个 dep 都能被单测替换；未覆盖的读 dep 给默认空实现。 */
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
      readonly: false,
    }),
    ...overrides,
  }
}

describe('parseMemoryCommand（remember 分支）', () => {
  it("接受带前导空白的 ' remember X'（rawInput 含宿主分隔空白）", () => {
    expect(parseMemoryCommand(' remember 我偏好 ESM 不要 CJS'))
      .toEqual({ kind: 'remember', text: '我偏好 ESM 不要 CJS' })
  })

  it("接受不带前导空白的 'remember X'", () => {
    expect(parseMemoryCommand('remember 我偏好 ESM 不要 CJS'))
      .toEqual({ kind: 'remember', text: '我偏好 ESM 不要 CJS' })
  })

  it('去掉 payload 首尾空白但保留内部空白', () => {
    expect(parseMemoryCommand('   remember    a   b   c   '))
      .toEqual({ kind: 'remember', text: 'a   b   c' })
  })

  it("'remember' 无 payload → invalid + remember usage（AC2）", () => {
    expect(parseMemoryCommand(' remember')).toEqual({ kind: 'invalid', usage: MEMORY_REMEMBER_USAGE })
    expect(parseMemoryCommand('remember')).toEqual({ kind: 'invalid', usage: MEMORY_REMEMBER_USAGE })
    expect(parseMemoryCommand(' remember   ')).toEqual({ kind: 'invalid', usage: MEMORY_REMEMBER_USAGE })
  })

  it('空 rawInput / 仅空白 → invalid + 总 usage（无子命令）', () => {
    expect(parseMemoryCommand('')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
    expect(parseMemoryCommand('   \t\n ')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
  })

  it("' status' 不再是未知子命令（Story 1.9 起是真子命令）；' bogus' 仍是总 usage（AC3）", () => {
    expect(parseMemoryCommand(' status')).toEqual({ kind: 'status' })
    expect(parseMemoryCommand(' bogus')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
  })

  it('子命令大小写敏感：REMEMBER 不算 remember', () => {
    expect(parseMemoryCommand(' Remember x')).toEqual({ kind: 'invalid', usage: MEMORY_COMMAND_USAGE })
  })

  it('子命令常量与命令名符合契约', () => {
    expect(MEMORY_COMMAND_NAME).toBe('memory')
    expect(MEMORY_REMEMBER_SUBCOMMAND).toBe('remember')
    expect(MEMORY_REMEMBER_USAGE).toContain('/memory remember <内容>')
    // 总 usage 必须同时给出四个子命令（Story 1.9 起含 status）。
    expect(MEMORY_COMMAND_USAGE).toContain('/memory remember <内容>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory list [关键词]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory show <id>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory status')
  })
})

describe('createMemoryCommandDefinition（remember 分支）', () => {
  it('定义名为 memory，且带 description / input hint（宿主发现契约）', () => {
    const definition = createMemoryCommandDefinition(makeDeps())
    expect(definition.name).toBe('memory')
    expect(typeof definition.description).toBe('string')
    expect(definition.description.length).toBeGreaterThan(0)
    // Story 1.8 / 1.9：description / hint 必须同时反映四个子命令，否则文案回归无人发现。
    expect(definition.description).toContain('remember')
    expect(definition.description).toContain('list')
    expect(definition.description).toContain('show')
    expect(definition.description).toContain('status')
    expect(definition.input?.hint).toContain('/memory remember')
    expect(definition.input?.hint).toContain('list [关键词]')
    expect(definition.input?.hint).toContain('show <id>')
    expect(definition.input?.hint).toContain('status')
  })

  it('有效输入：writeInbox 收到 payload，返回 success', async () => {
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryCommandDefinition(makeDeps({ writeInbox }))

    const result = await definition.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    expect(writeInbox).toHaveBeenCalledExactlyOnceWith('我偏好 ESM 不要 CJS')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('我偏好 ESM 不要 CJS')
  })

  it('无 payload：返回 usage error，不写库（AC2）', async () => {
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryCommandDefinition(makeDeps({ writeInbox }))

    const result = await definition.handler({ rawInput: ' remember' })
    expect(writeInbox).not.toHaveBeenCalled()
    expect(result.kind).toBe('error')
    expect(result.text).toContain('memory remember')
  })

  it('status 走正常路径：调 getStatus 渲染状态，不写库（Story 1.9 改契约，不再 usage error）', async () => {
    const writeInbox = vi.fn(async () => {})
    const getStatus = vi.fn(async () => ({
      layers: { L1: 2, L2: 1 },
      inboxes: { L1: 3, L2: 0 },
      failed: 0,
      embeddingMode: 'enabled' as const,
      readonly: false,
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ writeInbox, getStatus }))

    const result = await definition.handler({ rawInput: ' status' })

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(writeInbox).not.toHaveBeenCalled()
    expect(result.kind).toBe('success')
    expect(result.text).toBe([
      '记忆状态',
      'L1: 2',
      'L2: 1',
      'L1_INBOX: 3',
      'L2_INBOX: 0',
      'failed: 0',
      'embedding: enabled',
      'readonly: false',
    ].join('\n'))
  })

  it('writeInbox 抛错 → 收敛为 error 结果而非抛出（AC4）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      writeInbox: async () => { throw new Error('库写入失败：disk full') },
    }))

    await expect(definition.handler({ rawInput: ' remember x' }))
      .resolves.toEqual({ kind: 'error', text: '库写入失败：disk full' })
  })

  it('writeInbox 抛非 Error 值也收敛为 error 结果', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      writeInbox: async () => { throw 'plain-string-failure' },
    }))

    const result = await definition.handler({ rawInput: ' remember x' })
    expect(result).toEqual({ kind: 'error', text: 'plain-string-failure' })
  })

  it('MemoryDbError(empty_fingerprint_text) 被收敛为 error（AC4）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      writeInbox: async () => { throw new Error('记忆文本归一化后为空（只含标点或空白），拒绝建节点') },
    }))

    const result = await definition.handler({ rawInput: ' remember ！！！' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('归一化后为空')
  })
})

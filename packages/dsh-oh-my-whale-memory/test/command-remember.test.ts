/**
 * `/memory remember` 解析与 handler 分支测试（Story 1.7 / AC2、AC3、AC4 的库外部分）。
 *
 * 覆盖：`parseRememberInput` 的各分支（带/不带前导空白、无 payload、空输入、
 * 未知子命令），以及 handler 的 success / usage-error / writeInbox 抛错转 error
 * 三条路径。命令定义是纯工厂，不依赖宿主 ctx 与真实库；落库事实由
 * command-remember-db.test.ts 覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_NAME,
  MEMORY_REMEMBER_SUBCOMMAND,
  MEMORY_REMEMBER_USAGE,
  createMemoryRememberDefinition,
  parseRememberInput,
} from '../src/command'

describe('parseRememberInput', () => {
  it("接受带前导空白的 ' remember X'（rawInput 含宿主分隔空白）", () => {
    expect(parseRememberInput(' remember 我偏好 ESM 不要 CJS'))
      .toEqual({ kind: 'remember', text: '我偏好 ESM 不要 CJS' })
  })

  it("接受不带前导空白的 'remember X'", () => {
    expect(parseRememberInput('remember 我偏好 ESM 不要 CJS'))
      .toEqual({ kind: 'remember', text: '我偏好 ESM 不要 CJS' })
  })

  it('去掉 payload 首尾空白但保留内部空白', () => {
    expect(parseRememberInput('   remember    a   b   c   '))
      .toEqual({ kind: 'remember', text: 'a   b   c' })
  })

  it("'remember' 无 payload → invalid（AC2）", () => {
    expect(parseRememberInput(' remember')).toEqual({ kind: 'invalid' })
    expect(parseRememberInput('remember')).toEqual({ kind: 'invalid' })
    expect(parseRememberInput(' remember   ')).toEqual({ kind: 'invalid' })
  })

  it('空 rawInput / 仅空白 → invalid（无子命令）', () => {
    expect(parseRememberInput('')).toEqual({ kind: 'invalid' })
    expect(parseRememberInput('   \t\n ')).toEqual({ kind: 'invalid' })
  })

  it("未知子命令 'status' → invalid（AC3）", () => {
    expect(parseRememberInput(' status')).toEqual({ kind: 'invalid' })
  })

  it('子命令大小写敏感：REMEMBER 不算 remember', () => {
    expect(parseRememberInput(' Remember x')).toEqual({ kind: 'invalid' })
  })

  it('子命令常量与命令名符合契约', () => {
    expect(MEMORY_COMMAND_NAME).toBe('memory')
    expect(MEMORY_REMEMBER_SUBCOMMAND).toBe('remember')
    expect(MEMORY_REMEMBER_USAGE).toContain('/memory remember <内容>')
  })
})

describe('createMemoryRememberDefinition', () => {
  it('定义名为 memory，且带 description / input hint（宿主发现契约）', () => {
    const definition = createMemoryRememberDefinition({ writeInbox: async () => {} })
    expect(definition.name).toBe('memory')
    expect(typeof definition.description).toBe('string')
    expect(definition.description.length).toBeGreaterThan(0)
    expect(definition.input?.hint).toContain('/memory remember')
  })

  it('有效输入：writeInbox 收到 payload，返回 success', async () => {
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryRememberDefinition({ writeInbox })

    const result = await definition.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    expect(writeInbox).toHaveBeenCalledExactlyOnceWith('我偏好 ESM 不要 CJS')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('我偏好 ESM 不要 CJS')
  })

  it('无 payload：返回 usage error，不写库（AC2）', async () => {
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryRememberDefinition({ writeInbox })

    const result = await definition.handler({ rawInput: ' remember' })
    expect(writeInbox).not.toHaveBeenCalled()
    expect(result.kind).toBe('error')
    expect(result.text).toContain('memory remember')
  })

  it('未知子命令：返回 usage error，不写库（AC3）', async () => {
    const writeInbox = vi.fn(async () => {})
    const definition = createMemoryRememberDefinition({ writeInbox })

    const result = await definition.handler({ rawInput: ' status' })
    expect(writeInbox).not.toHaveBeenCalled()
    expect(result.kind).toBe('error')
    expect(result.text).toContain('memory remember')
  })

  it('writeInbox 抛错 → 收敛为 error 结果而非抛出（AC4）', async () => {
    const definition = createMemoryRememberDefinition({
      writeInbox: async () => { throw new Error('库写入失败：disk full') },
    })

    await expect(definition.handler({ rawInput: ' remember x' }))
      .resolves.toEqual({ kind: 'error', text: '库写入失败：disk full' })
  })

  it('writeInbox 抛非 Error 值也收敛为 error 结果', async () => {
    const definition = createMemoryRememberDefinition({
      writeInbox: async () => { throw 'plain-string-failure' },
    })

    const result = await definition.handler({ rawInput: ' remember x' })
    expect(result).toEqual({ kind: 'error', text: 'plain-string-failure' })
  })

  it('MemoryDbError(empty_fingerprint_text) 被收敛为 error（AC4）', async () => {
    const definition = createMemoryRememberDefinition({
      writeInbox: async () => { throw new Error('记忆文本归一化后为空（只含标点或空白），拒绝建节点') },
    })

    const result = await definition.handler({ rawInput: ' remember ！！！' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('归一化后为空')
  })
})

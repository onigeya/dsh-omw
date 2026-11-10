/**
 * 入口导出形态测试（Story 1.1 / I/O 矩阵第 4 行）。
 *
 * 契约：function 插件入口只允许命名导出 `name`/`inject`/`Config`/`apply`，
 * **禁 default export**——default export 会让宿主 Loader 丢弃 function 插件
 * 命名空间（PRD §14 / postmortem 0001）。
 *
 * 测试对象是 `src/index.ts`（契约源头），而非构建产物：这样 `pnpm test`
 * 不依赖先跑 `pnpm -r build`。构建产物 `lib/index.js` 的同等断言由
 * `node -e "import('./packages/dsh-oh-my-whale-memory/lib/index.js')..."` 覆盖
 * （spec Verification 第 4 条）。
 */
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { resolveMemoryDbPath } from '../src/db/paths'
import { injectOpenSslPath } from './openssl'

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('memory 插件入口导出形态', () => {
  it('导出五件套命名导出', () => {
    const keys = Object.keys(plugin)
    expect(keys).toEqual(expect.arrayContaining(['name', 'inject', 'Config', 'apply']))
  })

  it('不含 default export（Loader 会因此丢弃命名空间）', () => {
    expect(Object.keys(plugin)).not.toContain('default')
  })

  it('name 为 lockstep 的 cordis 模块名（AD-2，永不重命名）', () => {
    expect(plugin.name).toBe('dsh-oh-my-whale-memory')
  })

  it('apply 是可调用的激活函数', () => {
    expect(typeof plugin.apply).toBe('function')
  })

  it('Config 是 schemastery schema（可调用对象，Story 1.3 起填字段）', () => {
    // schemastery 的 schema 既是函数又带元数据属性，不是普通 object。
    expect(plugin.Config).toBeTypeOf('function')
    expect(plugin.Config.type).toBe('object')
  })

  it("inject 含 'settings' 与 'tools'（AD-11 配置通道 / Story 1.6 工具注册表）", () => {
    expect(plugin.inject).toContain('settings')
    // Story 1.6：memory_remember 经 ctx.tools.register 注册，缺 'tools' 注入
    // 则 apply 里的 ctx.tools 不可用。
    expect(plugin.inject).toContain('tools')
  })

  it('apply 走分级校验 wiring：降级时 ctx.logger.warn 收到消息，合法配置无降级 warn', async () => {
    const warn = vi.fn()
    // 裸 ctx（无 profileContext）：Story 1.4 起除分级校验外还会 warn 一句"跳过建库"，
    // 因为裸 Context 没有 profile 归属，插件不猜库路径（AC1）。
    // Story 1.6：apply 先注册 memory_remember 工具再查 profile，
    // 因此任何 fake ctx 都必须提供 tools.register，否则 apply 直接 TypeError。
    const registered: unknown[] = []
    const ctx = {
      logger: { warn },
      tools: { register: (def: unknown) => { registered.push(def); return () => {} } },
    } as unknown as Parameters<typeof plugin.apply>[0]

    // token 缺失 → 降级 disabled + warn（I/O 矩阵第 6 行，apply 侧）
    const degraded = {
      embedding: { endpoint: 'https://api.example.com/v1', token: '', model: 'bge-m3' },
    }
    await plugin.apply(ctx, degraded)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toMatch(/^embedding 降级为 disabled：缺少 embedding\.token/)
    expect(warn.mock.calls[0][0]).not.toContain('bge-m3')
    expect(warn.mock.calls[1][0]).toMatch(/profileContext\.dir/)

    // 全字段合法 → 仍只有"跳过建库"这一条 warn，没有降级 warn
    warn.mockClear()
    const valid = {
      embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3' },
    }
    await plugin.apply(ctx, valid)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/profileContext\.dir/)

    // 硬校验失败 → apply 抛错（仅阻塞本插件）
    await expect(plugin.apply(ctx, {
      embedding: { endpoint: 'ftp://x', token: 'sk-test', model: 'bge-m3' },
    })).rejects.toThrow(/embedding\.endpoint/)

    // 每次成功走到注册步骤的 apply 都注册了一个工具；硬校验在注册之前抛错，不计入。
    expect(registered).toHaveLength(2)
  })

  it('有 profileContext 时 apply 在 <profile>/memory/lbug.db 建库并注册 close effect（AC1）', async () => {
    injectOpenSslPath()
    const dir = await mkdtemp(join(tmpdir(), 'omw-entry-'))
    tempDirs.push(dir)
    const warn = vi.fn()
    const info = vi.fn()
    const closers: Array<() => unknown> = []
    const registered: Array<{ name?: string }> = []
    const ctx = {
      logger: { warn, info },
      get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
      effect: (factory: () => () => unknown) => closers.push(factory()),
      tools: { register: (def: { name?: string }) => { registered.push(def); return () => {} } },
    } as unknown as Parameters<typeof plugin.apply>[0]

    await plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
    expect(warn).not.toHaveBeenCalled()
    await expect(access(resolveMemoryDbPath(dir))).resolves.toBeUndefined()
    expect(closers).toHaveLength(1)
    expect(info.mock.calls[0][0]).toMatch(/记忆库就绪/)
    expect(info.mock.calls[0][0]).toContain(resolveMemoryDbPath(dir))
    // Story 1.6：工具在库就绪前注册，且只有一个（不按 profile 重复注册）。
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('memory_remember')

    // dim 不符 → 拒绝启动（AC5），且不再注册新的 closer
    await expect(plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'other', dim: 8 } }))
      .rejects.toThrow(/维度不符/)
    expect(closers).toHaveLength(1)
  })
})

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
import { access } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)

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

  it("inject 含 'commands' / 'settings' / 'tools'（Story 1.7 命令 + AD-11 设置通道 + Story 1.6 工具注册表）", () => {
    expect(plugin.inject).toContain('commands')
    expect(plugin.inject).toContain('settings')
    // Story 1.6：memory_remember 经 ctx.tools.register 注册，缺 'tools' 注入
    // 则 apply 里的 ctx.tools 不可用。
    expect(plugin.inject).toContain('tools')
    // Story 2.3：INBOX 精炼走宿主单通道 ctx.llm（AD-5），路由回退链读 session（AC:567）。
    expect(plugin.inject).toContain('llm')
    expect(plugin.inject).toContain('sessions')
    // Story 3.3：新会话开局注入的静态 section + 动态 context 需要 ctx.systemPrompt（AC:921）。
    expect(plugin.inject).toContain('systemPrompt')
  })

  it('apply 走分级校验 wiring：降级时 ctx.logger.warn 收到消息，合法配置无降级 warn', async () => {
    const warn = vi.fn()
    // 裸 ctx（无 profileContext）：Story 1.4 起除分级校验外还会 warn 一句"跳过建库"，
    // 因为裸 Context 没有 profile 归属，插件不猜库路径（AC1）。
    // Story 1.6 / 1.7：apply 先注册 memory_remember 工具与 `/memory` 命令 effect、再查 profile，
    // 因此任何 fake ctx 都必须同时提供 tools.register 与 effect，否则 apply 直接 TypeError。
    const registered: unknown[] = []
    const ctx = {
      logger: { warn },
      effect: () => () => {},
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

    // 每次成功走到注册步骤的 apply 都注册了三个工具（Story 1.6 memory_remember +
    // Story 3.1 memory_recall + Story 3.2 memory_related）；硬校验在注册之前抛错，不计入。两次 apply ⇒ 6。
    expect(registered).toHaveLength(6)
  })

  it('有 profileContext 时 apply 在 <profile>/memory/lbug.db 建库并注册 close effect（AC1）', async () => {
    const dir = await makeTempDir('omw-entry-')
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

    await plugin.apply(ctx, { embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3', dim: 4 } })
    expect(warn).not.toHaveBeenCalled()
    await expect(access(resolveMemoryDbPath(dir))).resolves.toBeUndefined()
    // Story 1.5：apply 注册库 facade（1.4）与写者锁（AC1/AD-12）两个 disposer；
    // Story 1.7：无条件注册命令 effect（omw-memory-command）→ 每次成功 apply 共 3 个。
    expect(closers).toHaveLength(3)
    // 写者实例持有锁文件 `<dbPath>.lock`：这是跨进程"第二实例"的判据（AD-12）。
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).resolves.toBeUndefined()
    expect(plugin.memoryRuntimeState()).toMatchObject({ readonly: false, dbPath: resolveMemoryDbPath(dir) })
    expect(info.mock.calls[0][0]).toMatch(/记忆库就绪/)
    expect(info.mock.calls[0][0]).toContain(resolveMemoryDbPath(dir))
    // Story 1.6 + 3.1 + 3.2：工具在建就绪前注册，每次 apply 共三个（不按 profile 重复注册）。
    expect(registered).toHaveLength(3)
    expect(registered.map((definition) => definition.name)).toEqual(['memory_remember', 'memory_recall', 'memory_related'])

    // dim 不符 → 拒绝启动（AC5）：db closer 与锁 closer 都不新增，只多出 Story 1.7
    // 无条件注册的命令 effect；刚拿到的锁引用被回滚。
    await expect(plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'other', dim: 8 } }))
      .rejects.toThrow(/维度不符/)
    expect(closers).toHaveLength(4)

    // 回滚必须真的把引用还回去：否则引用计数停在 2，dispose 第一个实例后锁文件仍在，
    // 一个没有 facade 的窗口会永久占着写者锁，让真正的第二实例被迫降级只读。
    for (const dispose of closers) await dispose()
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).rejects.toThrow()
  })

  it('同进程第二次 apply 复用写者锁，不降级只读（Story 1.5 / AC1）', async () => {
    const dir = await makeTempDir('omw-entry-lock-')
    const warn = vi.fn()
    const info = vi.fn()
    const closers: Array<() => unknown> = []
    const ctx = {
      logger: { warn, info },
      get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
      effect: (factory: () => () => unknown) => closers.push(factory()),
      // Story 1.6：memory_remember 经 ctx.tools.register 注册（真实宿主里它是 effect）。
      // 替身只需可调用；closers 仍只统计 ctx.effect 注册的收尾器。
      tools: { register: () => () => {} },
    } as unknown as Parameters<typeof plugin.apply>[0]
    const config = { embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3', dim: 4 } }

    // 宿主 dispose→apply 抖动 / 同进程重复 apply 会走到这里：withFileLock 自己不会接管
    // 本进程的锁，所以插件必须按路径复用，否则第二个实例会把自己误判成"第二实例"。
    await plugin.apply(ctx, config)
    await plugin.apply(ctx, config)
    expect(warn).not.toHaveBeenCalled()
    expect(plugin.memoryRuntimeState().readonly).toBe(false)
    // 每次 apply：命令 effect + db closer + 写者锁 closer = 3，两次共 6。
    expect(closers).toHaveLength(6)

    // 引用归零后锁文件消失（dispose 语义），且可以重新取得写者锁。
    for (const dispose of closers) await dispose()
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).rejects.toThrow()
  })
})

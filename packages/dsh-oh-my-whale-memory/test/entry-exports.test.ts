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

  it('inject 含 \'settings\'（AD-11：/settings 表单投影与 /memory status 通道）', () => {
    expect(plugin.inject).toContain('settings')
  })

  it('apply 走分级校验 wiring：降级时 ctx.logger.warn 收到消息，合法配置无降级 warn', async () => {
    const warn = vi.fn()
    // 裸 ctx（无 profileContext）：Story 1.4 起除分级校验外还会 warn 一句"跳过建库"，
    // 因为裸 Context 没有 profile 归属，插件不猜库路径（AC1）。
    const ctx = { logger: { warn } } as unknown as Parameters<typeof plugin.apply>[0]

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
  })

  it('有 profileContext 时 apply 在 <profile>/memory/lbug.db 建库并注册 close effect（AC1）', async () => {
    injectOpenSslPath()
    const dir = await mkdtemp(join(tmpdir(), 'omw-entry-'))
    tempDirs.push(dir)
    const warn = vi.fn()
    const info = vi.fn()
    const closers: Array<() => unknown> = []
    const ctx = {
      logger: { warn, info },
      get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
      effect: (factory: () => () => unknown) => closers.push(factory()),
    } as unknown as Parameters<typeof plugin.apply>[0]

    await plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
    expect(warn).not.toHaveBeenCalled()
    await expect(access(resolveMemoryDbPath(dir))).resolves.toBeUndefined()
    // Story 1.5：apply 注册两个 disposer——库 facade（1.4）与写者锁（AC1/AD-12）。
    expect(closers).toHaveLength(2)
    // 写者实例持有锁文件 `<dbPath>.lock`：这是跨进程"第二实例"的判据（AD-12）。
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).resolves.toBeUndefined()
    expect(plugin.memoryRuntimeState()).toMatchObject({ readonly: false, dbPath: resolveMemoryDbPath(dir) })
    expect(info.mock.calls[0][0]).toMatch(/记忆库就绪/)
    expect(info.mock.calls[0][0]).toContain(resolveMemoryDbPath(dir))

    // dim 不符 → 拒绝启动（AC5），且不再注册新的 closer；刚拿到的锁引用被回滚
    await expect(plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'other', dim: 8 } }))
      .rejects.toThrow(/维度不符/)
    expect(closers).toHaveLength(2)

    // 回滚必须真的把引用还回去：否则引用计数停在 2，dispose 第一个实例后锁文件仍在，
    // 一个没有 facade 的窗口会永久占着写者锁，让真正的第二实例被迫降级只读。
    for (const dispose of closers) await dispose()
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).rejects.toThrow()
  })

  it('同进程第二次 apply 复用写者锁，不降级只读（Story 1.5 / AC1）', async () => {
    injectOpenSslPath()
    const dir = await mkdtemp(join(tmpdir(), 'omw-entry-lock-'))
    tempDirs.push(dir)
    const warn = vi.fn()
    const info = vi.fn()
    const closers: Array<() => unknown> = []
    const ctx = {
      logger: { warn, info },
      get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
      effect: (factory: () => () => unknown) => closers.push(factory()),
    } as unknown as Parameters<typeof plugin.apply>[0]
    const config = { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } }

    // 宿主 dispose→apply 抖动 / 同进程重复 apply 会走到这里：withFileLock 自己不会接管
    // 本进程的锁，所以插件必须按路径复用，否则第二个实例会把自己误判成"第二实例"。
    await plugin.apply(ctx, config)
    await plugin.apply(ctx, config)
    expect(warn).not.toHaveBeenCalled()
    expect(plugin.memoryRuntimeState().readonly).toBe(false)
    expect(closers).toHaveLength(4)

    // 引用归零后锁文件消失（dispose 语义），且可以重新取得写者锁。
    for (const dispose of closers) await dispose()
    await expect(access(`${resolveMemoryDbPath(dir)}.lock`)).rejects.toThrow()
  })
})

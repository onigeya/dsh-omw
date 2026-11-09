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
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'

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

  it('apply 走分级校验 wiring：降级时 ctx.logger.warn 收到消息，合法配置无 warn', async () => {
    const warn = vi.fn()
    const ctx = { logger: { warn } } as unknown as Parameters<typeof plugin.apply>[0]

    // token 缺失 → 降级 disabled + warn（I/O 矩阵第 6 行，apply 侧）
    const degraded = {
      embedding: { endpoint: 'https://api.example.com/v1', token: '', model: 'bge-m3' },
    }
    await plugin.apply(ctx, degraded)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/^embedding 降级为 disabled：缺少 embedding\.token/)
    expect(warn.mock.calls[0][0]).not.toContain('bge-m3')

    // 全字段合法 → 无 warn（I/O 矩阵第 1 行，apply 侧）
    warn.mockClear()
    const valid = {
      embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3' },
    }
    await plugin.apply(ctx, valid)
    expect(warn).not.toHaveBeenCalled()

    // 硬校验失败 → apply 抛错（仅阻塞本插件）
    await expect(plugin.apply(ctx, {
      embedding: { endpoint: 'ftp://x', token: 'sk-test', model: 'bge-m3' },
    })).rejects.toThrow(/embedding\.endpoint/)
  })
})

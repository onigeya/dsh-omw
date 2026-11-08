/**
 * 命名契约常量消费测试（Story 1.2 / AC 5 / deferred-work.md#D10）。
 *
 * 三常量 `BUNDLE_NAME` / `BUNDLE_VERSION` / `MEMORY_PLUGIN_MODULE` 在 Story 1.1
 * 落地时无消费者；本测试是 patch 激活层对它们的第一次消费：把
 * `src/index.ts` 常量、`package.json` manifest、`cordis.patch.yml` patch 行
 * 三处锁定为同一身份，任何一处漂移（改名、版本手误、patch 引用错模块名）
 * 都在此 fail-fast。
 *
 * 测试对象是**源文件**：本文件 import 两包 `src/index.ts` 而非包名入口——
 * 包名入口解析到 `lib/index.js`，而 `lib/` 在 .gitignore:6，干净 clone 里
 * 不存在。这与兄弟测试 entry-exports.test.ts:8-11 的策略一致：
 * `pnpm test` 不依赖先跑 `pnpm -r build`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLE_NAME, BUNDLE_VERSION, MEMORY_PLUGIN_MODULE } from '../src/index'
import { parsePatch } from './patch'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'))
const patchRaw = readFileSync(resolve(pkgDir, 'cordis.patch.yml'), 'utf8')
const patchNames = parsePatch(patchRaw)
  .flatMap(entry => entry.rows)
  .map(row => row.name)

describe('bundle 命名契约（AD-2：发布名永不重命名）', () => {
  it('package.json name === BUNDLE_NAME', () => {
    expect(pkg.name).toBe(BUNDLE_NAME)
    // 名字按 AD-2 永不重命名，因此字面量在这里是有效守卫（版本号不是）。
    expect(BUNDLE_NAME).toBe('dsh-oh-my-whale')
  })

  it('package.json version === BUNDLE_VERSION', () => {
    expect(pkg.version).toBe(BUNDLE_VERSION)
  })
})

describe('patch 行与 MEMORY_PLUGIN_MODULE 的一致性', () => {
  it('patch 的 name 全部 === MEMORY_PLUGIN_MODULE（按模块名字符串注册 memory）', () => {
    expect(patchNames.length).toBeGreaterThan(0)
    for (const name of patchNames) {
      expect(name).toBe(MEMORY_PLUGIN_MODULE)
    }
  })

  it('MEMORY_PLUGIN_MODULE 与 memory 插件入口导出的 name lockstep', async () => {
    // 直接 import memory 包的 src 入口（contract source），不经 lib/ 构建产物。
    const memoryPlugin = await import('../../dsh-oh-my-whale-memory/src/index')
    expect(memoryPlugin.name).toBe(MEMORY_PLUGIN_MODULE)
  })

  it('memory 插件无 default export（Loader 会丢弃命名空间）', async () => {
    const memoryPlugin = await import('../../dsh-oh-my-whale-memory/src/index')
    expect(Object.keys(memoryPlugin)).not.toContain('default')
  })
})

/**
 * 安装期 package.json 契约测试（Story 1.2 / D2 不变式，deferred-work.md#D2）。
 *
 * 守护的是 `dsh plugin add` 能把本包识别为 bundle 层而不是普通依赖所需的全部
 * 安装期字段。参考宿主判定点：
 * - `operations.ts:75-79` bundleManifest 只在 `dsh.bundle.patch` 存在时返回 manifest，
 *   缺则打 warning「installed as a plain dependency, not a profile layer」（publish.md:64）。
 * - `operations.ts:90-122` reconcile 依据 `dsh.bundle` 决定是否把包加入
 *   `dsh.profile.bundles`；依据 `engines.dsh` 决定是否走 peer 范围检查（publish.md:66）。
 *
 * 这些是「少一字段即静默失效」的契约，因此逐条断言，不依赖运行时验证。
 * 测试对象是仓库源文件（package.json / cordis.patch.yml / src/index.ts），
 * 与构建产物解耦——`lib/` 在 .gitignore，干净 clone 里不存在。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEMORY_PLUGIN_MODULE } from '../src/index'
import { parsePatch } from './patch'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'))
const memoryPkg = JSON.parse(
  readFileSync(resolve(pkgDir, '..', 'dsh-oh-my-whale-memory', 'package.json'), 'utf8'),
)
const patchPath = resolve(pkgDir, 'cordis.patch.yml')
const patchRaw = readFileSync(patchPath, 'utf8')

const patchEntries = parsePatch(patchRaw)
const insertRows = patchEntries.flatMap(entry => (entry.kind === 'insert' ? entry.rows : []))

describe('bundle 安装期身份（dsh.bundle.patch）', () => {
  it('dsh.bundle.patch 字段存在并指向仓库里真实存在的文件', () => {
    // 缺此字段宿主打 warning 且不激活层（operations.ts:104 / publish.md:64）。
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // 指向的文件必须真在 `files` 里被发布，否则装进 profile 后读不到。
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(() => readFileSync(patchPath, 'utf8')).not.toThrow()
  })

  it('engines.dsh 锁定兼容范围 ">=0.2.0 <0.3.0"', () => {
    // 无 engines.dsh 时宿主会回退检查每个 @deepseek-ai/dsh-* peer（publish.md:66）。
    expect(pkg.engines?.dsh).toBe('>=0.2.0 <0.3.0')
    expect(memoryPkg.engines?.dsh).toBe('>=0.2.0 <0.3.0')
  })

  it('memory 包不是 bundle（反向契约：不得多出一层冲突 patch）', () => {
    // D2 只做正向断言时，谁给 memory 误加 `dsh.bundle` 会静默多出一个 patch 层
    // 而测试全绿。memory 是 function 插件，由 bundle patch 按模块名注册。
    expect(memoryPkg.dsh?.bundle?.patch).toBeUndefined()
    expect(memoryPkg.files).not.toContain('cordis.patch.yml')
  })
})

describe('patch 清单契约（cordis.patch.yml）', () => {
  it('是顶层 YAML 数组，首项是 - insert: 且至少一条 insert 行', () => {
    expect(patchEntries.length).toBeGreaterThan(0)
    expect(patchEntries[0].kind).toBe('insert')
    expect(insertRows.length).toBeGreaterThan(0)
  })

  it('insert 行的 id 与 name 都等于 cordis 模块名', () => {
    // id 是宿主配置行的 key：用户按 id 写 override、--dump-config 按 id 显示。
    // 本包 AC 要求 settings namespace = 模块名，故此处 id 与 name 恰好同值；
    // 断言各自等于常量而非彼此相等（真实 bundle 里二者常不同）。
    for (const row of insertRows) {
      expect(row.id).toBe(MEMORY_PLUGIN_MODULE)
      expect(row.name).toBe(MEMORY_PLUGIN_MODULE)
    }
  })

  it('insert 行不硬编码 config（否则盖掉用户 /settings 的选择）', () => {
    for (const row of insertRows) {
      expect(row.config).toBeUndefined()
    }
  })
})

describe('依赖声明契约（AD-1 / publish.md:105）', () => {
  it('preset 在 dependencies（非 peer）声明 dsh-oh-my-whale-memory: workspace:*', () => {
    // AD-1 单向拓扑：preset → memory；声明在 dependencies 才会被 pnpm 随 bundle 装入 profile。
    expect(pkg.dependencies?.['dsh-oh-my-whale-memory']).toBe('workspace:*')
    expect(pkg.peerDependencies?.['dsh-oh-my-whale-memory']).toBeUndefined()
  })

  it('memory 严禁反向依赖 preset（拓扑单向）', () => {
    const memoryDeps = {
      ...memoryPkg.dependencies,
      ...memoryPkg.peerDependencies,
      ...memoryPkg.devDependencies,
    }
    expect(Object.keys(memoryDeps)).not.toContain('dsh-oh-my-whale')
  })

  it('@deepseek-ai/cordis 与 @deepseek-ai/dsh-tools 在 peer+dev 同 SemVer 字符串', () => {
    // publish.md:105：必须在两侧同时声明同范围，宿主才在运行时拦截 peer。
    for (const manifest of [pkg, memoryPkg]) {
      const peer = manifest.peerDependencies?.['@deepseek-ai/cordis']
      const dev = manifest.devDependencies?.['@deepseek-ai/cordis']
      expect(peer).toBeTruthy()
      expect(dev).toBe(peer)
    }
    // Story 1.6：memory 包的 @deepseek-ai/dsh-tools（memory_remember 的依赖）
    // 同样必须 peer+dev 同串，否则 peer/dev 漂移测不出。
    const toolsPeer = memoryPkg.peerDependencies?.['@deepseek-ai/dsh-tools']
    const toolsDev = memoryPkg.devDependencies?.['@deepseek-ai/dsh-tools']
    expect(toolsPeer).toBeTruthy()
    expect(toolsDev).toBe(toolsPeer)
  })

  it('@deepseek-ai/schemastery 在 dependencies（publish.md:105）', () => {
    expect(memoryPkg.dependencies?.['@deepseek-ai/schemastery']).toBeTruthy()
    expect(memoryPkg.peerDependencies?.['@deepseek-ai/schemastery']).toBeUndefined()
  })
})

describe('发布 files 契约', () => {
  it('bundle 包 files 含 patch + lib 入口 + d.ts 通配', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['cordis.patch.yml', 'lib/index.js', 'lib/**/*.d.ts']))
  })

  it('memory 包 files 恰含 lib/index.js 与 lib/types', () => {
    expect(memoryPkg.files).toEqual(['lib/index.js', 'lib/types'])
  })
})

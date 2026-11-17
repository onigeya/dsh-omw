/**
 * iot-thinking 互斥探测测试（Story 8.6 / T7、AC:1898-1901、矩阵行 14）。
 *
 * 三件事：
 * 1. 路径解析：由 `profileContext.dir`（`<DSH_HOME>/profiles/<name>`）反推，**不读**
 *    `process.env.DSH_HOME`（全局值可能指向另一个安装）；拿不到形状 ⇒ 不探测；
 * 2. 只读探测：目录在场 true、不在场 false（探测失败按不在场处理，不抛）；
 * 3. 装配：`apply` 在场时打一条 info 说明「只做 text 面」，不在场时**不产日志**、行为不变。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import {
  IOT_THINKING_PRESENT_NOTICE,
  IOT_THINKING_PLUGIN,
  PLUGIN_DATA_DIR,
  detectIotThinking,
  iotThinkingProbePath,
} from '../src/context/purify-probe'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('路径解析（profile 目录是唯一事实来源）', () => {
  it('由 profileContext.dir 反推 $DSH_HOME；不读 process.env.DSH_HOME', () => {
    expect(iotThinkingProbePath({ profileDir: join('D:/dsh-home', 'profiles', 'web') })).toBe(
      join('D:/dsh-home', PLUGIN_DATA_DIR, IOT_THINKING_PLUGIN),
    )
    // 环境变量是宿主进程全局值：即使在场也不得改变探测目标（否则单测依赖运行环境）
    vi.stubEnv('DSH_HOME', join('E:/other-install'))
    expect(iotThinkingProbePath({ profileDir: join('D:/dsh-home', 'profiles', 'web') })).toBe(
      join('D:/dsh-home', PLUGIN_DATA_DIR, IOT_THINKING_PLUGIN),
    )
    // 形状不符 / 没有 profile ⇒ null（不探测，调用方静默）
    expect(iotThinkingProbePath({})).toBeNull()
    expect(iotThinkingProbePath({ profileDir: '   ' })).toBeNull()
  })
})

describe('只读探测（矩阵行 14）', () => {
  it('目录在场 ⇒ present: true 且给出路径；不在场 ⇒ false', async () => {
    const home = await makeTempDir('omw-iot-thinking-')
    const profileDir = join(home, 'profiles', 'web')
    const target = join(home, PLUGIN_DATA_DIR, IOT_THINKING_PLUGIN)
    expect(detectIotThinking({ profileDir })).toEqual({ present: false, path: target })

    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), '{}', 'utf8')
    expect(detectIotThinking({ profileDir })).toEqual({ present: true, path: target })

    // 清理后回到不在场（探测无状态、不缓存）
    await rm(target, { recursive: true, force: true })
    expect(detectIotThinking({ profileDir }).present).toBe(false)
  })

  it('定位不到 $DSH_HOME ⇒ present: false、path: null（不抛）', () => {
    expect(detectIotThinking({})).toEqual({ present: false, path: null })
  })
})

describe('装配：在场只做 text 面并留说明（apply 级）', () => {
  /** 最小裸 ctx：只提供 apply 成功路径需要的四个面（同 entry-exports 的口径）。 */
  function makeCtx(info: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>, dir: string) {
    return {
      logger: { warn, info },
      get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
      effect: (factory: () => () => unknown) => factory(),
      tools: { register: () => () => {} },
    } as unknown as Parameters<typeof apply>[0]
  }

  it('iot-thinking 在场 ⇒ 打一条 info 说明；不在场 ⇒ 不产该日志', async () => {
    const home = await makeTempDir('omw-iot-apply-')
    const profileDir = join(home, 'profiles', 'web')
    await mkdir(join(home, PLUGIN_DATA_DIR, IOT_THINKING_PLUGIN), { recursive: true })

    const info = vi.fn()
    const warn = vi.fn()
    await apply(makeCtx(info, warn, profileDir), {
      embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3', dim: 4 },
    })
    expect(info.mock.calls.map((call) => String(call[0]))).toContain(IOT_THINKING_PRESENT_NOTICE)

    // 不在场：同一条路径不产说明
    const cleanHome = await makeTempDir('omw-iot-apply-clean-')
    const info2 = vi.fn()
    const warn2 = vi.fn()
    await apply(makeCtx(info2, warn2, join(cleanHome, 'profiles', 'web')), {
      embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3', dim: 4 },
    })
    expect(info2.mock.calls.map((call) => String(call[0]))).not.toContain(IOT_THINKING_PRESENT_NOTICE)
    expect(info2.mock.calls[0]?.[0]).toMatch(/记忆库就绪/)
  })
})

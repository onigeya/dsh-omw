/**
 * 端到端测试：在独立 DSH profile 中安装本插件（tarball 发布形态）后，
 * 通过真实宿主验证三类面：
 * - 安装形态：profile 建在临时 DSH_HOME，依赖指向 tarball，bundle 已登记；
 * - Web GUI：Plugins 页把 bundle 的 function 插件显示为 Running；composer 的
 *   斜杠菜单列出 /memory 命令；
 * - 宿主命令面：/memory status / remember / list / show / related 的真实输出，
 *   以及插件 Config 在 settings.describe 里的投影（AD-11）。
 *
 * 不发起任何模型调用：命令面在宿主侧结算（command/run + command/done），
 * 与 harness 注入的假 key 无关。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openApp,
  startE2EEnvironment,
  type E2EEnvironment,
  type MemorySettingsNamespace,
} from './harness'

/** 从 `/memory status` 文本里读一个计数行。 */
function countOf(text: string, key: 'L1' | 'L2' | 'L1_INBOX' | 'L2_INBOX'): number {
  const match = new RegExp(`^${key}: (\\d+)$`, 'm').exec(text)
  if (match?.[1] === undefined) throw new Error(`status 缺少 ${key} 行：\n${text}`)
  return Number(match[1])
}

describe('dsh-oh-my-whale 在独立 profile 中的端到端行为', () => {
  let environment: E2EEnvironment
  let browser: Browser

  beforeAll(async () => {
    environment = await startE2EEnvironment()
    browser = await chromium.launch({ headless: true })
  }, 300_000)

  afterAll(async () => {
    await browser?.close()
    await environment?.close()
  })

  it('在独立 DSH_HOME 里创建 profile，并以 tarball 形态登记插件 bundle', () => {
    // profile 不落在用户真实 $DSH_HOME：整个环境建在系统临时目录下。
    expect(environment.profileDir.startsWith(tmpdir())).toBe(true)
    expect(existsSync(join(environment.profileDir, 'cordis.patch.yml'))).toBe(true)

    const manifest = JSON.parse(
      readFileSync(join(environment.profileDir, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    // 发布形态：依赖指向 pnpm pack 出的 tarball，而不是 workspace link。
    expect(manifest.dependencies?.['dsh-oh-my-whale']).toMatch(/\.tgz$/u)
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-oh-my-whale')
    // bundle 的 patch 行把 memory 装进 profile，入口文件必须真实存在。
    expect(existsSync(join(
      environment.profileDir, 'node_modules', 'dsh-oh-my-whale-memory', 'lib', 'index.js',
    ))).toBe(true)
  })

  it('Plugins 页把已安装 bundle 的 function 插件显示为 Running', async () => {
    const pageErrors: string[] = []
    const page = await openApp(browser, environment, pageErrors)
    try {
      await page.getByRole('navigation', { name: 'Global panels' })
        .getByRole('button', { name: 'Plugins', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.waitFor({ timeout: 15_000 })

      const card = panel.getByRole('button', { name: 'View dsh-oh-my-whale', exact: true })
      await card.waitFor({ timeout: 15_000 })
      await card.click()

      const detail = panel.locator('[data-plugin-detail]')
      await detail.waitFor({ timeout: 10_000 })
      const text = await detail.innerText()
      // bundle 本身与它插入的 memory 行都在详情里；行状态由宿主 fiber 相位投影。
      expect(text).toContain('dsh-oh-my-whale')
      expect(text).toMatch(/1 total\s*·\s*1 running/u)
      expect(text).toContain('dsh-oh-my-whale-memory')
      expect(text).toMatch(/Running/u)
      // 来源是本次 pnpm pack 的 tarball，证明装的是发布形态而不是 workspace link。
      expect(text).toContain('dsh-oh-my-whale-0.1.0.tgz')
      expect(pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('composer 的斜杠菜单列出 /memory 命令及其描述', async () => {
    const pageErrors: string[] = []
    const page = await openApp(browser, environment, pageErrors)
    try {
      const input = page.locator('[data-composer-input]').first()
      await input.waitFor({ timeout: 15_000 })
      await input.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type('/mem')

      await page.getByRole('listbox').waitFor({ timeout: 10_000 })
      const option = page.getByRole('option', { name: /memory/u })
      await option.waitFor({ timeout: 10_000 })
      expect(await option.count()).toBe(1)
      // 描述文案来自插件注册的命令定义，说明命令确实由本插件提供。
      await page.getByText('记录与浏览长期记忆（remember / list / show / status / recall / related）', { exact: false })
        .waitFor({ timeout: 10_000 })
      expect(pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('/memory status 在真实宿主里返回完整运行态', async () => {
    const sessionId = await environment.createSession()
    const execution = await environment.command(sessionId, '/memory status')
    expect(execution).toBeDefined()
    expect(execution!.result.kind).toBe('success')
    const text = execution!.result.text

    const lines = text.split('\n')
    expect(lines[0]).toBe('记忆状态')
    expect(text).toMatch(/^L1: \d+$/mu)
    expect(text).toMatch(/^L2: \d+$/mu)
    expect(text).toMatch(/^L1_INBOX: \d+$/mu)
    expect(text).toMatch(/^L2_INBOX: \d+$/mu)
    expect(text).toMatch(/^failed: 0$/mu)
    expect(text).toMatch(/^audit_gap: 0$/mu)
    // 本 profile 没有 embedding 凭据：必须显式降级，而不是静默 no-op。
    expect(text).toContain('embedding: disabled（降级检索）')
    expect(text).toContain('systemOne: enabled')
    expect(text).toContain('readonly: false')
    expect(text).toContain('injection: 未知（本实例尚未触发开局注入）')
    // 命令能读库，说明 apply 已建好 `<profile>/memory/lbug.db`。
    expect(existsSync(environment.memoryDbPath)).toBe(true)
  })

  it('/memory remember → list → show 走通写入与读回', async () => {
    const marker = `E2E-${randomUUID().slice(0, 8)} RRF 融合参数 k=60`
    const sessionId = await environment.createSession()

    const before = await environment.command(sessionId, '/memory status')
    const beforeL1 = countOf(before!.result.text, 'L1')

    const remembered = await environment.command(sessionId, `/memory remember ${marker}`)
    expect(remembered!.result).toEqual({ kind: 'success', text: `已记住：${marker}` })

    // inbox 消费是异步的：等 L1 计数增长，而不是固定 sleep。
    await expect.poll(async () => {
      const status = await environment.command(sessionId, '/memory status')
      return countOf(status!.result.text, 'L1') >= beforeL1 + 1
    }, { timeout: 20_000, interval: 250 }).toBe(true)

    const list = await environment.command(sessionId, `/memory list ${marker.split(' ')[0]}`)
    expect(list!.result.kind).toBe('success')
    const listText = list!.result.text
    expect(listText).toMatch(/^记忆列表（共 1 条，最近优先）：$/mu)
    expect(listText).toContain(`[L1] ${marker}`)
    const id = /- ([0-9a-f-]{36}) \[L1\]/u.exec(listText)?.[1]
    expect(id).toBeDefined()

    const shown = await environment.command(sessionId, `/memory show ${id}`)
    expect(shown!.result.kind).toBe('success')
    const showText = shown!.result.text
    expect(showText).toContain(`记忆 ${id}：`)
    expect(showText).toContain('layer: L1')
    expect(showText).toContain('kind: (空)')
    expect(showText).toContain('priority: 0')
    expect(showText).toContain(`text: ${marker}`)
    expect(showText).toContain('source_refs: []')
    expect(showText).toContain('invalid_at: (空)')
    expect(showText).toContain('expired_at: (空)')

    const related = await environment.command(sessionId, `/memory related ${id}`)
    expect(related!.result).toEqual({ kind: 'success', text: '无匹配记忆。' })
  })

  it('命令面的错误输入与降级召回返回可读结果而不是崩溃', async () => {
    const sessionId = await environment.createSession()

    const missing = await environment.command(sessionId, '/memory show nope')
    expect(missing!.result.kind).toBe('error')
    expect(missing!.result.text).toBe('未找到 id 为 nope 的记忆。')

    const bogus = await environment.command(sessionId, '/memory bogus')
    expect(bogus!.result.kind).toBe('error')
    expect(bogus!.result.text.startsWith('用法：/memory <子命令>')).toBe(true)

    // 无 embedding 凭据时 recall 必须显式降级为关键词单路，而不是报错或静默空。
    const recall = await environment.command(sessionId, '/memory recall zzz-no-such-memory-zzz')
    expect(recall!.result).toEqual({
      kind: 'success',
      text: '无匹配记忆（embedding 不可用，本次仅关键词单路）。',
    })
  })

  it('插件 Config 以 volatile 表单投影进宿主 settings 文档', async () => {
    const document = await environment.rpc<{
      writable: boolean
      namespaces: MemorySettingsNamespace[]
    }>('settings/describe', {})

    expect(document.writable).toBe(true)
    const memory = document.namespaces.find(entry => entry.ns === 'dsh-oh-my-whale-memory')
    expect(memory).toBeDefined()
    // 全字段默认值来自 schema 的 default()，是 /settings 表单与运行时配置的共同来源。
    expect(memory!.value).toEqual({
      embedding: {},
      rerank: {},
      captureSteps: 50,
      inboxRefineConcurrency: 4,
      injectOnNewSession: true,
      rrfK: 60,
      retrievalTopK: 50,
      layerWeights: { l2: 0.7, l1: 0.4 },
      priorityWeight: 0.5,
      systemOne: { enabled: true },
    })
  })
})

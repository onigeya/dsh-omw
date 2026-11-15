/**
 * 端到端测试夹具：用 DSH 自带的 CLI 在一个独立的 DSH_HOME 里创建 profile、
 * 安装本插件（pnpm pack 出的 tarball）、启动 `dsh web`，并暴露测试需要的
 * 启动 URL / RPC / 进程生命周期。
 *
 * 设计约束（与仓库既有约定一致）：
 * - profile 从宿主随包发布的 web 模板复制（`--from-default-profile web`），
 *   不读写用户真实 `$DSH_HOME` 下的 profile；
 * - 安装走发布形态：`pnpm pack` 两包 → `dsh plugin add <bundle.tgz>`，由
 *   profile 的 pnpm-workspace.yaml 用 overrides 把 memory 依赖指到本地 tarball
 *   （bundle 的 `workspace:*` 在 pack 后变成 `0.1.0`，registry 上并不存在）；
 * - `@ladybugdb/core` 的原生安装脚本在 pnpm 12 默认被忽略，必须显式 allowBuilds，
 *   否则插件 apply 时加载不到原生 addon；
 * - Windows 上 `dsh` / `pnpm` 都是 .cmd，统一经 cmd.exe 调用。
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE_DIR = join(REPO_ROOT, 'packages', 'dsh-oh-my-whale')
const MEMORY_DIR = join(REPO_ROOT, 'packages', 'dsh-oh-my-whale-memory')
const PROFILE_NAME = 'omw-e2e'
/** 假 key：只让宿主认为模型可用，测试不会发起任何模型调用。 */
const KEYLESS_API_KEY = 'keyless-e2e-no-call'

/** 一条 `/memory` 命令的执行结果（commands/execute 的 value）。 */
export interface CommandExecution {
  commandId: string
  result: { kind: 'success' | 'error', text: string, sourceEventSeq?: number }
}

/** settings.describe 里本插件命名空间的投影。 */
export interface MemorySettingsNamespace {
  ns: string
  writable: boolean
  value: Record<string, unknown>
  revision: number
}

export interface E2EEnvironment {
  /** 本次运行的临时根目录（含 .dsh / .agents / packs）。 */
  readonly root: string
  /** 独立 profile 的目录：`<root>/.dsh/profiles/omw-e2e`。 */
  readonly profileDir: string
  /** `dsh web` 打印的带 token 启动 URL。 */
  readonly launchUrl: string
  /** 已换好 cookie 的 origin。 */
  readonly origin: string
  /** 测试侧调用宿主 RPC 用的 cookie。 */
  readonly cookie: string
  /** 插件库文件：`<profile>/memory/lbug.db`。 */
  readonly memoryDbPath: string
  /** 调用一个宿主 RPC；失败时抛出带 code/message 的错误。 */
  rpc<T>(method: string, args: unknown): Promise<T>
  /** 新建一个会话并返回 sessionId。 */
  createSession(): Promise<string>
  /** 对指定会话执行一条斜杠命令。 */
  command(sessionId: string, line: string): Promise<CommandExecution | undefined>
  /** 杀掉 web 进程树并清理临时目录（保留现场时用 keepArtifacts）。 */
  close(): Promise<void>
}

/** 用 cmd.exe 跑一条命令行（Windows 的 pnpm/dsh 都是 .cmd）。 */
function run(line: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execSync(line, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  })
}

/** 路径参数加引号，避免空格把命令拆断。 */
function quote(path: string): string {
  return `"${path}"`
}

/** 等子进程的 ready 行；退出或超时都带完整输出失败。 */
function waitForLaunchUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh web 未在 120s 内就绪；输出：\n${output}`))
    }, 120_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web 提前退出（code ${String(code)}）；输出：\n${output}`))
    })
  })
}

/** 杀掉整棵进程树（cmd 子进程 + 其启动的宿主进程）。 */
function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve()
  try {
    execSync(`taskkill /PID ${String(child.pid)} /T /F`, { stdio: 'ignore' })
  } catch {
    // 进程可能已经退出；下面的 exit 等待仍会返回。
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** 确保 OpenSSL 3 DLL 在 PATH 里（native 后端的 vector/fts 扩展依赖它）。 */
function withOpenSslPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitBin = 'C:\\Program Files\\Git\\mingw64\\bin'
  const path = env.PATH ?? env.Path ?? ''
  if (!existsSync(gitBin) || path.split(';').some(entry => entry.toLowerCase() === gitBin.toLowerCase())) {
    return env
  }
  return { ...env, PATH: `${gitBin};${path}` }
}

/**
 * 创建并启动一套独立环境：打包 → 建 profile → 装插件 → 起 web。
 * @param options.keepArtifacts - 失败排查时保留临时目录。
 */
export async function startE2EEnvironment(
  options: { readonly keepArtifacts?: boolean } = {},
): Promise<E2EEnvironment> {
  const root = mkdtempSync(join(tmpdir(), 'omw-e2e-'))
  const dshHome = join(root, '.dsh')
  const agentsHome = join(root, '.agents')
  const packs = join(root, 'packs')
  mkdirSync(packs, { recursive: true })

  const dshEnv: NodeJS.ProcessEnv = withOpenSslPath({
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
  })

  // 1. 构建并打 tarball（发布形态）；--ignore-scripts 避免 pack 再跑一遍 prepare 构建。
  run(`pnpm --dir ${quote(MEMORY_DIR)} run build`, REPO_ROOT)
  run(`pnpm --dir ${quote(BUNDLE_DIR)} run build`, REPO_ROOT)
  run(`pnpm --dir ${quote(MEMORY_DIR)} pack --ignore-scripts --pack-destination ${quote(packs)}`, REPO_ROOT)
  run(`pnpm --dir ${quote(BUNDLE_DIR)} pack --ignore-scripts --pack-destination ${quote(packs)}`, REPO_ROOT)
  const memoryTgz = join(packs, 'dsh-oh-my-whale-memory-0.1.0.tgz')
  const bundleTgz = join(packs, 'dsh-oh-my-whale-0.1.0.tgz')
  if (!existsSync(memoryTgz) || !existsSync(bundleTgz)) {
    throw new Error(`pnpm pack 未产出预期 tarball：${packs}`)
  }

  // 2. 从随包 web 模板建独立 profile；--dump-config 只组合配置、不启动宿主。
  run(`dsh --profile ${PROFILE_NAME} --from-default-profile web --dump-config`, root, dshEnv)
  const profileDir = join(dshHome, 'profiles', PROFILE_NAME)
  const profileManifestPath = join(profileDir, 'package.json')
  if (!existsSync(profileManifestPath)) {
    throw new Error(`profile 未创建：${profileDir}`)
  }

  // 3. profile 的 pnpm 设置：memory 依赖指向本地 tarball，并放行 ladybug 原生安装脚本。
  const override = `file:${memoryTgz.replaceAll('\\', '/')}`
  appendFileSync(
    join(profileDir, 'pnpm-workspace.yaml'),
    `overrides:\n  dsh-oh-my-whale-memory: "${override}"\nallowBuilds:\n  "@ladybugdb/core": true\n`,
    'utf8',
  )

  // 4. 安装 bundle：dsh plugin add 负责 pnpm install + 把 bundle 记进 profile 的 bundles。
  run(`dsh plugin --profile ${PROFILE_NAME} add ${quote(bundleTgz)}`, root, dshEnv)
  const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  if (manifest.dsh?.profile?.bundles?.includes('dsh-oh-my-whale') !== true) {
    throw new Error(`插件未被登记为 profile bundle：${profileManifestPath}`)
  }

  // 5. 启动 web：端口交给 OS，URL（含 token）从 stdout 解析。
  const child = spawn('dsh', ['--profile', PROFILE_NAME, '--no-open', '--port', '0'], {
    cwd: root,
    env: { ...dshEnv, DEEPSEEK_API_KEY: KEYLESS_API_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  })
  let launchUrl: string
  try {
    launchUrl = await waitForLaunchUrl(child)
  } catch (error) {
    // 启动失败时不能把半启动的宿主留在后台（它会占住 profile 的写者锁）。
    await killTree(child)
    throw error
  }

  // 6. 用启动 URL 换会话 cookie，后续测试全部走同一条已认证通道。
  const exchange = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = exchange.headers.get('set-cookie')
  if (exchange.status !== 303 || setCookie === null) {
    await killTree(child)
    throw new Error(`dsh web 认证失败：HTTP ${String(exchange.status)}`)
  }
  const cookie = setCookie.split(';', 1)[0] as string
  const origin = new URL(launchUrl).origin

  const rpc = async <T>(method: string, args: unknown): Promise<T> => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `e2e-${method}-${Math.random().toString(36).slice(2)}`,
        method,
        payload: { args },
      }),
    })
    const body = (await response.json()) as {
      result: { ok: true, value: T } | { ok: false, error: { code: string, message: string } }
    }
    if (!body.result.ok) {
      throw new Error(`${method} 失败：${body.result.error.code}: ${body.result.error.message}`)
    }
    return body.result.value
  }

  const environment: E2EEnvironment = {
    root,
    profileDir,
    launchUrl,
    origin,
    cookie,
    memoryDbPath: join(profileDir, 'memory', 'lbug.db'),
    rpc,
    createSession: async () => {
      const created = await rpc<{ sessionId: string }>('session/create', { request: {} })
      return created.sessionId
    },
    command: (sessionId, line) => rpc<CommandExecution | undefined>('commands/execute', {
      agentId: sessionId,
      line,
      submittedAttachments: [],
    }),
    close: async () => {
      await killTree(child)
      const keep = options.keepArtifacts === true || process.env.DSH_E2E_KEEP === '1'
      if (keep) {
        console.info(`[e2e] 保留现场：${root}`)
        return
      }
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        // 临时目录清理失败不应掩盖测试结果。
      }
    },
  }
  return environment
}

/** 打开 GUI 并等框架渲染完成；顺手关掉首次启动的 Preview Notice。 */
export async function openApp(
  browser: Browser,
  environment: E2EEnvironment,
  pageErrors?: string[],
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1680, height: 1000 },
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  // 监听要在导航前挂上，否则首屏渲染期的未捕获异常会被漏掉。
  if (pageErrors !== undefined) {
    page.on('pageerror', error => { pageErrors.push(error.message) })
  }
  await page.goto(environment.launchUrl)
  await page.locator('[class*="frame"]').first().waitFor({ timeout: 30_000 })
  const notice = page.getByRole('dialog', { name: 'Preview Notice' })
  try {
    await notice.waitFor({ state: 'visible', timeout: 4_000 })
    await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    await notice.waitFor({ state: 'detached', timeout: 10_000 })
  } catch {
    // 已经确认过（同一 profile 的第二次打开）时没有这个对话框。
  }
  return page
}

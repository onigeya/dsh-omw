#!/usr/bin/env node
/**
 * 发布形态冒烟（Story 5.1 / AD-35 / AC:1145-1154、1177-1179）。
 *
 * 串起一条可重复、无浏览器的路径：
 *   pack 两包 → AC:1145 精确 tarball 断言 → 临时 DSH_HOME 建 profile →
 *   写 overrides + allowBuilds → `dsh plugin add <bundle.tgz>` → `--dump-config`
 *   断言模块名 → `plugin remove` 断言无 `link:` 残留 → 证据日志落盘。
 *
 * 安装路径说明（2026-11-16 探针）：`memory.tgz` 先装、`bundle.tgz` 再装的两步安装
 * 仍报 `ERR_PNPM_FETCH_404`（bundle 的 `dsh-oh-my-whale-memory@0.1.0` 去 registry
 * 解析）。本脚本因此走 e2e 既有的 overrides 退回路，并在日志里显式记下
 * `install:two-step skip`（AC:1151-1153 未达成，不静默改口径）。
 *
 * 用法：
 *   node scripts/publish-smoke.mjs                 # 全段
 *   node scripts/publish-smoke.mjs --only=tarball  # 只到 pack + 精确 tarball 断言
 *   node scripts/publish-smoke.mjs --only=profile  # 再加临时 profile + overrides
 *   node scripts/publish-smoke.mjs --only=install  # 再加安装 / dump-config / remove
 *   OMW_SMOKE_LOG=<path>  覆盖日志路径（默认 _bmad-output/implementation-artifacts/publish-smoke-<YYYYMMDD-HHmm>.log）
 *   OMW_SMOKE_KEEP=1      保留临时 DSH_HOME 现场（默认结束即删）
 *
 * 安全：DSH_HOME 必须落在系统临时目录下（运行前断言），绝不读写用户真实 `$DSH_HOME`；
 * 不发起任何模型请求，日志不含凭据（结束时扫描 `sk-` 形态并拒收）。
 */
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TARBALL_SPECS,
  describeTarballFailures,
  evaluateTarball,
  tarballSummary,
} from './lib/tarball-expectations.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROFILE_NAME = 'omw-smoke'
const STEP_WIDTH = 24
const only = parseOnly(process.argv.slice(2))

const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}`
const logPath = process.env.OMW_SMOKE_LOG ??
  join(REPO_ROOT, '_bmad-output', 'implementation-artifacts', `publish-smoke-${stamp}.log`)
mkdirSync(dirname(logPath), { recursive: true })

const lines = []
const log = (line) => {
  lines.push(line)
  appendFileSync(logPath, line + '\n', 'utf8')
  console.log(line)
}
const detail = (text) => {
  for (const line of String(text).split(/\r?\n/)) log('    ' + line)
}

class SmokeFailure extends Error {
  constructor(step, cause) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SmokeFailure'
  }
}

/** 跑一个步骤：成功打印 ok 行并返回摘要，失败打印 FAIL 行并中止后续步骤。 */
function step(name, action) {
  try {
    const summary = action()
    log(`[step] ${name.padEnd(STEP_WIDTH)} ok   ${summary ?? ''}`.trimEnd())
    return summary
  } catch (error) {
    log(`[step] ${name.padEnd(STEP_WIDTH)} FAIL ${error instanceof Error ? error.message : String(error)}`)
    throw new SmokeFailure(name, error)
  }
}

function parseOnly(argv) {
  const flag = argv.find((arg) => arg.startsWith('--only='))
  if (flag === undefined) return undefined
  const value = flag.slice('--only='.length)
  if (!['tarball', 'profile', 'install'].includes(value)) {
    throw new Error(`--only 只接受 tarball|profile|install，收到：${value}`)
  }
  return value
}

function quote(path) {
  return `"${path.replaceAll('"', '')}"`
}

function withOpenSslPath(env) {
  // native 后端的 vector/fts 扩展在 Windows 上依赖 OpenSSL 3（见 AGENTS.md）。
  const gitBin = 'C:\\Program Files\\Git\\mingw64\\bin'
  const path = env.PATH ?? env.Path ?? ''
  if (!existsSync(gitBin) || path.split(';').some((entry) => entry.toLowerCase() === gitBin.toLowerCase())) {
    return env
  }
  return { ...env, PATH: `${gitBin};${path}` }
}

function run(command, cwd, env) {
  try {
    const stdout = execSync(command, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    }
  }
}

function assertCommand(result, label) {
  if (result.ok) return
  const tail = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(' | ')
  throw new Error(`${label} 退出非 0${tail.length > 0 ? '：' + tail : ''}`)
}

function assertTempDshHome(dshHome, tempBase) {
  const normalized = resolve(dshHome)
  const prefix = resolve(tempBase) + sep
  if (!normalized.startsWith(prefix)) {
    throw new Error(`DSH_HOME 必须落在系统临时目录下：${normalized} 不在 ${prefix} 内`)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const tempBase = realpathSync(tmpdir())
const workRoot = mkdtempSync(join(tempBase, 'omw-publish-smoke-'))
const dshHome = join(workRoot, '.dsh')
const agentsHome = join(workRoot, '.agents')
assertTempDshHome(dshHome, tempBase)

const env = withOpenSslPath({
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: agentsHome,
})
const profileDir = join(dshHome, 'profiles', PROFILE_NAME)
const profileManifestPath = join(profileDir, 'package.json')
const packsDir = join(workRoot, 'packs')
const memoryTgz = join(packsDir, 'memory', `${TARBALL_SPECS.memory.packageName}-0.1.0.tgz`)
const bundleTgz = join(packsDir, 'bundle', `${TARBALL_SPECS.bundle.packageName}-0.1.0.tgz`)

let exitCode = 0
log(`[publish-smoke] ${now.toISOString()} only=${only ?? 'all'} log=${logPath}`)
log(`[env] DSH_HOME=${dshHome} (asserted under ${tempBase})`)

try {
  step('preflight', () => {
    for (const [label, spec] of Object.entries(TARBALL_SPECS)) {
      const built = join(REPO_ROOT, spec.dir, 'lib', 'index.js')
      if (!existsSync(built)) throw new Error(`${label} 未构建（缺 ${built}），先跑 pnpm -r build`)
    }
    const version = run('dsh --version', workRoot, env)
    assertCommand(version, 'dsh --version')
    return `dsh ${version.stdout.trim().split(/\r?\n/)[0] ?? ''}`
  })

  // ---- tarball 段：pack + AC:1145 精确集合断言 ------------------------------
  for (const [label, spec] of Object.entries(TARBALL_SPECS)) {
    step(`pack:${label}`, () => {
      const out = join(packsDir, label)
      mkdirSync(out, { recursive: true })
      // --ignore-scripts：不打回 prepare 构建；构建由门禁 `pnpm -r build` 负责（preflight 已检查）。
      assertCommand(
        run(`pnpm pack --ignore-scripts --pack-destination ${quote(out)}`, join(REPO_ROOT, spec.dir), env),
        `pnpm pack ${label}`,
      )
      const tar = label === 'memory' ? memoryTgz : bundleTgz
      if (!existsSync(tar)) throw new Error(`pnpm pack 未产出预期 tarball：${tar}`)
      return `${tar.slice(tar.lastIndexOf(sep) + 1)}`
    })

    step(`tarball:${label}`, () => {
      const tar = label === 'memory' ? memoryTgz : bundleTgz
      const listing = run(`tar -tf ${quote(tar)}`, REPO_ROOT, env)
      assertCommand(listing, `tar -tf ${label}`)
      const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
      detail(`entries(${label}): ${entries.join(', ')}`)
      const result = evaluateTarball(label, entries)
      if (!result.ok) throw new Error(describeTarballFailures(result).join('；'))
      return tarballSummary(result)
    })
  }

  if (only === 'tarball') {
    log('[publish-smoke] stop after tarball（--only=tarball）')
  } else {
    // ---- profile 段：临时 DSH_HOME + 默认 web 模板 -------------------------
    step('profile:create', () => {
      assertCommand(
        run(`dsh --profile ${PROFILE_NAME} --from-default-profile web --dump-config`, workRoot, env),
        'dsh --from-default-profile web --dump-config',
      )
      if (!existsSync(profileManifestPath)) throw new Error(`profile 未创建：${profileManifestPath}`)
      return `dsh --profile ${PROFILE_NAME} --from-default-profile web --dump-config`
    })

    step('profile:overrides', () => {
      // 两步安装的退回路（见文件头）：把 memory 指到本地 tarball，放行原生安装脚本。
      const override = `file:${memoryTgz.replaceAll('\\', '/')}`
      appendFileSync(
        join(profileDir, 'pnpm-workspace.yaml'),
        `overrides:\n  dsh-oh-my-whale-memory: ${JSON.stringify(override)}\nallowBuilds:\n  "@ladybugdb/core": true\n`,
        'utf8',
      )
      return `dsh-oh-my-whale-memory -> ${override}; allowBuilds @ladybugdb/core`
    })

    if (only === 'profile') {
      log('[publish-smoke] stop after profile（--only=profile）')
    } else {
      // ---- install 段：安装 → dump-config → remove -------------------------
      log(
        `[step] ${'install:two-step'.padEnd(STEP_WIDTH)} skip ` +
        'AC:1151-1153 未达成（探针：bundle add 对 memory@0.1.0 报 ERR_PNPM_FETCH_404）→ 走 overrides 退回路',
      )

      step('install:overrides', () => {
        assertCommand(
          run(`dsh plugin --profile ${PROFILE_NAME} add ${quote(bundleTgz)}`, workRoot, env),
          'dsh plugin add <bundle.tgz>',
        )
        const manifest = readJson(profileManifestPath)
        const dependencies = manifest.dependencies ?? {}
        const bundles = manifest.dsh?.profile?.bundles ?? []
        if (!('dsh-oh-my-whale' in dependencies)) {
          throw new Error(`profile dependencies 缺 dsh-oh-my-whale：${JSON.stringify(dependencies)}`)
        }
        if (!bundles.includes('dsh-oh-my-whale')) {
          throw new Error(`profile bundles 未登记 dsh-oh-my-whale：${JSON.stringify(bundles)}`)
        }
        const memoryPackage = join(profileDir, 'node_modules', 'dsh-oh-my-whale-memory', 'package.json')
        if (!existsSync(memoryPackage)) {
          throw new Error(`memory 依赖未落盘（overrides 未生效）：${memoryPackage}`)
        }
        detail(`dependencies: ${JSON.stringify(dependencies)}`)
        return `dsh-oh-my-whale -> ${String(dependencies['dsh-oh-my-whale'])}; memory via file: override`
      })

      step('dump-config', () => {
        const result = run(`dsh --profile ${PROFILE_NAME} --dump-config`, workRoot, env)
        assertCommand(result, 'dsh --profile <p> --dump-config')
        const output = `${result.stdout}\n${result.stderr}`
        const matches = output
          .split(/\r?\n/)
          .filter((line) => line.includes('dsh-oh-my-whale'))
          .slice(0, 12)
        detail(`dump-config matches: ${matches.join(' | ')}`)
        if (!output.includes('dsh-oh-my-whale-memory')) {
          throw new Error('--dump-config 输出未包含 dsh-oh-my-whale-memory')
        }
        return 'contains dsh-oh-my-whale-memory'
      })

      step('remove:no-residual', () => {
        const before = readJson(profileManifestPath)
        detail(`dependencies before remove: ${JSON.stringify(before.dependencies ?? {})}`)
        assertCommand(
          run(`dsh plugin --profile ${PROFILE_NAME} remove dsh-oh-my-whale`, workRoot, env),
          'dsh plugin remove dsh-oh-my-whale',
        )
        const after = readJson(profileManifestPath)
        const dependencies = after.dependencies ?? {}
        detail(`dependencies after remove: ${JSON.stringify(dependencies)}`)
        detail(`bundles after remove: ${JSON.stringify(after.dsh?.profile?.bundles ?? [])}`)
        const linkDependencies = Object.entries(dependencies)
          .filter(([, value]) => String(value).startsWith('link:'))
          .map(([name, value]) => `${name}=${String(value)}`)
        if (linkDependencies.length > 0) {
          throw new Error(`remove 后 dependencies 仍有 link: 条目：${linkDependencies.join('、')}`)
        }
        return 'no link: dependencies'
      })
    }
  }
} catch (error) {
  exitCode = 1
  if (!(error instanceof SmokeFailure)) {
    log(`[publish-smoke] FAIL ${error instanceof Error ? error.message : String(error)}`)
  }
} finally {
  const keep = process.env.OMW_SMOKE_KEEP === '1'
  if (keep) {
    log(`[step] ${'cleanup'.padEnd(STEP_WIDTH)} ok   keep=${workRoot}`)
  } else {
    try {
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      log(`[step] ${'cleanup'.padEnd(STEP_WIDTH)} ok   removed temp DSH_HOME`)
    } catch (error) {
      log(`[step] ${'cleanup'.padEnd(STEP_WIDTH)} FAIL ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
  }

  // NFR9 / 矩阵行 13：日志不得出现凭据形态。
  const secret = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/u.exec(lines.join('\n'))
  if (secret !== null) {
    log(`[step] ${'secret-scan'.padEnd(STEP_WIDTH)} FAIL 日志疑似含真实凭据（${secret[0].slice(0, 6)}…）`)
    exitCode = 1
  } else {
    log(`[step] ${'secret-scan'.padEnd(STEP_WIDTH)} ok   no sk- credential literal`)
  }

  log(`[publish-smoke] ${exitCode === 0 ? 'PASS' : 'FAIL'} log=${logPath}`)
  process.exit(exitCode)
}

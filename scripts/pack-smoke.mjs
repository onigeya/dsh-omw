// AD-35 发布形态冒烟：pnpm pack 两包，再按 AC:1145 的精确集合断言 tarball 内容。P1-R12。
// 判定逻辑与 scripts/publish-smoke.mjs 共用 scripts/lib/tarball-expectations.mjs，避免两套断言漂移。
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TARBALL_SPECS,
  describeTarballFailures,
  evaluateTarball,
  tarballSummary,
} from './lib/tarball-expectations.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' })
const list = (tar) => run('tar -tf "' + tar + '"', root).split(/\r?\n/).filter(Boolean)

const workdirs = []
const failures = []
try {
  for (const [label, spec] of Object.entries(TARBALL_SPECS)) {
    // 每个包用独立目录：两包文件名前缀重叠，分目录可避免选错 tarball。
    const out = mkdtempSync(join(tmpdir(), `omw-pack-${label}-`))
    workdirs.push(out)
    try {
      run('pnpm pack --pack-destination "' + out + '"', join(root, spec.dir))
      const tars = readdirSync(out).filter((name) => name.endsWith('.tgz'))
      if (tars.length !== 1) {
        failures.push(`${label}: 预期 1 个 tarball，实际 ${String(tars.length)} 个`)
        continue
      }
      const result = evaluateTarball(label, list(join(out, tars[0])))
      failures.push(...describeTarballFailures(result))
      if (result.ok) {
        console.log(`  ok   ${label} tarball ${String(result.entries.length)} 项（${tarballSummary(result)}）`)
      }
    } catch (error) {
      failures.push(`${label}: pnpm pack 失败 → ${(error.stderr || error.message).toString().slice(0, 300)}`)
    }
  }
} finally {
  for (const dir of workdirs) rmSync(dir, { recursive: true, force: true })
}
for (const failure of failures) console.log('  FAIL ' + failure)
console.log(failures.length ? 'pack:smoke: FAIL' : 'pack:smoke: PASS')
process.exit(failures.length ? 1 : 0)

// AD-35 发布形态冒烟：pnpm pack 两包 → 断言 tarball 内容。P1-R12。
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'omw-pack-'))
const failures = []
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' })
const list = (tar) => run('tar -tf "' + tar + '"', root).split(/\r?\n/).filter(Boolean)

const packages = [
  ['packages/dsh-oh-my-whale', 'bundle', ['cordis.patch.yml', 'lib/index.js', 'package.json']],
  ['packages/dsh-oh-my-whale-memory', 'memory', ['lib/index.js', 'lib/types/index.d.ts', 'package.json']],
]
for (const [dir, label, required] of packages) {
  try {
    const outText = run('pnpm pack --pack-destination "' + out + '"', join(root, dir))
    const name = /Tarball contents|package:\s*([^\s]+\.tgz)/.exec(outText)
    const tars = readdirSync(out).filter((f) => f.endsWith('.tgz'))
    const pkgName = label === 'bundle' ? 'dsh-oh-my-whale' : 'dsh-oh-my-whale-memory'
    const mine = tars.find((f) => f.startsWith(pkgName + '-') && (label === 'memory' ? f.includes('-memory-') : !f.includes('-memory-')))
    if (!mine) { failures.push(label + ': 未找到 tarball'); continue }
    const entries = list(join(out, mine))
    for (const r of required) if (!entries.some((e) => e === r || e.endsWith('/' + r))) failures.push(label + ': tarball 缺 ' + r)
    if (label === 'memory' && entries.some((e) => e.includes('cordis.patch.yml'))) failures.push('memory: tarball 不应含 cordis.patch.yml')
    if (label === 'bundle' && !entries.some((e) => e.endsWith('cordis.patch.yml'))) failures.push('bundle: tarball 缺 cordis.patch.yml')
    if (entries.some((e) => e.startsWith('src/') || e.includes('/src/'))) failures.push(label + ': tarball 不应含 src')
    if (entries.some((e) => e.includes('/test/'))) failures.push(label + ': tarball 不应含 test')
    console.log('  ok   ' + label + ' tarball ' + entries.length + ' 项')
  } catch (e) {
    failures.push(label + ': pnpm pack 失败 → ' + (e.stderr || e.message).toString().slice(0, 300))
  }
}
rmSync(out, { recursive: true, force: true })
for (const f of failures) console.log('  FAIL ' + f)
console.log(failures.length ? 'pack:smoke: FAIL' : 'pack:smoke: PASS')
process.exit(failures.length ? 1 : 0)

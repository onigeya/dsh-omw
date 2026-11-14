// 包元数据与导出契约门禁（AD-33 / AD-35 / PRD §14）。P1-R9。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundleDir = join(root, 'packages/dsh-oh-my-whale')
const memDir = join(root, 'packages/dsh-oh-my-whale-memory')
const failures = [], oks = []
const fail = (m) => failures.push(m), ok = (m) => oks.push(m)
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'))
const rootPkg = rj(join(root, 'package.json'))
const bundle = rj(join(bundleDir, 'package.json'))
const mem = rj(join(memDir, 'package.json'))

if (rootPkg.private !== true) fail('root: private 必须为 true'); else ok('root private')
if (rootPkg.packageManager !== 'pnpm@12.18.0') fail('root: packageManager 应为 pnpm@12.18.0'); else ok('root packageManager')
if (bundle.name !== 'dsh-oh-my-whale') fail('bundle 包名必须为 dsh-oh-my-whale')
if (mem.name !== 'dsh-oh-my-whale-memory') fail('memory 包名必须为 dsh-oh-my-whale-memory')
if (bundle.private === true || mem.private === true) fail('两包不得 private'); else ok('包名锁定 / 可发布')
if (bundle.version !== mem.version) fail('两包版本必须一致'); else ok('两包版本一致')

for (const [pkg, label] of [[bundle, 'bundle'], [mem, 'memory']]) {
  if (pkg.main !== 'lib/index.js') fail(label + ': main 应为 lib/index.js')
  const ex = pkg.exports || {}
  if (!ex['.']) fail(label + ': exports 缺 "."')
  if (!ex['./package.json']) fail(label + ': exports 缺 "./package.json"')
  const files = pkg.files || []
  if (!files.includes('lib/index.js')) fail(label + ': files 缺 lib/index.js')
}
const bFiles = bundle.files || []
if (!bFiles.includes('cordis.patch.yml')) fail('bundle: files 缺 cordis.patch.yml')
if (bundle.dsh?.bundle?.patch !== './cordis.patch.yml') fail('bundle: 缺 dsh.bundle.patch')
if (!(mem.files || []).includes('lib/types')) fail('memory: files 缺 lib/types')
ok('main / exports / files')

for (const d of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-atomic-write', '@ladybugdb/core']) {
  if (!mem.dependencies?.[d]) fail('memory: ' + d + ' 必须在 dependencies')
}
if (!/^~0\.22\./.test(mem.dependencies?.['@ladybugdb/core'] || '')) fail('@ladybugdb/core 必须锁 ~0.22.x')
else ok('@ladybugdb/core 版本锁')
const pc = mem.peerDependencies?.['@deepseek-ai/cordis'], dc = mem.devDependencies?.['@deepseek-ai/cordis']
if (!pc || !dc) fail('memory: cordis 必须在 peer + dev')
else if (pc !== dc) fail('memory: cordis peer/dev 范围不一致')
else ok('cordis peer+dev 同范围')
if (!mem.optionalDependencies?.['@ladybugdb/wasm-core']) fail('memory: wasm-core 必须在 optionalDependencies')
else ok('wasm optionalDependency')

for (const [pkg, label] of [[bundle, 'bundle'], [mem, 'memory']]) {
  const m = /(\d+)\.(\d+)/.exec(pkg.engines?.node || '')
  if (!m || Number(m[1]) * 100 + Number(m[2]) > 2409) fail(label + ': engines.node 必须 >= 24.9')
  if (pkg.engines?.dsh !== '>=0.2.0 <0.3.0') fail(label + ': engines.dsh 应为 ">=0.2.0 <0.3.0"')
}
ok('engines.node / engines.dsh')

const indexSrc = readFileSync(join(memDir, 'src/index.ts'), 'utf8')
// 命名导出形态由 test/entry-exports.test.ts 钉死；此处不重复实现正则。
const all = []
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) all.push(p) } }
walk(join(memDir, 'src'))
const defs = all.filter((p) => /export\s+default\b/.test(readFileSync(p, 'utf8')))
if (defs.length) fail('function 插件禁 default export：' + defs.join(', ')); else ok('无 default export')
for (const f of ['src/db/schema.ts', 'src/db/audit.ts', 'src/db/backend.ts']) {
  try { readFileSync(join(memDir, f)); ok(f) } catch { fail('缺 ' + f) }
}
for (const m of oks) console.log('  ok   ' + m)
for (const m of failures) console.log('  FAIL ' + m)
console.log(failures.length ? 'constraints: ' + failures.length + ' 项失败' : 'constraints: PASS（' + oks.length + ' 项）')
process.exit(failures.length ? 1 : 0)

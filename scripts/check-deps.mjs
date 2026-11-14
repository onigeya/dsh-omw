// AD-33 依赖方向与循环门禁。例外清单随 AD-33 冻结；新增违规必须先登记。P1-R9/R10。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = join(root, 'packages/dsh-oh-my-whale-memory/src')
const DOMAIN = ['capture', 'inbox', 'distill', 'wiki', 'recall', 'embedding', 'strategy', 'context', 'ontology']
const KERNEL = ['db', 'config.ts']
const SURFACES = ['tools', 'command.ts', 'summarize.ts']
const EXCEPTIONS = [
  ['db/database.ts', 'inbox/queue.ts'],
  ['distill/llm-refine.ts', 'tools/memory-remember.ts'],
  ['distill/processor.ts', 'tools/memory-remember.ts'],
  ['distill/promotion.ts', 'tools/memory-remember.ts'],
]
const CYCLE_BASELINE = []

const files = []
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p) } }
walk(src)
const rel = (p) => relative(src, p).replaceAll('\\', '/')
const top = (p) => { const r = rel(p); const i = r.indexOf('/'); return i === -1 ? r : r.slice(0, i) }
const layer = (p) => KERNEL.includes(top(p)) ? 'kernel' : DOMAIN.includes(top(p)) ? 'domain' : SURFACES.includes(top(p)) ? 'surface' : 'other'
const isEx = (f, t) => EXCEPTIONS.some(([a, b]) => (f === a || f.endsWith('/' + a)) && (t === b || t.endsWith('/' + b)))

const re = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g
const edges = [], violations = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  let m
  while ((m = re.exec(text))) {
    const base = resolve(dirname(f), m[1])
    const tsBase = base.endsWith('.js') ? base.slice(0, -3) + '.ts' : base
    const cand = [base, base + '.ts', tsBase, join(base, 'index.ts')].find((c) => { try { return statSync(c).isFile() } catch { return false } })
    if (!cand) continue
    const f0 = rel(f), t0 = rel(cand)
    edges.push([f0, t0])
    if (layer(f) === 'kernel' && layer(cand) === 'domain' && !isEx(f0, t0)) violations.push('kernel->domain: ' + f0 + ' -> ' + t0)
    if (layer(f) === 'domain' && layer(cand) === 'surface' && !isEx(f0, t0)) violations.push('domain->surface: ' + f0 + ' -> ' + t0)
  }
}
const adj = new Map(files.map((f) => [rel(f), []]))
for (const [a, b] of edges) adj.get(a)?.push(b)
let idxN = 0
const idx = new Map(), low = new Map(), on = new Set(), stack = [], sccs = []
const strong = (v) => {
  idx.set(v, idxN); low.set(v, idxN); idxN++; stack.push(v); on.add(v)
  for (const w of adj.get(v) || []) {
    if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))) }
    else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []
    let w
    do { w = stack.pop(); on.delete(w); comp.push(w) } while (w !== v)
    if (comp.length > 1 || (adj.get(v) || []).includes(v)) sccs.push(comp.sort())
  }
}
for (const f of adj.keys()) if (!idx.has(f)) strong(f)
const base = JSON.stringify(CYCLE_BASELINE)
const fresh = sccs.filter((c) => !base.includes(c[0]) || !base.includes(c[c.length - 1]))
console.log('扫描 ' + files.length + ' 文件 / ' + edges.length + ' 相对 import 边')
console.log('分层违规：' + violations.length)
for (const v of violations) console.log('  FAIL ' + v)
console.log('循环 SCC：' + sccs.length + (fresh.length ? '（新增 ' + fresh.length + '）' : ''))
for (const c of sccs) console.log('  ' + (fresh.includes(c) ? 'FAIL ' : 'warn ') + c.join(' -> '))
const bad = violations.length > 0 || fresh.length > 0
console.log(bad ? 'check-deps: FAIL' : 'check-deps: PASS')
process.exit(bad ? 1 : 0)

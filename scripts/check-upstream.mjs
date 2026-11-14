// AD-12 的 0.23 触发器 + 后端版本监测（P3-R20）。
// 每周跑一次；0.23 稳定版出现即失败并提示「移除单写者锁 / 只读降级」的复开条件。
const CORE = 'https://registry.npmjs.org/@ladybugdb%2Fcore'
const WASM = 'https://registry.npmjs.org/@ladybugdb%2Fwasm-core'

async function tags(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status)
  return (await r.json())['dist-tags'] || {}
}

const core = await tags(CORE)
const wasm = await tags(WASM)
const latest = core.latest || ''
const wasmLatest = wasm.latest || ''
console.log('core latest = ' + latest + ' ; wasm latest = ' + wasmLatest)

const m = /^(\d+)\.(\d+)\.(\d+)/.exec(latest)
if (!m) { console.log('upstream-watch: FAIL 无法解析 core latest'); process.exit(1) }
const major = Number(m[1]), minor = Number(m[2])

let bad = false
if (major > 0 || minor > 22) {
  console.log('upstream-watch: ACTION REQUIRED — @ladybugdb/core 已到 ' + latest)
  console.log('  AD-12 复开条件：v0.23+ 正式发布 → 单独立 PR 移除单写者文件锁与只读降级；')
  console.log('  AD-3 复开条件：核 breaking 清单 + Windows ABI + RRF/FTS/vector 三扩展回归。')
  bad = true
} else if (minor === 22) {
  console.log('upstream-watch: ok — 仍在 0.22.x，锁版本不变')
} else {
  console.log('upstream-watch: WARN — latest 低于 0.22（registry 回退？）')
}
if (wasmLatest && wasmLatest !== latest) {
  console.log('upstream-watch: FAIL wasm-core latest (' + wasmLatest + ') 与 core (' + latest + ') 不一致')
  bad = true
}
console.log(bad ? 'upstream-watch: FAIL' : 'upstream-watch: PASS')
process.exit(bad ? 1 : 0)

#!/usr/bin/env node
/**
 * 逐文件覆盖率门禁（Story 5.2 / AC:1227-1229 的落地形态）。
 *
 * AC 的字面要求是「100% per-file coverage」。实测当前是 76 个源文件、语句 97.14%、
 * 分支 89.73%（见 Story 5.2 spec 的 deferred 第 1 项），一步到 100% 需要补数百条
 * 断言且分支 100% 通常是不可达分支的伪目标。本脚本因此实现**逐文件 ratchet**：
 *
 * - 每个源文件的 `lines.pct` 与 `branches.pct` 都必须 **不低于** `scripts/coverage-baseline.json`
 *   里记录的值（容差 1e-2，吸收 v8 统计的抖动）——下降即失败，不比全局平均；
 * - 摘要里出现但基线里没有的文件 ⇒ 失败（新文件必须补测后 `--update` 登记，不许裸奔）；
 * - 基线里有的文件在摘要里消失（被删/改名）⇒ 只记一条 `note`，不失败；
 * - `--update` 用当前摘要重写基线（**只应在补测之后跑**；CI 永不传它）。
 *
 * 用法：
 *   node scripts/coverage-gate.mjs              # 门禁（CI / 本地）
 *   node scripts/coverage-gate.mjs --update     # 补测后登记新基线
 *   node scripts/coverage-gate.mjs --self-test  # 用三组合成数据自检判定逻辑（CI 先跑）
 *   node scripts/coverage-gate.mjs --summary=coverage/coverage-summary.json --baseline=scripts/coverage-baseline.json
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const METRICS = ['lines', 'branches']
const EPSILON = 0.01

function parseFlag(argv, name, fallback) {
  const flag = argv.find((arg) => arg.startsWith(`--${name}=`))
  return flag === undefined ? fallback : flag.slice(name.length + 3)
}

const argv = process.argv.slice(2)
const summaryPath = resolve(ROOT, parseFlag(argv, 'summary', 'coverage/coverage-summary.json'))
const baselinePath = resolve(ROOT, parseFlag(argv, 'baseline', 'scripts/coverage-baseline.json'))

/** 绝对路径 → 仓库相对的 posix 路径（基线与摘要都用同一形态比较）。 */
function relativeKey(root, file) {
  const normalized = resolve(file)
  const prefix = resolve(root) + sep
  const rel = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
  return rel.replaceAll('\\', '/')
}

/** 把 vitest 的 coverage-summary 归一成 `{ 文件 → {lines, branches} }`。 */
export function normalizeSummary(root, summary) {
  const files = {}
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue
    files[relativeKey(root, file)] = {
      lines: Number(metrics?.lines?.pct ?? 0),
      branches: Number(metrics?.branches?.pct ?? 0),
    }
  }
  return files
}

/**
 * 纯判定：返回 `{ failures, notes }`。不做 I/O，便于 `--self-test` 覆盖。
 * @param {Record<string, {lines:number, branches:number}>} current
 * @param {Record<string, {lines:number, branches:number}>} baseline
 */
export function compareCoverage(current, baseline) {
  const failures = []
  const notes = []
  for (const [file, metrics] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
    const recorded = baseline[file]
    if (recorded === undefined) {
      failures.push(`${file}: 基线未登记（新文件必须补测后用 --update 登记）`)
      continue
    }
    for (const metric of METRICS) {
      const now = Number(metrics[metric] ?? 0)
      const before = Number(recorded[metric] ?? 0)
      if (now + EPSILON < before) {
        failures.push(`${file}: ${metric} ${now.toFixed(2)}% < 基线 ${before.toFixed(2)}%`)
      }
    }
  }
  for (const file of Object.keys(baseline)) {
    if (current[file] === undefined) notes.push(`${file}: 基线有、当前摘要无（文件被删或改名）`)
  }
  return { failures, notes }
}

/** 自检：三组合成数据，判定必须分别 PASS / FAIL(低于基线) / FAIL(新文件)。 */
function selfTest() {
  const baseline = {
    'src/a.ts': { lines: 100, branches: 90 },
    'src/b.ts': { lines: 80, branches: 60 },
  }
  const cases = [
    {
      name: 'all-at-or-above-baseline',
      current: { 'src/a.ts': { lines: 100, branches: 90 }, 'src/b.ts': { lines: 80, branches: 60.5 } },
      expectOk: true,
    },
    {
      name: 'regression-below-baseline',
      current: { 'src/a.ts': { lines: 100, branches: 89.9 }, 'src/b.ts': { lines: 80, branches: 60 } },
      expectOk: false,
      expectText: 'branches 89.90% < 基线 90.00%',
    },
    {
      name: 'new-file-not-registered',
      current: { 'src/a.ts': { lines: 100, branches: 90 }, 'src/c.ts': { lines: 100, branches: 100 } },
      expectOk: false,
      expectText: 'src/c.ts: 基线未登记',
    },
  ]
  let failed = 0
  for (const testCase of cases) {
    const { failures } = compareCoverage(testCase.current, baseline)
    const ok = failures.length === 0
    const matched = testCase.expectText === undefined || failures.some((line) => line.includes(testCase.expectText))
    if (ok === testCase.expectOk && matched) {
      console.log(`  ok   self-test ${testCase.name}`)
    } else {
      failed += 1
      console.log(`  FAIL self-test ${testCase.name}：期望 ok=${String(testCase.expectOk)}，实际 ${JSON.stringify(failures)}`)
    }
  }
  console.log(failed === 0 ? 'coverage-gate: self-test PASS（3/3）' : `coverage-gate: self-test FAIL（${failed}/3）`)
  return failed === 0 ? 0 : 1
}

function readJson(path, label) {
  if (!existsSync(path)) {
    console.error(`coverage-gate: FAIL 缺 ${label}：${path}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

if (argv.includes('--self-test')) {
  process.exit(selfTest())
}

const current = normalizeSummary(ROOT, readJson(summaryPath, 'coverage-summary.json'))

if (argv.includes('--update')) {
  const sorted = Object.fromEntries(
    Object.entries(current).sort(([a], [b]) => a.localeCompare(b)).map(([file, metrics]) => [
      file,
      { lines: Number(metrics.lines.toFixed(2)), branches: Number(metrics.branches.toFixed(2)) },
    ]),
  )
  // 单调性守卫（评审 STATUS52 第 3 条）：`--update` 只能抬高基线。如果这次更新会把某个文件的
  // lines/branches **调低**，说明是「补测前先降基线」——直接拒绝，除非显式 `--force-lower`
  //（供「文件真的被删除/重命名后重建基线」这类人工场景使用；CI 永不传任何 update 参数）。
  const previous = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {})
    : {}
  const lowered = []
  for (const [file, metrics] of Object.entries(sorted)) {
    const before = previous[file]
    if (before === undefined) continue
    for (const metric of METRICS) {
      const now = Number(metrics[metric])
      const was = Number(before[metric] ?? 0)
      if (now + EPSILON < was) lowered.push(`${file}: ${metric} ${now.toFixed(2)}% < 已有基线 ${was.toFixed(2)}%`)
    }
  }
  if (lowered.length > 0 && !argv.includes('--force-lower')) {
    for (const line of lowered) console.log(`  FAIL ${line}`)
    console.log(
      `coverage-gate: 拒绝降低基线（${lowered.length} 处）。先补测，或确属文件删除/改名时用 --force-lower 显式重建。`,
    )
    process.exit(1)
  }
  writeFileSync(baselinePath, JSON.stringify({ generatedAt: new Date().toISOString(), files: sorted }, null, 2) + '\n', 'utf8')
  console.log(`coverage-gate: 基线已更新（${Object.keys(sorted).length} 文件）→ ${baselinePath}`)
  process.exit(0)
}

const baseline = readJson(baselinePath, 'coverage-baseline.json').files ?? {}
const { failures, notes } = compareCoverage(current, baseline)
for (const note of notes) console.log(`  note ${note}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
const totals = Object.values(current).reduce(
  (acc, metrics) => ({ lines: acc.lines + metrics.lines, branches: acc.branches + metrics.branches, n: acc.n + 1 }),
  { lines: 0, branches: 0, n: 0 },
)
const avg = (value) => (totals.n === 0 ? 0 : value / totals.n)
console.log(
  `coverage-gate: 逐文件 ratchet ${failures.length === 0 ? 'PASS' : 'FAIL'}` +
  `（${totals.n} 文件，均值 lines ${avg(totals.lines).toFixed(2)}% / branches ${avg(totals.branches).toFixed(2)}%）`,
)
process.exit(failures.length === 0 ? 0 : 1)

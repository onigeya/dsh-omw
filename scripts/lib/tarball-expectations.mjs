/**
 * AD-35 / AC:1145 的 tarball 精确集合判定（`pack-smoke` 与 `publish-smoke` 共用）。
 *
 * 判定形态：`tar -tf` 条目去掉 npm 的 `package/` 前缀后，**减去** npm 恒打包的
 * `package.json` 与包内**实际存在的** `README*` / `LICENSE*`，剩余集合必须恰好等于
 * 发布形态允许的集合。允许集合用 glob 表达（`.d.ts` 不写死文件名）：
 * - bundle（`dsh-oh-my-whale`）：`cordis.patch.yml` + `lib/index.js` + `lib/**\/*.d.ts`；
 * - memory（`dsh-oh-my-whale-memory`）：`lib/*.js`（入口 + rolldown 的共享 chunk）+
 *   `lib/types/**`。多入口构建会把共享模块拆成 `lib/<name>-<hash>.js`，所以不能只允许
 *   两个入口文件（Story 8.3 收口发现：只白名单两个入口 ⇒ tarball 缺 chunk ⇒ 装完即崩）。
 * 两边都显式拒绝 `src/`、`test/`、`node_modules/` 与非 `.d.ts` 的 `.ts`，失败时点名条目。
 *
 * 这是纯函数模块：不读文件、不 spawn，两个脚本各自负责 `pnpm pack` 与输出格式。
 */

/** 两个发布包的精确允许集合与必需锚点。 */
export const TARBALL_SPECS = {
  bundle: {
    packageName: 'dsh-oh-my-whale',
    dir: 'packages/dsh-oh-my-whale',
    allowed: [
      { pattern: /^cordis\.patch\.yml$/, label: 'cordis.patch.yml' },
      { pattern: /^lib\/index\.js$/, label: 'lib/index.js' },
      { pattern: /^lib\/(?:.+\/)?[^/]+\.d\.ts$/, label: 'lib/**/*.d.ts' },
    ],
    required: [
      { pattern: /^cordis\.patch\.yml$/, label: 'cordis.patch.yml' },
      { pattern: /^lib\/index\.js$/, label: 'lib/index.js' },
      { pattern: /^lib\/(?:.+\/)?[^/]+\.d\.ts$/, label: 'lib/**/*.d.ts' },
    ],
  },
  memory: {
    packageName: 'dsh-oh-my-whale-memory',
    dir: 'packages/dsh-oh-my-whale-memory',
    allowed: [
      { pattern: /^lib\/[^/]+\.js$/, label: 'lib/*.js（入口 + 共享 chunk）' },
      { pattern: /^lib\/types\/.+/, label: 'lib/types/**' },
    ],
    required: [
      { pattern: /^lib\/index\.js$/, label: 'lib/index.js' },
      { pattern: /^lib\/types\/.+/, label: 'lib/types/**' },
    ],
  },
}

/** npm 恒打包 / 允许缺席的顶层元数据；README/LICENSE 只在包里真有该文件时出现。 */
const METADATA_PATTERNS = [/^package\.json$/, /^README[^/]*$/i, /^LICEN[CS]E[^/]*$/i]

/** 任何发布包都不得出现的目录（即使 glob 意外放宽也必须拦）。 */
const FORBIDDEN_DIRS = [
  { pattern: /^src\//, label: 'src/' },
  { pattern: /^test\//, label: 'test/' },
  { pattern: /^node_modules\//, label: 'node_modules/' },
]

/** 非 `.d.ts` 的 `.ts` 一律不得入包（含 memory 的 `lib/types/**`）。 */
const TS_SOURCE = /\.ts$/
const TS_DECLARATION = /\.d\.ts$/

/** 把 `tar -tf` 原始行规整成包内相对路径（去 `package/` 前缀、统一 `/`、丢目录行）。 */
export function normalizeTarEntries(rawEntries) {
  return rawEntries
    .map((line) => String(line).trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replaceAll('\\', '/'))
    .map((line) => (line.startsWith('package/') ? line.slice('package/'.length) : line))
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'))
}

/** 是否是允许缺席的顶层元数据（`package.json` / `README*` / `LICENSE*`）。 */
export function isTarballMetadata(entry) {
  return METADATA_PATTERNS.some((pattern) => pattern.test(entry))
}

/**
 * 判定一个包的 tarball 条目列表。
 *
 * @param {'bundle' | 'memory'} label 包角色。
 * @param {readonly string[]} rawEntries `tar -tf` 的原始输出行。
 * @returns 结构化判定结果；`ok === true` 才表示精确集合成立。
 */
export function evaluateTarball(label, rawEntries) {
  const spec = TARBALL_SPECS[label]
  if (spec === undefined) throw new Error(`未知包角色：${String(label)}`)

  const entries = normalizeTarEntries(rawEntries)
  const metadata = entries.filter((entry) => isTarballMetadata(entry))
  const payload = entries.filter((entry) => !isTarballMetadata(entry))

  const unexpected = payload.filter((entry) => !spec.allowed.some(({ pattern }) => pattern.test(entry)))
  const missing = spec.required
    .filter(({ pattern }) => !payload.some((entry) => pattern.test(entry)))
    .map(({ label: required }) => required)

  const forbidden = []
  for (const entry of payload) {
    const dir = FORBIDDEN_DIRS.find(({ pattern }) => pattern.test(entry))
    if (dir !== undefined) {
      forbidden.push({ entry, reason: dir.label })
    } else if (TS_SOURCE.test(entry) && !TS_DECLARATION.test(entry)) {
      forbidden.push({ entry, reason: '非 .d.ts 的 .ts' })
    }
  }

  return {
    label,
    packageName: spec.packageName,
    entries,
    metadata,
    payload,
    unexpected,
    missing,
    forbidden,
    ok: unexpected.length === 0 && missing.length === 0 && forbidden.length === 0,
  }
}

/** 把失败项渲染成一行一条的要点（成功时返回空数组）。 */
export function describeTarballFailures(result) {
  const failures = []
  if (result.missing.length > 0) {
    failures.push(`${result.label}: 缺必需条目 ${result.missing.join('、')}`)
  }
  if (result.unexpected.length > 0) {
    failures.push(`${result.label}: 多出条目 ${result.unexpected.join('、')}`)
  }
  for (const { entry, reason } of result.forbidden) {
    failures.push(`${result.label}: 禁止条目 ${entry}（${reason}）`)
  }
  return failures
}

/** 断言成功时使用的短摘要，两脚本共用同一措辞。 */
export function tarballSummary(result) {
  return `exact-match(after package.json/README/LICENSE) ${result.entries.length} entries`
}

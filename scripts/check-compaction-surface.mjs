/**
 * INV-11 / AC:1691 / AC:1703 的漂移锁：**只许依赖压缩后端的公共面**。
 *
 * 两条硬规则（任一违反即红）：
 * 1. 不得 import `@deepseek-ai/dsh-compaction-basic` 的**深路径**（`/lib/...`、`/src/...`）——
 *    那是实现细节，升级就会断；只允许包根（公共面）。
 * 2. 不得 import `region` 模块（AC:1691 明文：发布形态不可达，区间选择必须自写）。
 *
 * 为什么单独一个门禁而不是写在 `check-deps.mjs`：后者管的是**本仓分层**（AD-33），
 * 这里管的是**对上游实现的依赖面**（AD-27 的漂移锁），两者的红/绿判据不同，混在一起会难定位。
 *
 * 用法：`node scripts/check-compaction-surface.mjs`（被 `pnpm verify` 调用）。
 *
 * **刻意不写 shebang**：本模块被 `test/compaction-surface-gate.test.ts` 直接 import 做自检，
 * 而 Vite/vitest 的 SSR transform 不剥 shebang，首行 `#!` 会让整个套件以
 * `SyntaxError: Invalid or unexpected token` 失败（Story 8.4 T8 实测）。门禁一律经 `node` 调用，
 * shebang 对本文件没有作用。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SRC_ROOTS = ['packages/dsh-oh-my-whale/src', 'packages/dsh-oh-my-whale-memory/src']

/** 提取一条 import/export-from 的模块说明符（静态 import 与 export … from 都算）。 */
export function extractSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1])
    }
  }
  return specifiers
}

/**
 * 判定单个说明符是否违规。返回 null = 合规；否则返回违规原因。
 * 纯函数，便于单测（不需要真的存在这些文件）。
 */
export function classifySpecifier(specifier) {
  // 规则 1：压缩后端的深路径（先判，因为深路径里也可能带 region，报告更具体的原因）。
  const deep = /^@deepseek-ai\/dsh-compaction-basic\/(lib|src)\//.exec(specifier)
  if (deep !== null) {
    return 'imports dsh-compaction-basic deep path (INV-11: public surface only)'
  }
  // 规则 2：任何指向 region 模块的 import（AC:1691）。
  if (/(^|\/)region(\.js|\.ts)?$/.test(specifier)) {
    return 'imports region module (AC:1691 forbids it)'
  }
  return null
}

function walk(dir, files = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

export function checkSources(roots = SRC_ROOTS) {
  const violations = []
  let files = 0
  let specifiers = 0
  for (const root of roots) {
    for (const file of walk(join(ROOT, root))) {
      files += 1
      const source = readFileSync(file, 'utf8')
      for (const specifier of extractSpecifiers(source)) {
        specifiers += 1
        const reason = classifySpecifier(specifier)
        if (reason !== null) violations.push({ file: relative(ROOT, file), specifier, reason })
      }
    }
  }
  return { files, specifiers, violations }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())
if (isMain) {
  const result = checkSources()
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`  ✗ ${violation.file}: ${violation.specifier} — ${violation.reason}`)
    }
    console.error(`check-compaction-surface: FAIL（${result.violations.length} 处违规）`)
    process.exit(1)
  }
  console.log(`check-compaction-surface: PASS（${result.files} 文件 / ${result.specifiers} 说明符，压缩后端公共面之外零依赖）`)
}

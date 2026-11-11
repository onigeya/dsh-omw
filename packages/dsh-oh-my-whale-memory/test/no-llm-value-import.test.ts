/**
 * 源码级依赖纪律（Story 2.3 / N1 / 评审 T22）。
 *
 * `@deepseek-ai/dsh-llm` 是 devDependency：运行期**只能**使用它的类型，
 * 任何值 import（含 `await import('@deepseek-ai/dsh-llm')`）都会让构建产物在外部 profile
 * 里解析不到该模块。允许 `import type …` 与「全部 specifier 都带 type 前缀」的内联写法。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const MODULE = '@deepseek-ai/dsh-llm'
// ^ + m：只从行首的 import 开始匹配，避免把注释里提到的 "import `@deepseek-ai/dsh-llm`" 吞进来。
const IMPORT_STATEMENT = /^import\s+([^;]*?)\s+from\s*['"]@deepseek-ai\/dsh-llm['"]/gms
const DYNAMIC_IMPORT = /import\s*\(\s*['"]@deepseek-ai\/dsh-llm['"]\s*\)/g

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

/** `import type …` 或 `import { type A, type B } …` 都算只引入类型。 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim()
  if (/^type\b/.test(trimmed)) return true
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  const parts = trimmed.slice(1, -1).split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  return parts.length > 0 && parts.every((part) => /^type\b/.test(part))
}

describe('运行期不 import 宿主的 llm 值（N1 / 评审 T22）', () => {
  it('src 下引用 dsh-llm 的每处 import 都是纯类型引入', async () => {
    const files = await listTsFiles(SRC_DIR)
    const violations: string[] = []
    const typeImportFiles: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      if (!text.includes(MODULE)) continue
      const clauses = [...text.matchAll(IMPORT_STATEMENT)].map((match) => match[1] ?? '')
      const dynamic = [...text.matchAll(DYNAMIC_IMPORT)]
      if (clauses.length === 0 && dynamic.length === 0) continue // 只出现在注释里
      if (dynamic.length > 0 || !clauses.every(isTypeOnlyClause)) violations.push(file)
      else typeImportFiles.push(file)
    }
    expect(violations).toEqual([])
    // 反向自检：这条断言不能因为「一处都没扫到」而空过。
    expect(typeImportFiles.length).toBeGreaterThan(0)
  })
})

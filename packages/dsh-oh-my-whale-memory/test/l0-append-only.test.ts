/**
 * L0 仍只追加（Story 4.2 / AC:1064、AD-4）。
 *
 * 静态断言：redact 是 AD-4 唯一的 append-only 例外，且只能有一处实现。
 * 这条测试防的是「后续 story 顺手在采集/精炼/回填里 UPDATE 一下 L0 原文」——那种改动
 * 不会有任何现有真库用例变红，却会悄悄破坏「L0 是原始事实源」的前提。
 *
 * 断言面是**剥掉注释后的源码文本**（注释里讨论 DELETE/UPDATE 不算违规）：
 * - 允许的改写只有 `src/db/redact.ts` 的 `SET <alias>.raw_text = …`；
 * - 其余任何 `SET <alias>.raw_text` 都算改写（别名匹配 `\w+`，不再只认 `l`）；
 * - 任何含 `l0_raw` 的语句段里出现 `DELETE` 都算物理删行（先按 `;` 切分再压缩空白，
 *   所以跨行拼接的语句也能命中）。
 *
 * 已知边界：Cypher 的 map 合并写法（`SET l += {raw_text: …}`）在文本层面看不出「写的是
 * raw_text 列」，本测试检不出；别名必须是 `<ident>.raw_text` 才能匹配。真要堵住它得靠
 * AST 级检查（本期没有），所以这里显式登记边界，而不是假装覆盖。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(import.meta.dirname, '..')
const SOURCE_ROOTS = [
  join(PACKAGE_ROOT, 'src'),
  join(PACKAGE_ROOT, '..', 'dsh-oh-my-whale', 'src'),
]

interface SourceFile {
  readonly path: string
  readonly rel: string
  readonly code: string
}

/** 去掉块注释与行注释：只对「代码」断言，避免文档里的 DELETE/UPDATE 造成误报。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = []
  for (const root of SOURCE_ROOTS) {
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts')) continue
      const path = join(root, file)
      out.push({
        path,
        rel: relative(PACKAGE_ROOT, path).replace(/\\/g, '/'),
        code: stripComments(readFileSync(path, 'utf8')),
      })
    }
  }
  return out
}

/** 按语句切分（`;`）并压缩空白：字符串拼接出来的跨行 Cypher 落进同一个片段。 */
function statements(code: string): string[] {
  return code.split(';').map((part) => part.replace(/\s+/g, ' ').trim())
}

describe('AC:1064：L0 写路径仍是 append-only', () => {
  it('只有 src/db/redact.ts 改写 l0_raw.raw_text（唯一豁免，别名通配）', () => {
    const mutators = sourceFiles()
      .filter((file) => {
        // 允许 `ON CREATE SET <alias>.raw_text = …`（append-only 的建行）；其余 SET 一律算改写。
        const pattern = /SET\s+\w+\.raw_text/g
        for (let match = pattern.exec(file.code); match !== null; match = pattern.exec(file.code)) {
          const before = file.code.slice(Math.max(0, match.index - 24), match.index)
          if (!/ON CREATE\s*$/.test(before)) return true
        }
        return false
      })
      .map((file) => file.rel)
    expect(mutators).toEqual(['src/db/redact.ts'])
  })

  it('任何含 l0_raw 的语句段都不含 DELETE（跨行拼接也能命中）', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      for (const statement of statements(file.code)) {
        if (!statement.includes('l0_raw')) continue
        if (/\bDELETE\b/i.test(statement)) offenders.push(file.rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('db/l0.ts 的写入原语仍是 MERGE ... ON CREATE SET（零 UPDATE）', () => {
    const l0 = readFileSync(join(PACKAGE_ROOT, 'src', 'db', 'l0.ts'), 'utf8')
    expect(l0).toContain('ON CREATE SET l.raw_text = $raw_text')
    expect(l0).not.toMatch(/SET\s+\w+\.raw_text\s*=\s*\$[a-z_]+[^\n]*ON MATCH/)
    expect(stripComments(l0)).not.toMatch(/UPDATE\s+l0_raw/i)
  })

  it('redact 的改写带 redacted_at IS NULL 守卫（只允许一次）', () => {
    const redact = readFileSync(join(PACKAGE_ROOT, 'src', 'db', 'redact.ts'), 'utf8')
    expect(redact).toContain('WHERE l.redacted_at IS NULL AND l.raw_text IS NOT NULL')
    expect(redact).toContain('SET l.raw_text = $tombstone, l.redacted_by = $actor, l.redacted_at = $ts')
  })
})

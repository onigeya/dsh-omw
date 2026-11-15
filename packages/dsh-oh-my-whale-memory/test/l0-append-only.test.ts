/**
 * L0 仍只追加（Story 4.2 / AC:1064、AD-4）。
 *
 * 静态断言：redact 是 AD-4 唯一的 append-only 例外，且只能有一处实现。
 * 这条测试防的是「后续 story 顺手在采集/精炼/回填里 UPDATE 一下 L0 原文」——那种改动
 * 不会有任何现有真库用例变红，却会悄悄破坏「L0 是原始事实源」的前提。
 *
 * 断言面是源码文本（不是运行行为）：允许的改写只有 `src/db/redact.ts` 的
 * `SET l.raw_text = …`；其余任何 `SET l.…` / `DELETE` 打 l0_raw 的地方都必须为零。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(SRC, file))
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

/** 相对路径（断言失败时的可读性；Windows 上统一成 `/`）。 */
function rel(file: string): string {
  return relative(SRC, file).replace(/\\/g, '/')
}

describe('AC:1064：L0 写路径仍是 append-only', () => {
  it('只有 src/db/redact.ts 会写 l0_raw.raw_text（唯一豁免）', () => {
    const mutators = sourceFiles()
      .filter((file) => {
        const text = read(file)
        // 允许 `ON CREATE SET l.raw_text = …`（append-only 的建行）；其余 SET 一律算改写。
        const pattern = /SET\s+l\.raw_text/g
        for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
          const before = text.slice(Math.max(0, match.index - 12), match.index)
          if (!/ON CREATE\s*$/.test(before)) return true
        }
        return false
      })
      .map(rel)
    expect(mutators).toEqual(['db/redact.ts'])
  })

  it('没有任何 source 对 l0_raw 发 DELETE', () => {
    const deleters = sourceFiles()
      .filter((file) => {
        const text = read(file)
        // 只看含 l0_raw 的语句文本；注释里出现 DELETE 的讨论不算。
        return /DELETE[^\n]*l0_raw|l0_raw[^\n]*DELETE/i.test(text) &&
          !/l0_raw[^\n]*不删|不删[^\n]*l0_raw/.test(text)
      })
      .map(rel)
    expect(deleters).toEqual([])
  })

  it('db/l0.ts 的写入原语仍是 MERGE ... ON CREATE SET（零 UPDATE）', () => {
    const l0 = read(join(SRC, 'db', 'l0.ts'))
    expect(l0).toContain('ON CREATE SET l.raw_text = $raw_text')
    expect(l0).not.toMatch(/SET\s+l\.raw_text\s*=\s*\$[a-z_]+[^\n]*ON MATCH/)
    // 代码里不得出现对 l0_raw 的 UPDATE（注释里说明「没有 UPDATE」不算）。
    expect(l0).not.toMatch(/UPDATE\s+l0_raw/i)
  })

  it('redact 的改写带 redacted_at IS NULL 守卫（只允许一次）', () => {
    const redact = read(join(SRC, 'db', 'redact.ts'))
    expect(redact).toContain('WHERE l.redacted_at IS NULL AND l.raw_text IS NOT NULL')
    expect(redact).toContain('SET l.raw_text = $tombstone, l.redacted_by = $actor, l.redacted_at = $ts')
  })
})

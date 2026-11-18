/**
 * 本体加载（Story 9.2）：路径解析、缺失/损坏 fail-open、未配置 off。
 */
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadOntology, loadOntologyFile, resolveOntologyPath } from '../src/ontology/load'

const TTL = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <https://e.test#> .
ex:Person a owl:Class .
`

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omw-ontology-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  // 临时目录由系统回收；不删除以保留失败现场（测试约定同其它真库用例）。
})

describe('resolveOntologyPath', () => {
  it('未配置/空白 ⇒ null；相对路径相对 profile；绝对路径原样', () => {
    expect(resolveOntologyPath('/p', undefined)).toBeNull()
    expect(resolveOntologyPath('/p', '  ')).toBeNull()
    expect(resolveOntologyPath('/p', 'memory/ontology.ttl')).toBe(join('/p', 'memory/ontology.ttl'))
    const absolute = join(tempDir(), 'x.ttl')
    expect(resolveOntologyPath('/p', absolute)).toBe(absolute)
  })
})

describe('loadOntology / loadOntologyFile', () => {
  it('合法文件 ⇒ 索引 + entries + path', () => {
    const dir = tempDir()
    const path = join(dir, 'ontology.ttl')
    writeFileSync(path, TTL, 'utf8')
    const result = loadOntology(dir, 'ontology.ttl')
    expect(result.ok).toBe(true)
    if (result.ok && result.value !== null) {
      expect(result.value.path).toBe(path)
      expect(result.value.index.hasEntityType('person')).toBe(true)
      expect(result.value.entries).toHaveLength(1)
    }
  })

  it('未配置 ⇒ ok + value null（off 是合法状态）', () => {
    const result = loadOntology(tempDir(), undefined)
    expect(result).toEqual({ ok: true, value: null })
  })

  it('文件缺失 / 损坏 ⇒ ok:false + reason + path（不静默当空本体；status 可见路径）', () => {
    const missingPath = join(tempDir(), 'nope.ttl')
    const missing = loadOntologyFile(missingPath)
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.reason).toContain('不可读')
      expect(missing.path).toBe(missingPath)
    }
    const dir = tempDir()
    const broken = join(dir, 'broken.ttl')
    writeFileSync(broken, '<<< not turtle', 'utf8')
    const result = loadOntologyFile(broken)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.path).toBe(broken)
    }
  })

  it('矩阵行 8：加载是纯只读（不改本体文件、不写任何新文件）', () => {
    const dir = tempDir()
    const path = join(dir, 'ontology.ttl')
    writeFileSync(path, TTL, 'utf8')
    const before = { size: statSync(path).size, mtimeMs: statSync(path).mtimeMs, files: readdirSync(dir).sort() }
    expect(loadOntology(dir, 'ontology.ttl').ok).toBe(true)
    const after = { size: statSync(path).size, mtimeMs: statSync(path).mtimeMs, files: readdirSync(dir).sort() }
    expect(after).toEqual(before)
  })
})

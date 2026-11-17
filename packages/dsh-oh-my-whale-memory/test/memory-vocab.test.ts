/**
 * 分类词汇表（Story 11.4 / T1、T3）：规范值 `user_portrait`、legacy 输入别名、读路径别名。
 */
import { describe, expect, it } from 'vitest'
import {
  LEGACY_USER_PORTRAIT_KIND,
  MEMORY_KINDS,
  USER_PORTRAIT_KIND,
  canonicalizeMemoryKind,
  isMemoryKind,
  isUserPortraitKind,
  normalizeMemoryKind,
} from '../src/shared/memory-vocab'

describe('MEMORY_KINDS（T1）', () => {
  it('含规范值 user_portrait，不含 legacy persona', () => {
    expect(MEMORY_KINDS).toContain(USER_PORTRAIT_KIND)
    expect(MEMORY_KINDS).not.toContain(LEGACY_USER_PORTRAIT_KIND as never)
    expect(isMemoryKind('user_portrait')).toBe(true)
    expect(isMemoryKind('persona')).toBe(false)
  })

  it('isUserPortraitKind：规范值与 legacy 别名都算逻辑画像；其它不算', () => {
    expect(isUserPortraitKind('user_portrait')).toBe(true)
    expect(isUserPortraitKind('persona')).toBe(true)
    expect(isUserPortraitKind('episodic')).toBe(false)
    expect(isUserPortraitKind(undefined)).toBe(false)
  })
})

describe('normalizeMemoryKind / canonicalizeMemoryKind（T3）', () => {
  it('输入边界：persona → user_portrait；规范值原样；未知 → 空串', () => {
    expect(normalizeMemoryKind('persona')).toBe('user_portrait')
    expect(normalizeMemoryKind('user_portrait')).toBe('user_portrait')
    expect(normalizeMemoryKind('episodic')).toBe('episodic')
    expect(normalizeMemoryKind('nonsense')).toBe('')
    expect(normalizeMemoryKind(undefined)).toBe('')
  })

  it('写库/读路径：只改 persona，handle 等非七类值原样保留', () => {
    expect(canonicalizeMemoryKind('persona')).toBe('user_portrait')
    expect(canonicalizeMemoryKind('user_portrait')).toBe('user_portrait')
    expect(canonicalizeMemoryKind('handle')).toBe('handle')
  })
})

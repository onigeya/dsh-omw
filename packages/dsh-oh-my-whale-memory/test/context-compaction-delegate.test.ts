/**
 * 压缩引擎运行态裁决（Story 8.3 / AC:1683、AC:1675、NFR19）。
 *
 * 纯函数、0 开库。钉住三件事：① 覆盖缺口优先于只读（不得用"只读所以委托"掩盖缺口）；
 * ② 只有 `own` 允许写；③ status 标签 `readOnly-delegate` 逐字。
 */
import { describe, expect, it } from 'vitest'
import {
  allowsCompactionWrites,
  compactionModeLabel,
  requiresOverlayWarning,
  resolveCompactionMode,
} from '../src/context/compaction-delegate'

describe('运行模式裁决（AC:1683）', () => {
  it('写者实例 + 引擎已装 ⇒ own', () => {
    expect(resolveCompactionMode({ readonly: false, engineInstalled: true })).toBe('own')
  })

  it('只读实例 + 引擎已装 ⇒ delegate-stock（委托，而不是"不装配"）', () => {
    expect(resolveCompactionMode({ readonly: true, engineInstalled: true })).toBe('delegate-stock')
  })

  it('引擎没装上 ⇒ missing，即使实例只读（缺口不能被只读掩盖，AC:1675/NFR19）', () => {
    expect(resolveCompactionMode({ readonly: false, engineInstalled: false })).toBe('missing')
    expect(resolveCompactionMode({ readonly: true, engineInstalled: false })).toBe('missing')
  })
})

describe('写权限与告警', () => {
  it('只有 own 允许写：delegate-stock 与 missing 都不写（AD-12 零写入）', () => {
    expect(allowsCompactionWrites('own')).toBe(true)
    expect(allowsCompactionWrites('delegate-stock')).toBe(false)
    expect(allowsCompactionWrites('missing')).toBe(false)
  })

  it('只有 missing 需要覆盖缺口告警', () => {
    expect(requiresOverlayWarning('own')).toBe(false)
    expect(requiresOverlayWarning('delegate-stock')).toBe(false)
    expect(requiresOverlayWarning('missing')).toBe(true)
  })
})

describe('status 标签', () => {
  it('delegate-stock 的标签逐字是 readOnly-delegate（AC:1683 原文）', () => {
    expect(compactionModeLabel('delegate-stock')).toBe('readOnly-delegate')
    expect(compactionModeLabel('own')).toBe('own')
    expect(compactionModeLabel('missing')).toBe('missing')
  })
})

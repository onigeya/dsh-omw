/**
 * 注入预算裁剪测试（Story 3.3 / B3；纯函数，0 开库）。
 *
 * 钉住 AC:932-935 的三限制与 INV-2：
 * - ① 单条 ≤1200 字符先裁（标 `…`）；② 条数 ≤20；③ 总长 ≤8000（摘要 + 证据合计）；
 * - 截断后剩余 <40 字符的条目不注入；自然短条目（<40 但未截断）保留；
 * - 不可删集合（`priority=-1` / `kind=instruction`）先全部保留、不占名额、不受三限制，
 *   超预算时 `overBudget:true`；
 * - 顺序：摘要（原则）开头 → 证据跟随；不可删集合排在证据最前。
 */
import { describe, expect, it } from 'vitest'
import {
  INJECTION_ELLIPSIS,
  INJECTION_MAX_ITEMS,
  INJECTION_MAX_ITEM_CHARS,
  INJECTION_MAX_TOTAL_CHARS,
  applyInjectionBudget,
  isInviolableItem,
  type InjectionDraft,
} from '../src/injection/budget'
import type { RecallResultItem } from '../src/recall/core'

function item(id: string, text: string, overrides: Partial<RecallResultItem> = {}): RecallResultItem {
  return { id, layer: 'L1', kind: 'work_fact', priority: 0, text, ...overrides }
}

const EMPTY: InjectionDraft = { evidence: [], l1: [], inviolable: [] }

describe('applyInjectionBudget：三限制边界', () => {
  it('空 draft ⇒ 无注入（text 空、chars 0、overBudget false）', () => {
    const result = applyInjectionBudget(EMPTY)
    expect(result.text).toBe('')
    expect(result.items).toHaveLength(0)
    expect(result.chars).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.overBudget).toBe(false)
    expect(result.keptInviolable).toBe(0)
  })

  it(`① 单条 >${INJECTION_MAX_ITEM_CHARS} 字符先裁：正文含 ${INJECTION_ELLIPSIS}、truncated=true`, () => {
    const result = applyInjectionBudget({
      ...EMPTY,
      l1: [item('long', 'x'.repeat(2000))],
    })
    expect(result.truncated).toBe(true)
    expect(result.items[0]?.truncated).toBe(true)
    expect(result.items[0]?.text.length).toBe(INJECTION_MAX_ITEM_CHARS)
    expect(result.items[0]?.text.endsWith(INJECTION_ELLIPSIS)).toBe(true)
    expect(result.chars).toBe(INJECTION_MAX_ITEM_CHARS)
  })

  it(`② 条数 ≤${INJECTION_MAX_ITEMS}：25 条只保留 20 条`, () => {
    const items = Array.from({ length: 25 }, (_, index) => item(`i${String(index).padStart(2, '0')}`, 'x'.repeat(10)))
    const result = applyInjectionBudget({ ...EMPTY, l1: items })
    expect(result.items).toHaveLength(INJECTION_MAX_ITEMS)
    expect(result.truncated).toBe(true)
  })

  it(`③ 总长 ≤${INJECTION_MAX_TOTAL_CHARS}：10×1000 字符被裁到预算内`, () => {
    const items = Array.from({ length: 10 }, (_, index) => item(`j${String(index).padStart(2, '0')}`, 'y'.repeat(1000)))
    const result = applyInjectionBudget({ ...EMPTY, l1: items })
    expect(result.truncated).toBe(true)
    expect(result.chars).toBeLessThanOrEqual(INJECTION_MAX_TOTAL_CHARS)
    expect(result.chars + result.items.length * 0).toBeGreaterThan(0)
  })

  it('④ 预算剩余 <40 字符时不追加碎片条目（已入列的短条正常保留）', () => {
    // 6×1200 = 7200，再加 770 ⇒ 7970 满额附近，剩余 30 < 40。
    const nearlyFull = Array.from({ length: 6 }, (_, index) => item(`k${index}`, 'w'.repeat(1200)))
    const exact = applyInjectionBudget({
      ...EMPTY,
      l1: [...nearlyFull, item('leftover', 'w'.repeat(770)), item('fragment2', 'w'.repeat(100))],
    })
    expect(exact.chars).toBe(7970)
    expect(exact.truncated).toBe(true)
    expect(exact.items.some((entry) => entry.id === 'leftover')).toBe(true)
    expect(exact.items.some((entry) => entry.id === 'fragment2')).toBe(false)

    // 自然短条目（未截断）保留：<40 规则只针对"预算裁出的碎片"。
    const short = applyInjectionBudget({ ...EMPTY, l1: [item('tiny', '短记忆')] })
    expect(short.items).toHaveLength(1)
    expect(short.truncated).toBe(false)
  })
})

describe('applyInjectionBudget：INV-2 不可删集合', () => {
  it('不可删集合先全部保留、不占 20 名额；其字符占用可删集合的剩余额度', () => {
    const pinned = item('pin', 'p'.repeat(100), { priority: -1 })
    const instruction = item('instr', '规则', { kind: 'instruction' })
    const result = applyInjectionBudget({
      ...EMPTY,
      inviolable: [pinned, instruction],
      l1: Array.from({ length: 25 }, (_, index) => item(`l${index}`, 'x'.repeat(10))),
    })

    expect(result.keptInviolable).toBe(2)
    expect(result.items.find((entry) => entry.id === 'pin')?.text).toHaveLength(100)
    expect(result.items.find((entry) => entry.id === 'instr')?.text).toBe('规则')
    // 不可删集合不占 20 条名额：仍保留 20 条可删。
    expect(result.items.filter((entry) => !entry.inviolable)).toHaveLength(INJECTION_MAX_ITEMS)
    expect(result.chars).toBe(100 + 2 + 20 * 10)
    expect(result.overBudget).toBe(false)
  })

  it('不可删集合本身超预算 ⇒ 全部保留 + overBudget=true（可删集合无额度可用）', () => {
    const pinned = item('pin', 'p'.repeat(9000), { priority: -1 })
    const result = applyInjectionBudget({
      ...EMPTY,
      inviolable: [pinned],
      l1: [item('l1', 'x'.repeat(10))],
    })

    expect(result.items.find((entry) => entry.id === 'pin')?.text).toHaveLength(9000)
    expect(result.items.find((entry) => entry.id === 'pin')?.truncated).toBe(false)
    expect(result.overBudget).toBe(true)
    expect(result.chars).toBe(9000)
    expect(result.items.some((entry) => entry.id === 'l1')).toBe(false)
  })

  it('isInviolableItem：priority=-1 或 kind=instruction', () => {
    expect(isInviolableItem(item('a', 'x', { priority: -1 }))).toBe(true)
    expect(isInviolableItem(item('b', 'x', { kind: 'instruction' }))).toBe(true)
    expect(isInviolableItem(item('c', 'x', { priority: 0, kind: 'work_fact' }))).toBe(false)
  })

  it('同 id 同时出现在 inviolable 与 l1：只渲染一次（不可删优先）', () => {
    const shared = item('dup', 'x'.repeat(10))
    const result = applyInjectionBudget({
      ...EMPTY,
      inviolable: [shared],
      l1: [shared, item('other', 'y'.repeat(5))],
    })
    expect(result.items.filter((entry) => entry.id === 'dup')).toHaveLength(1)
    expect(result.items.find((entry) => entry.id === 'dup')?.inviolable).toBe(true)
  })
})

describe('applyInjectionBudget：渲染顺序（原则开头 / 证据跟随）', () => {
  it('摘要在前、相关证据在后；不可删集合排证据最前', () => {
    const result = applyInjectionBudget({
      summary: '用户偏好 ESM。',
      evidence: [item('l2-1', '原则陈述', { layer: 'L2' })],
      l1: [item('l1-1', '证据原文')],
      inviolable: [item('pin', '全局规则', { priority: -1 })],
    })

    const lines = result.text.split('\n')
    expect(lines[0]).toBe('记忆摘要（开局注入）：')
    expect(lines[1]).toBe('用户偏好 ESM。')
    expect(result.text).toContain('相关证据：')
    // 不可删集合出现在第一条证据行；随后 L2、L1。
    const evidenceLines = lines.filter((line) => line.startsWith('- ['))
    expect(evidenceLines[0]).toContain('[L1] pin')
    expect(evidenceLines[1]).toContain('[L2] l2-1')
    expect(evidenceLines[2]).toContain('[L1] l1-1')
    expect(result.chars).toBe('用户偏好 ESM。'.length + '原则陈述'.length + '证据原文'.length + '全局规则'.length)
  })

  it('无摘要（L1-only 降级）⇒ 「相关记忆（开局注入）」头', () => {
    const result = applyInjectionBudget({ ...EMPTY, l1: [item('l1-1', '证据原文')] })
    expect(result.text.startsWith('相关记忆（开局注入）：')).toBe(true)
  })
})

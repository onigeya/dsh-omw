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
import {
  INJECTION_DEFAULT_RATIO,
  INJECTION_WARNING_PRESSURE_EXHAUSTED,
  INJECTION_WARNING_RATIO_INVALID,
  computeInjectionBudget,
  truncateToTokenCap,
} from '../src/recall/injection-budget'
import { estimateTokens } from '../src/shared/text-budget'
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

  it('① 预算按 code point 计：代理对（emoji）不被 UTF-16 length 提前截断或放大 chars', () => {
    const result = applyInjectionBudget({
      ...EMPTY,
      l1: [item('emoji', '😀'.repeat(2000))],
    })
    const body = result.items[0]?.text ?? ''
    // 1199 个 emoji + 省略号 = 1200 个 code point（UTF-16 length 是 2399，不能拿它计预算）。
    expect(Array.from(body)).toHaveLength(INJECTION_MAX_ITEM_CHARS)
    expect(body.endsWith(INJECTION_ELLIPSIS)).toBe(true)
    expect(result.chars).toBe(INJECTION_MAX_ITEM_CHARS)
    expect(result.overBudget).toBe(false)
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
    // 6×1200 = 7200，再加 770，7970 满额附近，剩余 30 < 40。
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

describe('Story 7.1 / AC:1369-1372：persona 恒置顶且永不因预算被裁', () => {
  it('预算耗尽（可删集合全被裁掉）时 persona 仍在注入集内，且是首条', () => {
    // 单个 persona 条目 + 30 条超量可删条目：可删集合会被 20 条上限与 8000 字符总长同时裁掉。
    const persona = item('persona-1', '我偏好先看证据再下结论', { kind: 'persona', priority: -1 })
    const result = applyInjectionBudget({
      ...EMPTY,
      inviolable: [persona],
      l1: Array.from({ length: 30 }, (_, index) => item(`l${index}`, 'x'.repeat(500))),
    })

    // persona 在注入集里、未被截断、排在最前（FR-16 的二次加权）。
    expect(result.keptInviolable).toBe(1)
    const first = result.items[0]
    expect(first?.id).toBe('persona-1')
    expect(first?.inviolable).toBe(true)
    expect(first?.truncated).toBe(false)
    expect(first?.text).toBe('我偏好先看证据再下结论')
    // 注入文本里确实出现，且出现在任何可删条目之前。
    const lines = result.text.split('\n')
    const personaLine = lines.findIndex((line) => line.includes('我偏好先看证据再下结论'))
    expect(personaLine).toBeGreaterThanOrEqual(0)
    expect(lines.slice(0, personaLine).some((line) => line.startsWith('- ['))).toBe(false)
  })

  it('可删集合被 20 条上限裁掉时，persona 仍不被计入名额', () => {
    const persona = item('persona-2', '我禁止自动提交', { kind: 'persona', priority: -1 })
    const result = applyInjectionBudget({
      ...EMPTY,
      inviolable: [persona],
      l1: Array.from({ length: 25 }, (_, index) => item(`d${index}`, 'y'.repeat(10))),
    })

    expect(result.items.filter((entry) => entry.inviolable)).toHaveLength(1)
    expect(result.items.filter((entry) => !entry.inviolable)).toHaveLength(INJECTION_MAX_ITEMS)
    expect(result.items[0]?.id).toBe('persona-2')
  })
})

/**
 * Story 8.5 / T1：`computeInjectionBudget` 的 I/O 矩阵 1–7（AC:1826-1832、AD-25）。
 * 单位一律 tokens；窗口/压力来自宿主 `tokenMeter.contextPressure()`，上限来自 Config。
 */
describe('computeInjectionBudget：矩阵 1–7（tokens 口径）', () => {
  const BASE = {
    contextWindow: 128_000,
    pressureTokens: 100_000,
    injectionTokenCap: 4096,
    ratio: 0.5,
    singleCap: 512,
    summaryCap: 512,
  } as const

  it('矩阵 1：contextWindow 缺失 ⇒ 预算 = injectionTokenCap（不假设窗口大小）', () => {
    for (const contextWindow of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const budget = computeInjectionBudget({ ...BASE, contextWindow })
      expect(budget.budget).toBe(BASE.injectionTokenCap)
      expect(budget.warnings).toEqual([])
    }
  })

  it('矩阵 2：pressureTokens >= contextWindow ⇒ 预算 0 + 可见 warning（含相等与越界）', () => {
    for (const pressureTokens of [128_000, 200_000]) {
      const budget = computeInjectionBudget({ ...BASE, pressureTokens })
      expect(budget.budget).toBe(0)
      expect(budget.warnings).toEqual([INJECTION_WARNING_PRESSURE_EXHAUSTED])
    }
  })

  it('矩阵 3：ratio 为负 ⇒ 预算 0 + 可见 warning（即使窗口有余额）', () => {
    const budget = computeInjectionBudget({ ...BASE, ratio: -0.5 })
    expect(budget.budget).toBe(0)
    expect(budget.warnings).toEqual([INJECTION_WARNING_RATIO_INVALID])
  })

  it('矩阵 3 补：ratio 非有限值同样是「非法」而不是静默按缺省值算', () => {
    const budget = computeInjectionBudget({ ...BASE, ratio: Number.NaN })
    expect(budget.budget).toBe(0)
    expect(budget.warnings).toEqual([INJECTION_WARNING_RATIO_INVALID])
  })

  it('矩阵 4：ratio 未配置 ⇒ 0.5', () => {
    expect(INJECTION_DEFAULT_RATIO).toBe(0.5)
    const budget = computeInjectionBudget({ ...BASE, contextWindow: 20_000, pressureTokens: 10_000, ratio: undefined })
    // 0.5 × (20000 − 10000) = 5000 → 仍受 cap 4096 约束，故用更小的窗口验证 0.5 本身。
    expect(budget.budget).toBe(BASE.injectionTokenCap)
    const small = computeInjectionBudget({ ...BASE, contextWindow: 4000, pressureTokens: 1000, ratio: undefined })
    expect(small.budget).toBe(1500)
  })

  it('矩阵 5：计算结果为负/极小时夹到 0（max(0, ·)）', () => {
    const tiny = computeInjectionBudget({ ...BASE, contextWindow: 4000, pressureTokens: 3999, ratio: 0.5 })
    expect(tiny.budget).toBe(0)
    expect(tiny.warnings).toEqual([])
    const zeroRatio = computeInjectionBudget({ ...BASE, ratio: 0 })
    expect(zeroRatio.budget).toBe(0)
  })

  it('矩阵 6：单条 / 摘要各自被自己的绝对上限截断（互不代替）', () => {
    const long = '很长的一段记忆正文。'.repeat(500)
    const single = truncateToTokenCap(long, 100)
    expect(single.truncated).toBe(true)
    expect(single.text.endsWith(INJECTION_ELLIPSIS)).toBe(true)
    expect(estimateTokens(single.text)).toBeLessThanOrEqual(100)

    const summary = truncateToTokenCap(long, 40)
    expect(summary.truncated).toBe(true)
    expect(estimateTokens(summary.text)).toBeLessThanOrEqual(40)

    // 未超限不动（不白加省略号）
    const short = truncateToTokenCap('短记忆', 40)
    expect(short).toEqual({ text: '短记忆', truncated: false })
    // 上限 0 ⇒ 空串（预算耗尽，不产出碎片）
    expect(truncateToTokenCap('短记忆', 0)).toEqual({ text: '', truncated: true })
  })

  it('矩阵 7：window 极大 ⇒ 仍不超 injectionTokenCap', () => {
    const budget = computeInjectionBudget({ ...BASE, contextWindow: 10_000_000, pressureTokens: 0 })
    expect(budget.budget).toBe(BASE.injectionTokenCap)
  })

  it('单条 / 摘要上限原样透传（并折成非负整数）', () => {
    const budget = computeInjectionBudget({ ...BASE, singleCap: 300, summaryCap: 200 })
    expect(budget.singleCap).toBe(300)
    expect(budget.summaryCap).toBe(200)
    const broken = computeInjectionBudget({ ...BASE, singleCap: -1, summaryCap: Number.NaN })
    expect(broken.singleCap).toBe(0)
    expect(broken.summaryCap).toBe(0)
  })

  it('不抛错：全字段 NaN/Infinity/负数也只返回预算与告警', () => {
    expect(() => computeInjectionBudget({
      contextWindow: Number.NaN,
      pressureTokens: -5,
      injectionTokenCap: Number.NaN,
      ratio: Number.POSITIVE_INFINITY,
      singleCap: Number.NaN,
      summaryCap: -10,
    })).not.toThrow()
    const budget = computeInjectionBudget({
      contextWindow: 1000,
      pressureTokens: Number.NaN,
      injectionTokenCap: 100,
      ratio: 0.5,
      singleCap: 10,
      summaryCap: 10,
    })
    // 压力非法按 0 处理：0.5 × 1000 = 500 → cap 100。
    expect(budget.budget).toBe(100)
    expect(budget.warnings).toEqual([])
  })
})

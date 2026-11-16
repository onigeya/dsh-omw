/**
 * 折叠判定与执行（Story 8.2 第 3 轮 / AC:1607-1614、INV-3、INV-7）。
 *
 * 覆盖：阈值内不折叠、超阈值折成句柄块且写图、写图失败 fail-open（返回原文 + note）、
 * seq 幂等由 write 侧保证（这里用假 writer 验证「只调用一次」）、readOnly 不折叠。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FOLD_THRESHOLD_TOKENS,
  estimateTokens,
  foldIfOversized,
  shouldFoldInReadonly,
  foldToolResult,
} from '../src/context/fold'
import { parseHandle } from '../src/context/handle'

function makeWriter(id = 'h-1') {
  return vi.fn(async () => ({ id }))
}

describe('折叠判定（AC:1607-1614）', () => {
  it('阈值内 ⇒ 原样返回、不写图', async () => {
    const write = makeWriter()
    const outcome = await foldIfOversized({
      text: '短结果',
      sessionId: 's-1',
      seq: 1,
      thresholdTokens: 2000,
      write,
    })
    expect(outcome.folded).toBe(false)
    expect(outcome.text).toBe('短结果')
    expect(outcome.handle).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('超阈值 ⇒ 折成句柄块、全文交给 write、表面只剩句柄', async () => {
    const write = makeWriter('h-42')
    const text = 'x'.repeat(10_000) // ≈5000 tokens > 2000
    const outcome = await foldIfOversized({ text, sessionId: 's-1', seq: 7, thresholdTokens: 2000, write })
    expect(outcome.folded).toBe(true)
    expect(outcome.handle).toBe('h-42')
    expect(outcome.text).toBe('[omw:handle=h-42 ~5000 tokens]')
    expect(parseHandle(outcome.text)?.id).toBe('h-42')
    // 全文入图（不是截断后的片段）
    const passed = write.mock.calls[0]?.[0] as { text: string, tokens: number, seq: number, sessionId: string }
    expect(passed.text).toBe(text)
    expect(passed.tokens).toBe(5000)
    expect(passed.seq).toBe(7)
    expect(passed.sessionId).toBe('s-1')
  })

  it('写图失败 ⇒ fail-open：原文返回、note=write-failed、只调一次', async () => {
    const warn = vi.fn()
    const write = vi.fn(async () => {
      throw new Error('db down')
    })
    const text = 'y'.repeat(10_000)
    const outcome = await foldIfOversized({ text, sessionId: 's-1', seq: 9, thresholdTokens: 2000, write, logger: { warn } })
    expect(outcome.folded).toBe(false)
    expect(outcome.text).toBe(text)
    expect(outcome.note).toBe('write-failed')
    expect(warn).toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('阈值非法（0/负数/NaN）⇒ 用默认值（2000），不会退化成「全部折叠」', async () => {
    const write = makeWriter()
    const text = 'z'.repeat(100) // 50 tokens
    for (const thresholdTokens of [0, -5, Number.NaN]) {
      const outcome = await foldIfOversized({ text, sessionId: 's', seq: 1, thresholdTokens, write })
      expect(outcome.folded).toBe(false)
    }
    expect(DEFAULT_FOLD_THRESHOLD_TOKENS).toBe(2000)
    expect(write).not.toHaveBeenCalled()
  })

  it('estimateTokens：1 token ≈ 2 字符（上取整）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('ab')).toBe(1)
    expect(estimateTokens('abc')).toBe(2)
    expect(estimateTokens('x'.repeat(4001))).toBe(2001)
  })
})

describe('readOnly 不折叠（INV-7）', () => {
  it('只读实例 ⇒ shouldFoldInReadonly=false', () => {
    expect(shouldFoldInReadonly(true)).toBe(false)
    expect(shouldFoldInReadonly(false)).toBe(true)
  })

  it('只读实例：超阈值也原样返回，且**不调用** write（INV-7 可执行断言）', async () => {
    const write = makeWriter()
    const text = 'w'.repeat(10_000)
    const outcome = await foldToolResult({ text, sessionId: 's-1', seq: 1, thresholdTokens: 2000, write, readonly: true })
    expect(outcome.folded).toBe(false)
    expect(outcome.text).toBe(text)
    expect(outcome.note).toBe('readonly')
    expect(write).not.toHaveBeenCalled()
  })

  it('非只读：走正常折叠路径（同一入口）', async () => {
    const write = makeWriter('h-rw')
    const outcome = await foldToolResult({ text: 'v'.repeat(10_000), sessionId: 's-1', seq: 2, thresholdTokens: 2000, write, readonly: false })
    expect(outcome.folded).toBe(true)
    expect(outcome.handle).toBe('h-rw')
  })
})

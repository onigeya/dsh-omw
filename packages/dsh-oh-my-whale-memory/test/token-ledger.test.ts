/**
 * token 触发账本（Story 10.1 / AC:2026、矩阵行 4–6）。纯函数，0 开库。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TOKEN_LEDGER,
  formatTokenLedgerState,
  parseTokenLedgerState,
  planTrigger,
  sumNewTokens,
  tokenLedgerMetaKey,
  type TokenLedgerThresholds,
} from '../src/capture/token-ledger'

const T: TokenLedgerThresholds = { captureTokens: 8000, captureMinTokens: 500, captureMaxTokens: 32000 }

describe('sumNewTokens', () => {
  it('只统计 seq > lastSeq 的节点；tokens 优先、缺失用 heuristicTokens', () => {
    const nodes = [
      { seq: 0, tokens: 999 }, // 已计入（lastSeq=0）
      { seq: 1, tokens: 100 },
      { seq: 2, heuristicTokens: 50 },
      { seq: 3, tokens: null, heuristicTokens: 25 },
    ]
    expect(sumNewTokens(nodes, 0)).toEqual({ tokens: 175, maxSeq: 3 })
  })

  it('非法节点跳过；负值按 0', () => {
    expect(sumNewTokens([{ seq: 1, tokens: -5 }, { seq: Number.NaN as unknown as number, tokens: 10 }], -1)).toEqual({ tokens: 0, maxSeq: 1 })
  })
})

describe('planTrigger（矩阵行 4–6）', () => {
  it('累计 < captureMinTokens ⇒ 不触发，累计保留、lastSeq 前进', () => {
    const decision = planTrigger(EMPTY_TOKEN_LEDGER, [{ seq: 1, tokens: 100 }], T)
    expect(decision.triggered).toBe(false)
    expect(decision.state).toEqual({ lastSeq: 1, pendingTokens: 100 })
  })

  it('两次小累计跨边界求和后达到软阈值 ⇒ 触发并清零', () => {
    const first = planTrigger(EMPTY_TOKEN_LEDGER, [{ seq: 1, tokens: 4000 }], T)
    expect(first.triggered).toBe(false)
    const second = planTrigger(first.state, [{ seq: 2, tokens: 4000 }], T)
    expect(second.triggered).toBe(true)
    expect(second.state).toEqual({ lastSeq: 2, pendingTokens: 0 })
  })

  it('超过硬上限仍触发并标 oversize（不切碎单事件）', () => {
    const decision = planTrigger(EMPTY_TOKEN_LEDGER, [{ seq: 1, tokens: 40000 }], T)
    expect(decision.triggered).toBe(true)
    expect(decision.oversize).toBe(true)
  })

  it('forceFlush：compaction/start 无视阈值触发（哪怕只累计 1 token）', () => {
    const state = { lastSeq: 0, pendingTokens: 0 }
    const decision = planTrigger(state, [{ seq: 1, tokens: 1 }], T, { forceFlush: true })
    expect(decision.triggered).toBe(true)
    expect(decision.forced).toBe(true)
    expect(decision.state).toEqual({ lastSeq: 1, pendingTokens: 0 })
  })

  it('forceFlush 且没有新 token ⇒ 不触发（无内容可写）', () => {
    const decision = planTrigger({ lastSeq: 5, pendingTokens: 0 }, [{ seq: 5, tokens: 9000 }], T, { forceFlush: true })
    expect(decision.triggered).toBe(false)
  })

  it('同一批 nodes 连续两次调用不会重复计（lastSeq 已推进）', () => {
    const nodes = [{ seq: 1, tokens: 6000 }]
    const first = planTrigger(EMPTY_TOKEN_LEDGER, nodes, T)
    const second = planTrigger(first.state, nodes, T)
    expect(second.triggered).toBe(false)
    expect(second.state.pendingTokens).toBe(6000)
  })
})

describe('omw_meta 键与序列化', () => {
  it('往返一致；缺键/畸形 ⇒ 空账本', () => {
    const key = tokenLedgerMetaKey('s1')
    expect(key).toBe('capture_token_ledger:s1')
    const state = { lastSeq: 7, pendingTokens: 1234 }
    expect(parseTokenLedgerState(formatTokenLedgerState(state))).toEqual(state)
    expect(parseTokenLedgerState(null)).toEqual(EMPTY_TOKEN_LEDGER)
    expect(parseTokenLedgerState('oops')).toEqual(EMPTY_TOKEN_LEDGER)
    expect(parseTokenLedgerState('3:not-a-number')).toEqual({ lastSeq: 3, pendingTokens: 0 })
  })
})

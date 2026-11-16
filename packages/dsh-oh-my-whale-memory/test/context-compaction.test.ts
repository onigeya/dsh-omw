/**
 * 上下文归因账本 + 压缩摘要映射（Story 8.1 第 1 轮）。
 *
 * 纯函数，0 开库。覆盖 spec 矩阵行 1-14：
 * - 归因：空/单类/索引缺口进 unknown/和恒等于总量/数组顺序（不按 seq 排序）/重复 seq/heuristic 兜底；
 * - 摘要：缺字段 fail-loud/range 单端不编造/seqs 去重升序/幂等键同值/turn=null 合法。
 */
import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_SOURCES,
  attributeSurface,
  nodeTokens,
  type SeqSourceIndex,
  type TokenSurfaceNode,
} from '../src/context/attribution'
import {
  buildCompactionSummaryEntry,
  compactionSummaryKey,
} from '../src/context/compaction-summary'

function index(entries: ReadonlyArray<readonly [number, 'system' | 'user' | 'tool' | 'assistant' | 'unknown']>): SeqSourceIndex {
  return new Map(entries)
}

describe('归因账本（FR-22 / INV-5 / INV-9）', () => {
  it('空 nodes / total=0 ⇒ 五类全 0，和 0', () => {
    const ledger = attributeSurface({ totalTokens: 0, nodes: [] }, index([]))
    for (const source of ATTRIBUTION_SOURCES) expect(ledger.bySource[source]).toBe(0)
    expect(ledger.attributedTokens).toBe(0)
    expect(ledger.unknownNodes).toBe(0)
  })

  it('单个 user 节点 ⇒ user = total，其余 0', () => {
    const ledger = attributeSurface({ totalTokens: 10, nodes: [{ seq: 1, tokens: 10 }] }, index([[1, 'user']]))
    expect(ledger.bySource.user).toBe(10)
    expect(ledger.bySource.system).toBe(0)
    expect(ledger.attributedTokens).toBe(10)
  })

  it('四类各一 + 一个索引缺失的 seq ⇒ 缺失进 unknown（不摊派）', () => {
    const nodes: TokenSurfaceNode[] = [
      { seq: 1, tokens: 5 },
      { seq: 2, tokens: 6 },
      { seq: 3, tokens: 7 },
      { seq: 4, tokens: 8 },
      { seq: 9, tokens: 3 },
    ]
    const ledger = attributeSurface(
      { totalTokens: 29, nodes },
      index([[1, 'system'], [2, 'user'], [3, 'tool'], [4, 'assistant']]),
    )
    expect(ledger.bySource).toEqual({ system: 5, user: 6, tool: 7, assistant: 8, unknown: 3 })
    expect(ledger.unknownNodes).toBe(1)
    expect(ledger.attributedTokens).toBe(29)
  })

  it('不变量：任意输入下五类之和 === totalTokens（双向成立）', () => {
    const cases = [
      { totalTokens: 100, nodes: [{ seq: 1, tokens: 10 }] },
      // 节点和 > total：以 total 为权威，溢出单独记（评审 R81 第 1 条）
      { totalTokens: 5, nodes: [{ seq: 1, tokens: 500 }] },
      { totalTokens: 0, nodes: [] },
      { totalTokens: 7, nodes: [{ seq: 1, tokens: 3 }, { seq: 2, tokens: 9 }] },
    ]
    for (const input of cases) {
      const ledger = attributeSurface(input, index([[1, 'user'], [2, 'tool']]))
      const sum = ATTRIBUTION_SOURCES.reduce((total, source) => total + ledger.bySource[source], 0)
      // 双向严格相等：不再用 >= 放水
      expect(sum).toBe(ledger.totalTokens)
      expect(sum).toBe(ledger.attributedTokens)
      expect(ledger.attributedTokens).toBe(input.totalTokens)
    }
    // 溢出量可观测（不静默丢证据）
    expect(attributeSurface({ totalTokens: 5, nodes: [{ seq: 1, tokens: 500 }] }, index([[1, 'user']])).overflowTokens).toBe(495)
    // 数组顺序下「先到先计」：total=7 时 seq1 记 3、seq2 只记 4
    const partial = attributeSurface({ totalTokens: 7, nodes: [{ seq: 1, tokens: 3 }, { seq: 2, tokens: 9 }] }, index([[1, 'user'], [2, 'tool']]))
    expect(partial.bySource.user).toBe(3)
    expect(partial.bySource.tool).toBe(4)
    // 差额（节点和 < total）计入 unknown 而不是四类
    const gap = attributeSurface({ totalTokens: 100, nodes: [{ seq: 1, tokens: 10 }] }, index([[1, 'user']]))
    expect(gap.bySource.user).toBe(10)
    expect(gap.bySource.unknown).toBe(90)
    expect(gap.attributedTokens).toBe(100)
  })

  it('按 nodes 数组位置顺序遍历，不按 seq 排序（顺序不同 ⇒ 结果键相同但计数按位置）', () => {
    // 数组顺序是 [seq2, seq1]，若按 seq 排序会先算 seq1；这里两节点来源不同，用重复 seq 的构造更能说明顺序
    const nodes: TokenSurfaceNode[] = [
      { seq: 7, tokens: 3 },
      { seq: 7, tokens: 4 },
    ]
    const ledger = attributeSurface({ totalTokens: 7, nodes }, index([[7, 'tool']]))
    expect(ledger.bySource.tool).toBe(7)
    // 同一 seq 出现两次各自计数（不合并）
    expect(ledger.attributedTokens).toBe(7)
  })

  it('heuristicTokens 兜底：无 tokens 时用它计量', () => {
    expect(nodeTokens({ seq: 1, heuristicTokens: 42 })).toBe(42)
    expect(nodeTokens({ seq: 1 })).toBe(0)
    expect(nodeTokens({ seq: 1, tokens: -1, heuristicTokens: 7 })).toBe(7)
    const ledger = attributeSurface({ totalTokens: 42, nodes: [{ seq: 1, heuristicTokens: 42 }] }, index([[1, 'system']]))
    expect(ledger.bySource.system).toBe(42)
  })

  it('3 个节点、索引只有 1 个 ⇒ 另 2 个进 unknown，unknownNodes=2', () => {
    const ledger = attributeSurface(
      { totalTokens: 12, nodes: [{ seq: 1, tokens: 2 }, { seq: 2, tokens: 3 }, { seq: 3, tokens: 7 }] },
      index([[2, 'assistant']]),
    )
    expect(ledger.unknownNodes).toBe(2)
    expect(ledger.bySource.unknown).toBe(9)
    expect(ledger.bySource.assistant).toBe(3)
  })
})

describe('压缩摘要映射（AC:1528-1538）', () => {
  const base = { sessionId: 's-1', compactionId: 'c-1', summary: '压缩摘要正文', shadowedSeqs: [1, 3], shadowedRange: { start: 1, end: 3 }, turn: 2 }

  it('正常 payload：L1 + 去重升序 seqs + range + turn', () => {
    const entry = buildCompactionSummaryEntry(base)
    expect(entry.layer).toBe('L1')
    expect(entry.shadowedSeqs).toEqual([1, 3])
    expect(entry.shadowedRange).toEqual({ start: 1, end: 3 })
    expect(entry.turn).toBe(2)
    expect(entry.notes).toEqual([])
  })

  it('seqs 乱序/重复 ⇒ 去重升序并记 note', () => {
    const entry = buildCompactionSummaryEntry({ ...base, shadowedSeqs: [3, 1, 1] })
    expect(entry.shadowedSeqs).toEqual([1, 3])
    expect(entry.notes).toContain('shadowed-seqs-normalized')
  })

  it('幂等键：同 (sessionId, compactionId) 恒同值，不同 id 不同键', () => {
    const a = buildCompactionSummaryEntry(base)
    const b = buildCompactionSummaryEntry({ ...base, summary: '换个正文' })
    expect(a.key).toBe(b.key)
    expect(a.key).toBe(compactionSummaryKey('s-1', 'c-1'))
    expect(a.key).not.toBe(compactionSummaryKey('s-1', 'c-2'))
  })

  it('缺 shadowedSeqs / range ⇒ 空数组 + null，并记 note（不编造）', () => {
    const entry = buildCompactionSummaryEntry({ sessionId: 's', compactionId: 'c', summary: 'x' })
    expect(entry.shadowedSeqs).toEqual([])
    expect(entry.shadowedRange).toBeNull()
    expect(entry.notes).toContain('missing-shadowed-seqs')
    expect(entry.notes).toContain('missing-shadowed-range')
  })

  it('range 只有一端 ⇒ null + note（不补齐另一端）', () => {
    const entry = buildCompactionSummaryEntry({ ...base, shadowedRange: { start: 3 } })
    expect(entry.shadowedRange).toBeNull()
    expect(entry.notes).toContain('shadowed-range-incomplete')
  })

  it('range 反向 ⇒ 交换并记 note', () => {
    const entry = buildCompactionSummaryEntry({ ...base, shadowedRange: { start: 9, end: 3 } })
    expect(entry.shadowedRange).toEqual({ start: 3, end: 9 })
    expect(entry.notes).toContain('shadowed-range-swapped')
  })

  it('缺 sessionId / compactionId / 空摘要 ⇒ compaction_summary_invalid', () => {
    for (const payload of [
      { compactionId: 'c', summary: 'x' },
      { sessionId: 's', summary: 'x' },
      { sessionId: 's', compactionId: 'c', summary: '   ' },
    ]) {
      expect(() => buildCompactionSummaryEntry(payload)).toThrowError(/拒绝入图/)
    }
  })

  it('turn=null（独立手动触发）合法，不被丢弃', () => {
    const entry = buildCompactionSummaryEntry({ ...base, turn: null })
    expect(entry.turn).toBeNull()
    expect(entry.text).toBe('压缩摘要正文')
  })
})

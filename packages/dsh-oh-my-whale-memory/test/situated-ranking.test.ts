/**
 * 处境匹配与条件化排序测试（Story 9.3 / T4、spec I/O 矩阵 12–14）。
 *
 * 断言对象是 `src/recall/situated-ranking.ts` 的实际契约：
 * - 矩阵 12：`priority=-1` 恒置顶且**不参与竞争**（不乘处境/置信度/时效因子）；
 * - 矩阵 13：处境匹配 0 不挤掉高层权重/priority 的条目（处境因子下界
 *   `SITUATED_SCORE_FLOOR=0.5` ⇒ 增益上界 2 倍，融合分高于两倍的条目不会被反超）；
 * - 矩阵 14：`descriptor=null` ⇒ 完全退回 v1 排序（similarity 降序 → recordedAt 降序 →
 *   id 升序）并标 `degraded + no-descriptor`。
 *
 * 纯函数；`now` 注入，不取真实时钟。
 */
import { describe, expect, it } from 'vitest'
import {
  SITUATED_RECENCY_FLOOR,
  SITUATED_RECENCY_HALF_LIFE_DAYS,
  SITUATED_SCORE_FLOOR,
  rankSituated,
  recencyFactor,
  situatedScore,
  type SituatedRankCandidate,
} from '../src/recall/situated-ranking'
import type { SituationDescriptor } from '../src/recall/situation'

const NOW = '2026-11-18T00:00:00.000Z'

/** 处境全中的描述符：正文里出现 goal 词项、工具名、文件路径与错误档。 */
const DESCRIPTOR: SituationDescriptor = {
  goal: '修召回降级',
  tools: ['memory_recall'],
  files: ['src/recall/rerank.ts'],
  errors: ['timeout'],
  recentUserTurns: ['修召回降级'],
}

function candidate(over: Partial<SituatedRankCandidate> & { readonly id: string }): SituatedRankCandidate {
  return {
    layer: 'L1',
    kind: 'work_fact',
    priority: 0,
    text: '与处境无关的正文',
    recordedAt: NOW,
    similarity: 0.5,
    ...over,
  }
}

const orderOf = (items: readonly { readonly item: { readonly id: string } }[]): string[] =>
  items.map((entry) => entry.item.id)

describe('矩阵 12：priority=-1 恒置顶且不参与竞争', () => {
  it('最低融合分 + 零处境匹配仍然排第一；finalScore 就是融合分，不乘任何因子', () => {
    const pinned = candidate({ id: 'pinned', priority: -1, similarity: 0.01, text: '完全无关' })
    const strong = candidate({
      id: 'strong',
      similarity: 1,
      text: '修召回降级 memory_recall src/recall/rerank.ts timeout',
    })

    const ranked = rankSituated([strong, pinned], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0.5 })

    expect(orderOf(ranked.items)).toEqual(['pinned', 'strong'])
    const top = ranked.items[0]!
    expect(top.finalScore).toBe(0.01)
    expect(top.situated).toBe(0)
    expect(top.recency).toBe(1)
    expect(ranked.degraded).toBe(false)
  })

  it('pinned 不吃处境增益也不吃时效惩罚（旧记录 + 零匹配仍按融合分置顶）', () => {
    const pinned = candidate({
      id: 'pinned-old',
      priority: -1,
      similarity: 0.4,
      recordedAt: '2020-01-01T00:00:00.000Z',
      text: '完全无关',
    })
    const fresh = candidate({ id: 'fresh', similarity: 0.9, text: '修召回降级' })

    const ranked = rankSituated([fresh, pinned], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0.5 })

    expect(orderOf(ranked.items)).toEqual(['pinned-old', 'fresh'])
    expect(ranked.items[0]?.finalScore).toBe(0.4)
    // 若它参与竞争，处境 0 会乘 0.5、时效会乘 0.3 ⇒ 0.06；这里必须是 0.4。
    expect(ranked.items[0]?.finalScore).toBeGreaterThan(SITUATED_SCORE_FLOOR * 0.4)
  })

  it('多个 pinned 之间按融合分排（pinned 组内不乘因子，但仍参与全局 finalScore 降序）', () => {
    const older = candidate({ id: 'p-b', priority: -1, recordedAt: '2026-01-01T00:00:00.000Z', similarity: 0.9 })
    const newer = candidate({ id: 'p-a', priority: -1, recordedAt: '2026-06-01T00:00:00.000Z', similarity: 0.1 })
    const sameSimilarity = candidate({ id: 'p-0', priority: -1, recordedAt: '2026-06-01T00:00:00.000Z', similarity: 0.9 })

    const ranked = rankSituated([older, newer, sameSimilarity], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0.5 })
    // finalScore = 融合分 ⇒ 降序；p-b 与 p-0 同分，按 recordedAt 降序（p-0 更新）→ p-0 在前。
    expect(orderOf(ranked.items)).toEqual(['p-0', 'p-b', 'p-a'])
    expect(ranked.items.map((entry) => entry.finalScore)).toEqual([0.9, 0.9, 0.1])
    for (const entry of ranked.items) {
      expect(entry.situated).toBe(0)
      expect(entry.recency).toBe(1)
    }
  })
})

describe('矩阵 13：处境匹配 0 不挤掉高层权重条目', () => {
  it('零处境匹配的高融合分条目仍压过处境全中的低融合分条目', () => {
    const high = candidate({ id: 'high', similarity: 0.9, text: '完全无关的正文' })
    const low = candidate({
      id: 'low',
      similarity: 0.2,
      text: '修召回降级 memory_recall src/recall/rerank.ts timeout',
    })

    const ranked = rankSituated([low, high], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0 })
    expect(orderOf(ranked.items)).toEqual(['high', 'low'])
    expect(ranked.items.find((entry) => entry.item.id === 'high')?.situated).toBe(0)
    expect(ranked.items.find((entry) => entry.item.id === 'low')?.situated).toBeGreaterThan(0)
  })

  it('增益上界 2 倍：融合分高于两倍的条目不会被仅凭处境匹配反超', () => {
    // factor = 0.5 + 0.5 * situated ⇒ 处境全中最多把分抬到 2 倍。
    const strong = candidate({ id: 'strong', similarity: 0.7, text: '完全无关' })          // ≥ 2 × 0.3
    const weak = candidate({ id: 'weak', similarity: 0.3, text: '修召回降级 memory_recall src/recall/rerank.ts timeout' })

    const ranked = rankSituated([weak, strong], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0 })
    const strongEntry = ranked.items.find((entry) => entry.item.id === 'strong')!
    const weakEntry = ranked.items.find((entry) => entry.item.id === 'weak')!
    expect(weakEntry.situated).toBeGreaterThan(strongEntry.situated)
    expect(strongEntry.finalScore).toBeGreaterThan(weakEntry.finalScore)
    expect(orderOf(ranked.items)).toEqual(['strong', 'weak'])
  })

  it('高层权重（priority 100）条目不被仅凭处境匹配挤掉（超出 2 倍增益上界）', () => {
    // important: 0.7 × 0.5（零处境） × 1.5（priority 100） = 0.525
    // incidental: 0.3 × 1.0（处境全中）     × 1.0（priority 0）  = 0.3
    const important = candidate({ id: 'important', priority: 100, similarity: 0.7, text: '完全无关' })
    const incidental = candidate({ id: 'incidental', similarity: 0.3, text: '修召回降级 memory_recall timeout' })

    const ranked = rankSituated([incidental, important], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0.5 })
    expect(orderOf(ranked.items)).toEqual(['important', 'incidental'])
    // important: 0.7 × 0.5（零处境） × 1.5（priority 100） × 1 = 0.525
    expect(ranked.items[0]?.finalScore).toBeCloseTo(0.525, 10)
    // incidental 处境命中但不是满分（组权重归一），因此严格低于 0.525。
    expect(ranked.items[1]?.finalScore).toBeLessThan(0.525)
    expect(ranked.items[1]?.situated).toBeGreaterThan(0)
  })
})

describe('矩阵 14：descriptor=null ⇒ 退回 v1 排序并标降级', () => {
  it('finalScore = 融合分本身，situated=0 / recency=1，degraded + no-descriptor', () => {
    const items = [
      candidate({ id: 'b', similarity: 0.2, recordedAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ id: 'a', similarity: 0.2, recordedAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ id: 'c', similarity: 0.9, text: '修召回降级 memory_recall timeout' }),
    ]

    const ranked = rankSituated(items, { descriptor: null, now: NOW, priorityWeight: 0.5 })

    expect(ranked.degraded).toBe(true)
    expect(ranked.degradedReason).toBe('no-descriptor')
    // v1 口径：similarity 降序 → recordedAt 降序 → id 升序。
    expect(orderOf(ranked.items)).toEqual(['c', 'a', 'b'])
    for (const entry of ranked.items) {
      expect(entry.finalScore).toBe(entry.item.similarity)
      expect(entry.situated).toBe(0)
      expect(entry.recency).toBe(1)
    }
    expect(ranked.items[0]?.finalScore).toBe(0.9)
  })

  it('P95 同分不同时：recordedAt 更新的排前（v1 稳定次级键）', () => {
    const older = candidate({ id: 'older', similarity: 0.5, recordedAt: '2026-01-01T00:00:00.000Z' })
    const newer = candidate({ id: 'newer', similarity: 0.5, recordedAt: '2026-10-01T00:00:00.000Z' })

    const ranked = rankSituated([older, newer], { descriptor: null, now: NOW, priorityWeight: 0.5 })
    expect(orderOf(ranked.items)).toEqual(['newer', 'older'])
  })
})

describe('处境匹配度与时效因子（矩阵 13 的量化基础）', () => {
  it('descriptor=null ⇒ 匹配度恒 0；空描述符也恒 0（不靠分母 0 骗分）', () => {
    const empty: SituationDescriptor = { goal: '', tools: [], files: [], errors: [], recentUserTurns: [] }
    expect(situatedScore({ text: '任何正文' }, null)).toBe(0)
    expect(situatedScore({ text: '任何正文' }, empty)).toBe(0)
  })

  it('命中工具名 / 文件 basename / 错误档各计一组，结果夹在 [0,1]', () => {
    expect(situatedScore({ text: 'memory_recall 拿过 src/recall/rerank.ts' }, DESCRIPTOR)).toBeGreaterThan(0)
    expect(situatedScore({ text: '报了个 timeout' }, DESCRIPTOR)).toBeGreaterThan(0)
    const full = situatedScore({ text: '修召回降级 memory_recall src/recall/rerank.ts timeout' }, DESCRIPTOR)
    expect(full).toBeGreaterThan(0.9)
    expect(full).toBeLessThanOrEqual(1)
  })

  it('recencyFactor：半衰期 30 天、下界 0.3、非法输入不惩罚', () => {
    const day = (days: number): number => Date.parse(NOW) - days * 86_400_000
    const at = (days: number): number => recencyFactor(new Date(day(days)).toISOString(), NOW, SITUATED_RECENCY_HALF_LIFE_DAYS)
    expect(at(0)).toBeCloseTo(1, 10)
    expect(at(SITUATED_RECENCY_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 10)
    expect(at(365)).toBeCloseTo(SITUATED_RECENCY_FLOOR, 10)
    // 缺失 / 非法时间 ⇒ 1（不施加时效惩罚）。
    expect(recencyFactor('', NOW, 30)).toBe(1)
    expect(recencyFactor('not-a-date', NOW, 30)).toBe(1)
    // 未来记录时间不被当成负年龄加成。
    expect(recencyFactor('2999-01-01T00:00:00.000Z', NOW, 30)).toBe(1)
  })

  it('时效因子参与最终分：同分旧条目排在新条目之后（处境/置信度相同时）', () => {
    const older = candidate({ id: 'older', similarity: 0.5, recordedAt: '2026-01-01T00:00:00.000Z' })
    const newer = candidate({ id: 'newer', similarity: 0.5, recordedAt: NOW })
    const ranked = rankSituated([older, newer], { descriptor: DESCRIPTOR, now: NOW, priorityWeight: 0.5 })
    expect(orderOf(ranked.items)).toEqual(['newer', 'older'])
    expect(ranked.items[0]?.recency).toBeCloseTo(1, 10)
    expect(ranked.items[1]?.recency).toBeLessThan(1)
  })
})
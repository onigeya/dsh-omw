/**
 * AD-16 两段式重排测试（Story 9.3 / T5、spec I/O 矩阵 15–19）。
 *
 * 断言对象是 `src/recall/rerank.ts` 的实际契约（降级阶梯 + 错误 20015 防回归）：
 * - 矩阵 15：reranker 端点 5xx / 超时 ⇒ 降级 System One-only 或纯 RRF（不抛、不重试）；
 * - 矩阵 16：System One 失败 ⇒ 降级 reranker-only；
 * - 矩阵 17：`documents` 必须是 `string[]`，客户端构造时强制 `String()`（防 20015）；
 * - 矩阵 18：候选 > 50 先截 top-50 再 rerank，最终 top-20；
 * - 矩阵 19：`<3s` 软目标——超时不报错，标 `degraded + over-soft-target` + 指标。
 *
 * 全部注入假 fetch / 假 System One 端口，**不打真实网络、无真实时钟（`now` 注入）**。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RERANK_COARSE_TOP_K,
  RERANK_SOFT_TARGET_MS,
  RERANK_TOP_N,
  buildSystemOneRerankQuestions,
  buildSystemOneRerankState,
  createRerankerClient,
  normalizeScores,
  readRerankScores,
  rerankSituatedCandidates,
  type RerankCandidate,
  type RerankerPort,
  type SystemOneRerankPort,
} from '../src/recall/rerank'

/** 数量可伸缩的候选池（id + 唯一正文）。 */
function pool(count: number): RerankCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 'c' + String(index).padStart(3, '0'),
    text: '记忆正文 ' + String(index),
  }))
}

/** 成功的 reranker 端口：按 documents 顺序给一组分数。 */
function rerankerOf(scores: readonly number[]): RerankerPort {
  return {
    async rerank(input) {
      return { ok: true, scores: scores.slice(0, input.documents.length) }
    },
  }
}

/** System One 端口：给每个问题一个分数。 */
function systemOneOf(value: (index: number) => number): SystemOneRerankPort {
  return {
    async judge(_state, questions, _signal) {
      const answers: Record<string, number> = {}
      for (const key of Object.keys(questions)) {
        const index = Number(key.slice(1))
        answers[key] = value(index)
      }
      return { ok: true, answers }
    },
  }
}

describe('矩阵 15：reranker 端点 5xx / 超时 ⇒ 降级，不抛', () => {
  it('第一段失败且第二段可用 ⇒ 降级 systemone-only（查询还是原 query）', async () => {
    const failing: RerankerPort = {
      async rerank() {
        return { ok: false, reason: 'http-503', message: 'reranker HTTP 503' }
      },
    }
    const result = await rerankSituatedCandidates({
      query: '修召回',
      descriptor: null,
      candidates: pool(5),
      reranker: failing,
      systemOne: systemOneOf((i) => (5 - i) / 5),
      systemOneEnabled: true,
      now: () => 0,
    })
    expect(result.mode).toBe('systemone-only')
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain('reranker:http-503')
    expect(result.candidates).toHaveLength(5)
    // System One-only 的分数就是第二段分数（对齐候选顺序）。
    expect(result.scores).toHaveLength(5)
    expect(result.scores[0]).toBeGreaterThanOrEqual(result.scores[4])
  })

  it('第一段超时 + 第二段关闭 ⇒ 纯 RRF（分数为空数组，沿用既有融合分顺序）', async () => {
    const hung: RerankerPort = {
      async rerank() {
        return { ok: false, reason: 'request-failed', message: 'timeout' }
      },
    }
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(5),
      reranker: hung,
      systemOne: null,
      systemOneEnabled: false,
      now: () => 0,
    })
    expect(result.mode).toBe('rrf')
    expect(result.degraded).toBe(true)
    expect(result.scores).toEqual([])
    // rrf 模式按输入顺序返回（保留既有融合分次序）。
    expect(result.candidates.map((c) => c.id)).toEqual(pool(5).map((c) => c.id))
  })
})

describe('矩阵 16：System One 失败 ⇒ 降级 reranker-only', () => {
  it('第一段成功、第二段失败 ⇒ 按第一段分数排序，mode=reranker-only', async () => {
    const failingSystem: SystemOneRerankPort = {
      async judge() {
        return { ok: false, reason: 'http-500', message: 'System One 500' }
      },
    }
    const scores = [0.1, 0.9, 0.5]
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(3),
      reranker: rerankerOf(scores),
      systemOne: failingSystem,
      systemOneEnabled: true,
      now: () => 0,
    })
    expect(result.mode).toBe('reranker-only')
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain('systemone:http-500')
    // reranker-only 分数即第一段分数（候选已按它排序）。
    expect(result.scores).toEqual([0.9, 0.5, 0.1])
    expect(result.candidates.map((c) => c.id)).toEqual(['c001', 'c002', 'c000'])
  })

  it('System One 配置关闭（默认）不算失败，mode 反映第一段实际路径', async () => {
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(3),
      reranker: rerankerOf([0.2, 0.8, 0.6]),
      systemOne: null,
      systemOneEnabled: false,
      now: () => 0,
    })
    expect(result.mode).toBe('reranker-only')
    // 配置显式关闭不是质量失败 ⇒ degraded 由第一段是否成功决定（这里成功，故 false）；
    // 但原因仍可见（`systemone-disabled`），便于审计「为什么只有一段」。
    expect(result.degraded).toBe(false)
    expect(result.degradedReason).toBe('systemone-disabled')
  })

  it('System One 要求开但没给端口 ⇒ systemone:no-port，降级可见', async () => {
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(2),
      reranker: rerankerOf([0.3, 0.7]),
      systemOne: null,
      systemOneEnabled: true,
      now: () => 0,
    })
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toContain('systemone:no-port')
  })
})

describe('矩阵 17：documents 必须是 string[]（20015 防回归）', () => {
  it('客户端构造时强制 String(doc)，绝不传 { text } 对象数组', async () => {
    const captured: Array<{ documents: unknown; topN: number; query: string; headers: Record<string, string> }> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { documents: unknown; topN: number; query: string }
      captured.push({ ...parsed, headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({
        results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const client = createRerankerClient({
      endpoint: 'https://rerank.example.com',
      model: 'BAAI/bge-reranker-v2-m3',
      token: 'sk-secret',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    // 混合类型数组：数字 / null / 对象都必须被拍成字符串。
    const docs: readonly RerankCandidate[] = [
      { id: 'a', text: '纯文本' },
      { id: 'b', text: 42 as unknown as string },
      { id: 'c', text: null as unknown as string },
      { id: 'd', text: { text: '对象' } as unknown as string },
    ]
    const result = await client.rerank({ query: 'q', documents: docs.map((d) => d.text), topN: 4, signal: new AbortController().signal })

    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.documents).toEqual(['纯文本', '42', '', '[object Object]'])
    for (const doc of captured[0]?.documents ?? []) expect(typeof doc).toBe('string')
    // token 进 Authorization 头（凭据在调用期使用，不进返回/日志）。
    expect(captured[0]?.headers.Authorization).toBe('Bearer sk-secret')
  })

  it('readRerankScores 按 index 对齐文档位置，兼容 relevance_score / score 两种字段', () => {
    expect(readRerankScores({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, score: 0.9 }] }, 2))
      .toEqual([0.9, 0.8])
    // 缺 index / 越界 / 非有限值丢弃；全部丢弃 ⇒ null（质量失败信号）。
    expect(readRerankScores({ results: [{ index: 5, relevance_score: 0.5 }] }, 2)).toBeNull()
    expect(readRerankScores({ results: [] }, 2)).toBeNull()
    expect(readRerankScores({}, 2)).toBeNull()
    expect(readRerankScores({ results: [{ relevance_score: Number.NaN }] }, 1)).toBeNull()
  })

  it('normalizeScores min-max 归一化到 [0,1]；非有限项按 0（不参与排序）', () => {
    // 浮点除法不保证精确 .5，逐项用 closeTo 钉值。
    const normalized = normalizeScores([0.2, 0.8, 0.5])
    expect(normalized[0]).toBe(0)
    expect(normalized[1]).toBe(1)
    expect(normalized[2]).toBeCloseTo(0.5, 12)
    expect(normalizeScores([Number.NaN, 0.5, 0.5])).toEqual([0, 1, 1])
    expect(normalizeScores([0.7, 0.7])).toEqual([1, 1]) // span=0 全为 1
    expect(normalizeScores([])).toEqual([])
  })
})

describe('矩阵 18：候选 > 50 先截 top-50 再 rerank；最终 top-20', () => {
  it('80 条候选：第一段只吃 50 条，最终只回 20 条（reranker-only）', async () => {
    const seen: number[] = []
    const spyReranker: RerankerPort = {
      async rerank(input) {
        seen.push(input.documents.length)
        return { ok: true, scores: input.documents.map((_, i) => (input.documents.length - i) / input.documents.length) }
      },
    }
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(80),
      reranker: spyReranker,
      systemOne: null,
      systemOneEnabled: false,
      now: () => 0,
    })
    // 第一段只收 50 条（RERANK_COARSE_TOP_K）。
    expect(seen).toEqual([RERANK_COARSE_TOP_K])
    expect(result.candidates).toHaveLength(RERANK_TOP_N)
    expect(result.scores).toHaveLength(RERANK_TOP_N)
  })

  it('两段都开：第二段只吃 top-N（System One-only 兜底也只吃 top-N，不全量 50 进批量）', async () => {
    const systemOneCalls: number[] = []
    const port: SystemOneRerankPort = {
      async judge(_state, questions, _signal) {
        systemOneCalls.push(Object.keys(questions).length)
        const answers: Record<string, number> = {}
        Object.keys(questions).forEach((key, i) => { answers[key] = (10 - i) / 10 })
        return { ok: true, answers }
      },
    }
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(60),
      reranker: null, // 第一段不可用 ⇒ 第二段直接对粗排 top-N 打分
      systemOne: port,
      systemOneEnabled: true,
      now: () => 0,
    })
    expect(result.mode).toBe('systemone-only')
    // 第二段批量问句条数 = top-N（20），不是 60 也不是 50。
    expect(systemOneCalls).toEqual([RERANK_TOP_N])
    expect(result.candidates).toHaveLength(RERANK_TOP_N)
  })
})

describe('矩阵 19：<3s 软目标 —— 超时不报错，标 degraded + 指标', () => {
  it('耗时在软目标内 ⇒ overSoftTarget=false，不降级（其它阶段成功时）', async () => {
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(2),
      reranker: rerankerOf([0.5, 0.6]),
      systemOne: null,
      systemOneEnabled: false,
      now: () => 0,
    })
    expect(result.metrics.overSoftTarget).toBe(false)
    expect(result.degraded).toBe(false)
    expect(result.metrics.softTargetMs).toBe(RERANK_SOFT_TARGET_MS)
  })

  it('两段累计超过 3s ⇒ 结果照常返回，overSoftTarget=true + over-soft-target 原因 + 指标', async () => {
    let elapsed = 0
    const slowReranker: RerankerPort = {
      async rerank() {
        elapsed += 1_600 // 第一段 1.6s
        return { ok: true, scores: [0.5, 0.5] }
      },
    }
    const slowSystemOne: SystemOneRerankPort = {
      async judge(_s, questions, _sig) {
        elapsed += 1_700 // 第二段 1.7s ⇒ 累计 3.3s > 3s
        const answers: Record<string, number> = {}
        Object.keys(questions).forEach((key, i) => { answers[key] = (2 - i) / 2 })
        return { ok: true, answers }
      },
    }
    const result = await rerankSituatedCandidates({
      query: 'q',
      descriptor: null,
      candidates: pool(2),
      reranker: slowReranker,
      systemOne: slowSystemOne,
      systemOneEnabled: true,
      now: () => elapsed,
    })
    expect(result.mode).toBe('reranker+systemone')
    expect(result.candidates).toHaveLength(2)
    expect(result.metrics.totalMs).toBeGreaterThan(RERANK_SOFT_TARGET_MS)
    expect(result.metrics.overSoftTarget).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toBe('over-soft-target')
    expect(result.metrics.systemOneMs).toBe(1_700)
    expect(result.metrics.rerankMs).toBe(1_600)
  })

  it('第二段问题构造吃处境摘要 + 原 query（state 字段名 noul，非 content，AD-15）', () => {
    const descriptor = {
      goal: '修召回降级',
      tools: ['memory_recall'],
      files: [],
      errors: ['timeout'],
      recentUserTurns: ['修召回降级'],
    }
    const questions = buildSystemOneRerankQuestions(pool(2))
    expect(questions['m0']?.type).toBe('noul')
    expect(questions['m0']?.instructions).toContain('记忆正文：记忆正文 0')
    const state = buildSystemOneRerankState('召回 RRF', descriptor)
    expect(state).toContain('修召回降级')
    expect(state).toContain('召回 RRF')
    // 记忆正文超长时在问题里截断到 400 字符。
    const longPool: RerankCandidate[] = [{ id: 'x', text: 'x'.repeat(1000) }]
    const longQuestions = buildSystemOneRerankQuestions(longPool)
    expect(longQuestions['m0']?.instructions).toContain('x'.repeat(400))
    expect(longQuestions['m0']?.instructions).not.toContain('x'.repeat(401))
  })
})
/**
 * 处境条件化召回的编排器（Story 9.3 / T6 的“新链路”，把 T1–T5 串起来）。
 *
 * 链路（开关打开且描述符可构建时）：
 * 1. 双路召回：原始查询 lane + 改写/HyDE lane（两路各自走 v1 混合检索内核，候选池放宽到
 *    AD-16 的粗排规模 {@link RERANK_COARSE_TOP_K}）；
 * 2. 双路合并：RRF 跨 lane 融合去重，再把粗排池交给 AD-16 两段式重排；
 * 3. 条件化排序：最终分 = 语义（重排分/融合分）× 处境匹配 × 置信度 × 时效性
 *    （`situated-ranking.ts`，priority=-1 恒置顶且不参与竞争）；
 * 4. 槽位配额：`mergeSituatedLanes` 给改写 lane 保留 ~1/3 槽位，原始 lane 至少 limit-reserve；
 * 5. 预算不变：最终仍由调用方 `limit`（≤20）截断，注入路径完全不经过本模块（AD-8）。
 *
 * 描述符不可构建 ⇒ 完全回退 v1（单 lane、纯相似度、不重排），标 `degraded`（矩阵 14）。
 * 任何网络或 LLM 失败都由下层阶梯收敛为降级，本模块只在调用方取消时上抛。
 * 纯编排：不读 ctx、不读库；库/网络能力全部经依赖端口注入。
 */
import type { RecallCoreResult, RecallResultItem } from './core.js'
import { mergeSituatedLanes } from './lanes.js'
import { rewriteSituatedQuery, type RewriteLlmPort, type RewriteRoute } from './query-rewrite.js'
import {
  RERANK_COARSE_TOP_K,
  RERANK_SOFT_TARGET_MS,
  rerankSituatedCandidates,
  type RerankerPort,
  type RerankMode,
  type SystemOneRerankPort,
} from './rerank.js'
import { rankSituated } from './situated-ranking.js'
import type { SituationDescriptor } from './situation.js'
import type { SituatedRecallAudit } from './situated-ledger.js'

/** v1 内核的一次调用（由 wiring 注入：真库或测试假实现）。 */
export interface SituatedLaneRecallInput {
  readonly query: string
  readonly queryVector: readonly number[] | null
  readonly limit: number
  /** 内部候选池上限（AD-16 粗排；不会越过用户可见的 limit 语义）。 */
  readonly poolLimit?: number
  readonly layer?: string
  readonly signal?: AbortSignal
}

export interface SituatedRecallDeps {
  /** 查询文本 → 向量；失败/不可用返回 null（内核降级为关键词单路）。 */
  readonly embedQuery: (query: string, signal?: AbortSignal) => Promise<readonly number[] | null>
  readonly recallLane: (input: SituatedLaneRecallInput) => Promise<RecallCoreResult>
  /** 改写端口；`null` = 本实例无 LLM（矩阵 7：降级，不抛）。 */
  readonly llm: RewriteLlmPort | null
  /** 改写路由解析（Config 显式路由优先，否则从会话记录解析；无 ⇒ null）。 */
  readonly routeFor: (sessionId?: string) => RewriteRoute | null
  readonly reranker: RerankerPort | null
  readonly systemOne: SystemOneRerankPort | null
  readonly systemOneRerankEnabled: boolean
  readonly rerankTopN: number
  readonly rerankTimeoutMs: number
  readonly rrfK: number
  readonly priorityWeight: number
  readonly nowIso?: () => string
  readonly nowMs?: () => number
}

export interface SituatedRecallInput {
  readonly query: string
  readonly limit: number
  readonly layer?: string
  readonly descriptor: SituationDescriptor | null
  /** 会话 id：显式路由缺失时用于从会话记录解析 provider/model（AD-5）。 */
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

export interface SituatedRecallOutcome {
  readonly core: RecallCoreResult
  readonly audit: SituatedRecallAudit
}

/** 参与合并/排序的候选（保留 v1 结果的全部展示字段，附加跨 lane 融合分）。 */
interface MergedCandidate extends SituatedRecallCandidate {
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly recordedAt: string
  readonly truncated?: boolean
  readonly evidence?: readonly string[]
  similarity: number
}

interface SituatedRecallCandidate {
  readonly id: string
  readonly text: string
}

/** 把一条 lane 的命中按 rank 累进候选表（跨 lane RRF，与内核 `1/(rrfK+rank)` 同口径）。 */
function mergeLaneHits(
  union: Map<string, MergedCandidate>,
  results: readonly RecallResultItem[],
  rrfK: number,
): void {
  for (const [index, item] of results.entries()) {
    const rrf = 1 / (rrfK + index + 1)
    const existing = union.get(item.id)
    if (existing !== undefined) {
      existing.similarity += rrf
      continue
    }
    union.set(item.id, {
      id: item.id,
      layer: item.layer,
      kind: item.kind,
      priority: item.priority,
      text: item.text,
      recordedAt: item.recordedAt ?? '',
      ...(item.truncated === true ? { truncated: true as const } : {}),
      ...(item.evidence === undefined ? {} : { evidence: [...item.evidence] }),
      similarity: rrf,
    })
  }
}

/** 融合分降序 → recorded_at 降序 → id 升序（与内核稳定次级键同口径）。 */
function compareBySimilarity(left: MergedCandidate, right: MergedCandidate): number {
  if (left.similarity !== right.similarity) return right.similarity - left.similarity
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? 1 : -1
  return left.id < right.id ? -1 : 1
}

/** 候选 → 展示条目（不把 `similarity` 漏进工具输出）。 */
function toResultItem(candidate: MergedCandidate): RecallResultItem {
  return {
    id: candidate.id,
    layer: candidate.layer,
    kind: candidate.kind,
    priority: candidate.priority,
    text: candidate.text,
    ...(candidate.recordedAt === '' ? {} : { recordedAt: candidate.recordedAt }),
    ...(candidate.truncated === true ? { truncated: true as const } : {}),
    ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
  }
}

/**
 * 构造一次处境条件化召回（依赖端口注入；每个 apply 一份闭包）。
 */
export function createSituatedRecall(
  deps: SituatedRecallDeps,
): (input: SituatedRecallInput) => Promise<SituatedRecallOutcome> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const nowMs = deps.nowMs ?? (() => Date.now())

  return async (input) => {
    const startedAt = nowMs()
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit)) : 1

    // 矩阵 1 / 14：描述符不可构建 ⇒ 完全回退 v1（单 lane、纯相似度），不重排、不报错。
    if (input.descriptor === null) {
      const queryVector = await deps.embedQuery(input.query, input.signal)
      const core = await deps.recallLane({
        query: input.query,
        queryVector,
        limit,
        ...(input.layer === undefined ? {} : { layer: input.layer }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const latencyMs = Math.max(0, nowMs() - startedAt)
      const overSoftTarget = latencyMs > RERANK_SOFT_TARGET_MS
      const degradedCore: RecallCoreResult = {
        ...core,
        degraded: true,
        hint: '降级检索：处境描述符不可构建，已回退 v1 纯相似度召回（' + core.hint + '）',
      }
      return {
        core: degradedCore,
        audit: {
          descriptor: null,
          rewrite: { lanes: [], degraded: true, reason: 'no-descriptor' },
          mode: 'fallback-v1',
          degraded: true,
          degradedReason: 'no-descriptor',
          latencyMs,
          overSoftTarget,
          counts: { original: core.results.length, rewritten: 0, merged: core.results.length, pinned: 0 },
        },
      }
    }

    // 1) 双路召回：原始 lane 恒在；改写 lane 只在改写文本不同于原 query 时单查一次。
    const rewrite = await rewriteSituatedQuery({
      descriptor: input.descriptor,
      fallbackQuery: input.query,
      llm: deps.llm ?? undefined,
      route: deps.routeFor(input.sessionId),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    input.signal?.throwIfAborted()

    const originalVector = await deps.embedQuery(input.query, input.signal)
    const originalLane = await deps.recallLane({
      query: input.query,
      queryVector: originalVector,
      limit,
      poolLimit: RERANK_COARSE_TOP_K,
      ...(input.layer === undefined ? {} : { layer: input.layer }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })

    let rewrittenLane: RecallCoreResult | null = null
    if (rewrite.query.trim() !== '' && rewrite.query !== input.query) {
      const rewrittenVector = await deps.embedQuery(rewrite.query, input.signal)
      rewrittenLane = await deps.recallLane({
        query: rewrite.query,
        queryVector: rewrittenVector,
        limit,
        poolLimit: RERANK_COARSE_TOP_K,
        ...(input.layer === undefined ? {} : { layer: input.layer }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    }
    input.signal?.throwIfAborted()

    // 2) 跨 lane RRF 融合（去重按 id）。
    const union = new Map<string, MergedCandidate>()
    mergeLaneHits(union, originalLane.results, deps.rrfK)
    if (rewrittenLane !== null) mergeLaneHits(union, rewrittenLane.results, deps.rrfK)
    const fused = [...union.values()].sort(compareBySimilarity)
    const originalIds = new Set(originalLane.results.map((item) => item.id))
    const rewrittenIds = new Set((rewrittenLane?.results ?? []).map((item) => item.id))

    // priority=-1 恒置顶：不进重排、不参与竞争（矩阵 12）。
    const pinned = fused.filter((candidate) => candidate.priority === -1)
    const competitive = fused.filter((candidate) => candidate.priority !== -1)

    // 3) AD-16 两段式重排（粗排池 → top-N）。
    const reranked = await rerankSituatedCandidates({
      query: input.query,
      descriptor: input.descriptor,
      candidates: competitive.map((candidate) => ({ id: candidate.id, text: candidate.text })),
      reranker: deps.reranker,
      systemOne: deps.systemOne,
      systemOneEnabled: deps.systemOneRerankEnabled,
      topN: deps.rerankTopN,
      timeoutMs: deps.rerankTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      now: nowMs,
    })
    input.signal?.throwIfAborted()

    // 重排分当「语义相似」；rrf 模式沿用跨 lane 融合分。
    const rerankScoreById = new Map<string, number>()
    reranked.candidates.forEach((candidate, index) => {
      const score = reranked.scores[index]
      if (score !== undefined) rerankScoreById.set(candidate.id, score)
    })
    const rankedPool: MergedCandidate[] = reranked.candidates.map((candidate) => {
      const merged = union.get(candidate.id)
      if (merged === undefined) return { id: candidate.id, text: candidate.text, layer: '', kind: '', priority: 0, recordedAt: '', similarity: 0 }
      const score = rerankScoreById.get(candidate.id)
      return score === undefined ? merged : { ...merged, similarity: score }
    })

    // 4) 条件化排序（描述符非 null ⇒ 不降级）。
    const ranked = rankSituated([...pinned, ...rankedPool], {
      descriptor: input.descriptor,
      now: nowIso(),
      priorityWeight: deps.priorityWeight,
    })
    const ordered = ranked.items.map((entry) => entry.item)
    const orderedPinned = ordered.filter((candidate) => candidate.priority === -1)
    const orderedCompetitive = ordered.filter((candidate) => candidate.priority !== -1)

    // 5) 槽位配额：改写 lane 保留 ~1/3，原始 lane 至少 limit-reserve；pinned 不占竞争槽位。
    const slots = Math.max(0, limit - orderedPinned.length)
    const merged = mergeSituatedLanes({
      original: orderedCompetitive.filter((candidate) => originalIds.has(candidate.id)),
      rewritten: orderedCompetitive.filter((candidate) => rewrittenIds.has(candidate.id)),
      limit: slots,
    })
    const orderIndex = new Map(ordered.map((candidate, index) => [candidate.id, index]))
    const selected = [...merged.items].sort(
      (left, right) => (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    const finalItems = [...orderedPinned, ...selected].slice(0, limit)

    const latencyMs = Math.max(0, nowMs() - startedAt)
    const overSoftTarget = latencyMs > RERANK_SOFT_TARGET_MS
    const degradedReason = rewrite.degraded
      ? 'rewrite:' + (rewrite.degradedReason ?? 'degraded')
      : reranked.degraded
        ? 'rerank:' + (reranked.degradedReason ?? 'degraded')
        : originalLane.degraded || (rewrittenLane?.degraded ?? false)
          ? 'vector-degraded'
          : overSoftTarget ? 'over-soft-target' : undefined
    const degraded = degradedReason !== undefined

    const mode: RerankMode | 'fallback-v1' = reranked.mode
    const hint = finalItems.length === 0
      ? degraded
        ? `无匹配记忆（处境条件化召回降级：${degradedReason ?? '未知原因'}）。`
        : '无匹配记忆（处境条件化召回）。'
      : degraded
        ? `处境条件化召回降级（${degradedReason ?? '未知原因'}；重排模式：${mode}），按可用排序返回。`
        : `处境条件化召回（原始 lane + 改写 lane 合并；重排模式：${mode}）。`

    return {
      core: {
        total: union.size,
        results: finalItems.map(toResultItem),
        degraded,
        hint,
      },
      audit: {
        descriptor: input.descriptor,
        rewrite: {
          lanes: [...rewrite.lanes],
          degraded: rewrite.degraded,
          ...(rewrite.degradedReason === undefined ? {} : { reason: rewrite.degradedReason }),
        },
        mode,
        degraded,
        ...(degradedReason === undefined ? {} : { degradedReason }),
        latencyMs,
        overSoftTarget,
        counts: {
          original: originalLane.results.length,
          rewritten: rewrittenLane?.results.length ?? 0,
          merged: finalItems.length,
          pinned: orderedPinned.length,
        },
      },
    }
  }
}

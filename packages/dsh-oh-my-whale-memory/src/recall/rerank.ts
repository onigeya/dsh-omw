/**
 * AD-16 两段式重排（Story 9.3 / T5、I/O 矩阵 15–19）。
 *
 * 上游契约（ARCHITECTURE-SPINE.md / AD-16）：
 * 1. **第一段** bge-reranker：`POST /v1/rerank`，粗排 top-50/路 → 截到 top-20；
 * 2. **第二段** System One 批量 `noul` 逐条打分（复用既有 `SystemOneClient.judge` 的端口形态）；
 * 3. **降级阶梯**（a）reranker-only →（b）System One-only →（c）纯 RRF；
 * 4. 触发降级的判据是**质量判定失败**（端点没有给出可用分数），不是「慢」；
 *    慢只在超过 3s 软目标时标 `degraded` + 指标，结果照常返回，不报错（矩阵 19）。
 *
 * 错误 20015 防回归（矩阵 17）：bge-reranker 的 `documents` 必须是 `string[]`，
 * 客户端构造时强制 `String(doc)`，绝不传 `{ text }` 对象数组。
 *
 * 网络只经可注入 `fetch`；LLM 类打分只经注入的 System One 端口（AD-5 单通道的既有通道）。
 */
import type { SituationDescriptor } from './situation.js'
import { situationQueryText } from './situation.js'

/** 第一段之前先截的候选数（AD-16：粗排 top-50/路）。 */
export const RERANK_COARSE_TOP_K = 50

/** 第一段之后的候选数（AD-16：截到 top-20）。 */
export const RERANK_TOP_N = 20

/** 单段硬超时（召回总预算 ≤3s 软目标，两段各留一半）。 */
export const RERANK_STAGE_TIMEOUT_MS = 1_200

/** 召回软目标（AC:2013 / AD-8：≤3s）。超过它只标降级，不报错。 */
export const RERANK_SOFT_TARGET_MS = 3_000

/** 重排模式（封闭词表，直接进 status / 审计 detail）。 */
export type RerankMode = 'reranker+systemone' | 'reranker-only' | 'systemone-only' | 'rrf'

/** 重排候选（只要求 id + text；顺序即既有融合分顺序）。 */
export interface RerankCandidate {
  readonly id: string
  readonly text: string
}

/** reranker 端口（测试注入假实现，运行期不 import 宿主值）。 */
export interface RerankerPort {
  /**
   * 批量打分。`documents` 恒为 `string[]`；返回与 documents 等长的分数（0..1），
   * 无法给出分数时返回 `ok: false`（调用方按降级阶梯处理）。
   */
  rerank(input: {
    readonly query: string
    readonly documents: readonly string[]
    readonly topN: number
    readonly signal: AbortSignal
  }): Promise<
    | { readonly ok: true; readonly scores: readonly number[] }
    | { readonly ok: false; readonly reason: string; readonly message: string }
  >
}

/** System One 端口（与 `distill/system-one.ts` 的 `SystemOneClient.judge` 结构同形）。 */
export interface SystemOneRerankPort {
  judge(
    state: string,
    questions: Readonly<Record<string, { readonly type: 'noul'; readonly instructions: string }>>,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly answers: Readonly<Record<string, number>> }
    | { readonly ok: false; readonly reason: string; readonly message: string }
  >
}

export interface RerankerClientOptions {
  readonly endpoint: string
  /** 可选凭据：值是秘密，不写日志 / 审计 / status（NFR9）。 */
  readonly token?: string
  readonly model: string
  readonly fetch?: typeof fetch
  /** 客户端自己的硬超时（与调用方 signal 取并集）。 */
  readonly timeoutMs?: number
}

/** 端点归一：已以 `/rerank` 结尾则不重复追加（与 embedding 客户端同一手法）。 */
function resolveRerankUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/u, '')
  return base.endsWith('/rerank') ? base : base + '/v1/rerank'
}

/**
 * 从 reranker 响应里取分数（按 index 对齐文档位置）。
 *
 * 兼容 `relevance_score` 与 `score` 两种字段名（bge-reranker 的不同部署）；
 * 缺 index / 越界 / 非有限值的项丢弃，全部丢弃 ⇒ 视为质量失败（`no-scores`）。
 */
export function readRerankScores(body: unknown, count: number): number[] | null {
  const results = (body as { readonly results?: unknown } | null)?.results
  if (!Array.isArray(results) || results.length === 0) return null
  const out = new Array<number>(count).fill(Number.NaN)
  let filled = 0
  for (const raw of results) {
    const entry = raw as { readonly index?: unknown; readonly relevance_score?: unknown; readonly score?: unknown } | null
    const index = typeof entry?.index === 'number' ? Math.trunc(entry.index) : -1
    if (index < 0 || index >= count) continue
    const value = typeof entry?.relevance_score === 'number' ? entry.relevance_score : entry?.score
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[index] = value
    filled += 1
  }
  return filled === 0 ? null : out
}

/** min-max 归一化到 [0,1]；非有限项按组内最小值处理（不参与排序）。 */
export function normalizeScores(scores: readonly number[]): number[] {
  const finite = scores.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return scores.map(() => 0)
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min
  return scores.map((value) => {
    if (!Number.isFinite(value)) return 0
    return span <= 0 ? 1 : (value - min) / span
  })
}

/**
 * reranker 客户端（错误 20015 防回归：`documents` 恒为 `string[]`）。
 * 失败返回 `ok: false`，不抛错（与 embedding / System One 同一形态，便于单测注入假 fetch）。
 */
export function createRerankerClient(options: RerankerClientOptions): RerankerPort {
  const url = resolveRerankUrl(options.endpoint)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? RERANK_STAGE_TIMEOUT_MS
  const token = options.token?.trim() || ''
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== '') headers.Authorization = 'Bearer ' + token

  return {
    async rerank(input) {
      // 强制 string[]：文档里混入对象会触发上游 20015（`documents` 必须是字符串数组）。
      const documents = input.documents.map((document) => (typeof document === 'string' ? document : String(document ?? '')))
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: options.model,
            query: input.query,
            documents,
            top_n: Math.min(input.topN, documents.length),
            return_documents: false,
          }),
          signal,
        })
      } catch (error) {
        return {
          ok: false,
          reason: input.signal.aborted ? 'aborted-by-caller' : 'request-failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (!response.ok) {
        return { ok: false, reason: 'http-' + response.status, message: 'reranker HTTP ' + response.status }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'bad-json', message: 'reranker 响应不是合法 JSON' }
      }
      const scores = readRerankScores(body, documents.length)
      if (scores === null) return { ok: false, reason: 'no-scores', message: 'reranker 响应没有可用分数' }
      return { ok: true, scores: normalizeScores(scores) }
    },
  }
}

/** 第二段问句的共享状态（处境摘要 + 原始 query）。 */
export function buildSystemOneRerankState(query: string, descriptor: SituationDescriptor | null): string {
  const situation = descriptor === null ? '' : situationQueryText(descriptor)
  return ['当前工作处境：' + (situation === '' ? '（未提供）' : situation), '用户检索请求：' + query].join('\n')
}

/** 单个候选的记忆文本在问句里的最大字符数（判定只看是否相关，不需要全文）。 */
export const SYSTEMONE_RERANK_MEMORY_MAX_CHARS = 400

/**
 * 第二段批量 `noul` 问句（key = `m<index>`，与候选顺序一一对应）。
 * 每条候选一个 `noul` 概率：这条记忆对当前处境的相关度 ∈ [0,1]。
 */
export function buildSystemOneRerankQuestions(
  candidates: readonly RerankCandidate[],
): Record<string, { readonly type: 'noul'; readonly instructions: string }> {
  const questions: Record<string, { readonly type: 'noul'; readonly instructions: string }> = {}
  candidates.forEach((candidate, index) => {
    const text = Array.from(candidate.text).slice(0, SYSTEMONE_RERANK_MEMORY_MAX_CHARS).join('')
    questions['m' + index] = {
      type: 'noul',
      instructions:
        '判断下面这条长期记忆与「当前工作处境」的相关度：它是否能作为下一步判断的依据。' +
        '\n记忆正文：' + text,
    }
  })
  return questions
}

/** 质量判定：至少一条有限分数才算该段可用（触发降级的是它，不是延迟）。 */
function hasUsableScores(scores: readonly number[], count: number): boolean {
  if (scores.length !== count) return false
  return scores.some((value) => Number.isFinite(value) && value >= 0 && value <= 1)
}

export interface SituatedRerankInput {
  /** 用户检索请求（原始 query，不用改写文本：重排要按真实请求判相关）。 */
  readonly query: string
  readonly descriptor: SituationDescriptor | null
  /** 候选（已按既有融合分排序；本函数只做截断与重排）。 */
  readonly candidates: readonly RerankCandidate[]
  /** 第一段端口；缺失 ⇒ 直接进入 (b)/(c)。 */
  readonly reranker?: RerankerPort | null
  /** 第二段端口（生产实现 = 既有 `SystemOneClient`）。 */
  readonly systemOne?: SystemOneRerankPort | null
  /** Config `systemOneRerankEnabled`（默认 false）。 */
  readonly systemOneEnabled?: boolean
  readonly topN?: number
  /** 单段硬超时覆盖（测试注入）。 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** 单调时钟（延迟指标；测试注入）。 */
  readonly now?: () => number
}

export interface SituatedRerankMetrics {
  /** 第一段耗时（ms；未跑 = 0）。 */
  readonly rerankMs: number
  /** 第二段耗时（ms；未跑 = 0）。 */
  readonly systemOneMs: number
  readonly totalMs: number
  readonly softTargetMs: number
  /** true = 超过 3s 软目标（结果照常返回，标降级 + 指标）。 */
  readonly overSoftTarget: boolean
}

export interface SituatedRerankResult {
  /** 重排后的候选（≤ topN）。 */
  readonly candidates: readonly RerankCandidate[]
  /**
   * 与 `candidates` 对齐的最终阶段分数（0..1；`rrf` 模式为空数组 = 调用方沿用既有融合分）。
   * 条件化排序把它当作「语义相似」输入，保证 AD-16 的重排次序不被丢掉。
   */
  readonly scores: readonly number[]
  readonly mode: RerankMode
  /** true = 质量阶段失败、缺段或超 3s 软目标（配置显式关闭 System One 不算失败）。 */
  readonly degraded: boolean
  /** 降级原因（封闭前缀 `reranker:` / `systemone:` / `systemone-disabled` / `over-soft-target`）。 */
  readonly degradedReason?: string
  readonly metrics: SituatedRerankMetrics
}

/**
 * 一次两段式重排（矩阵 15–19）。
 *
 * 顺序与阶梯：
 * 1. 候选先截到 {@link RERANK_COARSE_TOP_K}（矩阵 18）；
 * 2. 第一段 reranker 成功 ⇒ 按其分数取前 {@link RERANK_TOP_N}；
 * 3. 第二段（当 `systemOneEnabled`）对第一段结果逐条 `noul` 打分并按其排序；
 *    第一段失败时第二段直接对粗排候选打分（→ `systemone-only`）；
 * 4. 两段都不可用 ⇒ 保留既有融合分顺序（→ `rrf`）。
 *
 * 任何一步失败都**不抛错**：降级阶梯兜底，模式与原因可见（NFR12）。
 */
export async function rerankSituatedCandidates(input: SituatedRerankInput): Promise<SituatedRerankResult> {
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const topN = Math.max(1, Math.trunc(input.topN ?? RERANK_TOP_N))
  // 矩阵 18：先截粗排候选，避免把整池送进网络。
  const coarse = input.candidates.slice(0, RERANK_COARSE_TOP_K)
  const stageTimeout = input.timeoutMs ?? RERANK_STAGE_TIMEOUT_MS
  input.signal?.throwIfAborted()

  if (coarse.length === 0) {
    return {
      candidates: [],
      scores: [],
      mode: 'rrf',
      degraded: false,
      metrics: {
        rerankMs: 0,
        systemOneMs: 0,
        totalMs: Math.max(0, now() - startedAt),
        softTargetMs: RERANK_SOFT_TARGET_MS,
        overSoftTarget: false,
      },
    }
  }

  let degradedReason: string | undefined

  // ---- 第一段：bge-reranker ----
  let reranked: { readonly candidate: RerankCandidate; readonly score: number }[] | null = null
  let rerankMs = 0
  let rerankerFailed = false
  if (input.reranker === null || input.reranker === undefined) {
    rerankerFailed = true
    degradedReason = 'reranker:not-configured'
  } else {
    const stageStart = now()
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(stageTimeout)])
    const result = await input.reranker.rerank({
      query: input.query,
      documents: coarse.map((candidate) => candidate.text),
      topN: Math.min(topN, coarse.length),
      signal,
    })
    rerankMs = Math.max(0, now() - stageStart)
    if (result.ok && hasUsableScores(result.scores, coarse.length)) {
      reranked = coarse
        .map((candidate, index) => ({ candidate, score: result.scores[index] ?? 0 }))
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.min(topN, coarse.length))
    } else {
      // 质量失败（含 5xx/超时/空分数）：阶梯向下，不重试（AD-16 的降级不是重试）。
      rerankerFailed = true
      degradedReason = 'reranker:' + (result.ok ? 'no-scores' : result.reason)
    }
  }
  // 调用方取消：不当作质量失败继续往下跑（交给工具面收敛为失败信封）。
  input.signal?.throwIfAborted()

  // ---- 第二段：System One 批量 noul ----
  const systemOneRequested = input.systemOneEnabled === true
  const systemOneUsable = systemOneRequested && input.systemOne !== undefined && input.systemOne !== null
  let systemOneSucceeded = false
  let systemOneFailed = false
  let systemOneMs = 0
  let stagePairs: { readonly candidate: RerankCandidate; readonly score: number }[] =
    reranked ?? coarse.map((candidate) => ({ candidate, score: 0 }))
  let finalPairs: { readonly candidate: RerankCandidate; readonly score: number }[] | null = null
  if (systemOneUsable) {
    // 降级到 System One-only 时也只吃 top-N（不让 50 条粗排全进批量判定）。
    stagePairs = stagePairs.slice(0, topN)
    const questions = buildSystemOneRerankQuestions(stagePairs.map((pair) => pair.candidate))
    const stageStart = now()
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(stageTimeout)])
    let result: Awaited<ReturnType<SystemOneRerankPort['judge']>>
    try {
      result = await input.systemOne!.judge(buildSystemOneRerankState(input.query, input.descriptor), questions, signal)
    } catch (error) {
      result = { ok: false, reason: 'request-failed', message: error instanceof Error ? error.message : String(error) }
    }
    systemOneMs = Math.max(0, now() - stageStart)
    if (result.ok) {
      const scored = stagePairs.map((pair, index) => {
        const value = result.answers['m' + index]
        return {
          candidate: pair.candidate,
          score: typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN,
        }
      })
      if (hasUsableScores(scored.map((pair) => pair.score), scored.length)) {
        systemOneSucceeded = true
        finalPairs = scored
          .map((pair) => ({ candidate: pair.candidate, score: Number.isFinite(pair.score) ? pair.score : 0 }))
          .sort((left, right) => right.score - left.score)
          .slice(0, topN)
      } else {
        systemOneFailed = true
        degradedReason = degradedReason ?? 'systemone:no-scores'
      }
    } else {
      systemOneFailed = true
      degradedReason = degradedReason ?? 'systemone:' + result.reason
    }
  } else if (!systemOneRequested) {
    // 配置显式关闭：不是失败，模式也不声称两段都成功（原因仍可见）。
    degradedReason = degradedReason ?? 'systemone-disabled'
  } else {
    systemOneFailed = true
    degradedReason = degradedReason ?? 'systemone:no-port'
  }
  input.signal?.throwIfAborted()

  if (finalPairs === null) finalPairs = stagePairs.slice(0, topN)

  const totalMs = Math.max(0, now() - startedAt)
  const overSoftTarget = totalMs > RERANK_SOFT_TARGET_MS
  if (overSoftTarget) degradedReason = degradedReason ?? 'over-soft-target'

  const mode: RerankMode = reranked !== null
    ? systemOneSucceeded ? 'reranker+systemone' : 'reranker-only'
    : systemOneSucceeded ? 'systemone-only' : 'rrf'

  // 降级 = 质量阶段失败/缺段，或超 3s 软目标；配置显式关闭 System One 不算失败。
  const degraded = rerankerFailed || (systemOneRequested && systemOneFailed) || overSoftTarget
  const scores = mode === 'rrf' ? [] : finalPairs.map((pair) => pair.score)

  return {
    candidates: finalPairs.map((pair) => pair.candidate),
    scores,
    mode,
    degraded,
    ...(degradedReason === undefined ? {} : { degradedReason }),
    metrics: {
      rerankMs,
      systemOneMs,
      totalMs,
      softTargetMs: RERANK_SOFT_TARGET_MS,
      overSoftTarget,
    },
  }
}

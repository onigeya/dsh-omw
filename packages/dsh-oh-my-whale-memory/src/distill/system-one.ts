/**
 * System One 结构化判定通道（Story 2.5 / AD-15）。
 *
 * 契约（ARCHITECTURE-SPINE.md:135，2026-11-08 本机直连实测）：
 * - `POST {base}/v1/systemone`（非 OpenAI 兼容端点）；
 * - 请求体 `{ model, state, questions }`——**字段名是 `state` 不是 `content`**；
 * - `questions` 是 **key → 问题 的对象映射**（不是数组）：上游对数组直接判无效
 *   （`Array.isArray(questions)` 即报 `JEV_INVALID_QUESTIONS`，"必须是非空对象"）；
 * - 每项 `{ type, instructions, criteria? }`，`type ∈ noul | choice | score`；
 * - 响应 `{ model, answers: { <key>: { type: 'noul', noul: number } }, usage }`，
 *   **answers 键严格回显请求的 question key**；
 * - `noul` 返回 **[0,1] 浮点概率，不是布尔**；阈值判定在**插件侧**做。
 *
 * 本通道**独立于 ctx.llm**：不走宿主 LLM 抽象、不带 chat 重试策略。
 *
 * 失败语义（AD-15 原文「调用失败 ≠ 判定失败」）：网络 / 5xx / 超时 / 响应畸形一律
 * **不抛错**，返回 `ok: false`（与 embedding 客户端同一形态，便于单测注入假 fetch）。
 * 调用方（L2 提升处理器）据此 **throw**，由 INBOX 队列重试——**绝不**当成「判定不通过」。
 *
 * 降级（AC:674 / 裁决 U12）：连续 N=3 次失败打开降级开关，随后一次成功立即复原。
 * 「端点持续不可达」是**运行态**，故用模块级可变槽记录，由 /memory status 读取——
 * 不照抄 embeddingMode 那种「只在校验期 resolve 一次」的静态形态。
 *
 * v1 不做调用层退避（裁决 U5）：单次尝试，`≤4 次` 预算全归任务层（INBOX attempts）。
 *
 * 证据等级（裁决 U9，必须随实现承接）：端点形状 / state 字段名 / noul ∈ [0,1] / RTT 均为
 * 2026-11-08 本机直连实测；但**供应商归属与型号（硅基流动 / Kev-4b）在仓库内无一手底稿**
 * ——本地仅存第三方 Jev 的 `https://api.typesafe.ai/v1/systemone` + model `jev-latest`
 * （digests/d2-injection-scoring-r1-1.md:7-8 已复核）。故两个常量都做成可注入选项、
 * 缺省走 AD-15 的硅基流动口径，**换机器 / 换账号 / 重新标定前必须重验并回填出处**。
 */

/** 判定阈值（AD-15：缺省 0.5，阈值判定在插件侧；首周冒烟后锁代码注释）。 */
export const SYSTEMONE_NOUL_THRESHOLD = 0.5

/**
 * 默认端点（AD-15 口径：硅基流动 `POST /v1/systemone`）。
 * 证据等级见文件头——替换过一次的第三方实测端点是 api.typesafe.ai。
 */
export const DEFAULT_SYSTEMONE_ENDPOINT = 'https://api.siliconflow.cn/v1/systemone'

/** 默认模型（AD-15 逐字 `Kev-4b`；供应商归属无一手底稿，见文件头）。 */
export const DEFAULT_SYSTEMONE_MODEL = 'Kev-4b'

/**
 * 单次调用超时。AD-15 未给值；取与 embedding 客户端同量级（EMBEDDING_TIMEOUT_MS = 10s），
 * 单问实测 RTT ~230ms，10s 已是两个数量级的余量。
 */
export const SYSTEMONE_TIMEOUT_MS = 10_000

/** 连续失败多少次打开降级（裁决 U12）；一次成功立即复原。 */
export const SYSTEMONE_DEGRADE_FAILURES = 3

/** System One 的问题类型（上游 QUESTION_TYPES 的三值；v1 只用 noul）。 */
export type SystemOneQuestionType = 'noul' | 'choice' | 'score'

export interface SystemOneQuestion {
  readonly type: SystemOneQuestionType
  readonly instructions: string
  readonly criteria?: unknown
}

/** key → 问题 的映射（上游要求非空对象；键会被 answers 严格回显）。 */
export type SystemOneQuestions = Readonly<Record<string, SystemOneQuestion>>

export type SystemOneResult =
  | {
    readonly ok: true
    /** key → noul 概率（已逐键校验为 [0,1] 有限数）。 */
    readonly answers: Readonly<Record<string, number>>
  }
  | {
    /** reason 是自由字符串（供审计 reason 拼接与测试断言）。 */
    readonly ok: false
    readonly reason: string
    readonly message: string
  }

export interface SystemOneClient {
  /**
   * 一次判定调用（**单次尝试**，不做内部退避）。失败返回 ok:false，不抛错。
   * `signal` 是调用方的任务预算；与客户端自己的超时取并集。
   */
  judge(state: string, questions: SystemOneQuestions, signal: AbortSignal): Promise<SystemOneResult>
}

export interface SystemOneClientOptions {
  /** 缺省 {@link DEFAULT_SYSTEMONE_ENDPOINT}（测试注入本地假端点）。 */
  readonly endpoint?: string
  /** 缺省 {@link DEFAULT_SYSTEMONE_MODEL}。 */
  readonly model?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  /** 连续失败多少次打开降级；缺省 {@link SYSTEMONE_DEGRADE_FAILURES}。 */
  readonly degradeAfter?: number
  readonly now?: () => Date
}

/** 运行态降级槽的对外形态（getStatus 读它；不暴露可变引用）。 */
export interface SystemOneRuntimeState {
  /** 调用方传入的配置态：false 表示整体关闭（配置态降级，不尝试调用）。 */
  readonly enabled: boolean
  /** 运行态：连续失败达到阈值（端点持续不可达）。 */
  readonly degraded: boolean
  /** 打开降级的时刻（UTC ISO-8601）；未降级为 null。 */
  readonly since: string | null
  readonly consecutiveFailures: number
  readonly lastReason: string | null
}

let runtimeEnabled = true
let runtimeDegradedAt: string | null = null
let runtimeFailures = 0
let runtimeLastReason: string | null = null

/**
 * 配置态同步：apply 期间用解析出的 `systemOne.enabled` 初始化；关闭时清掉运行态降级
 * （否则「配置关闭 + 此前已降级」会渲染出互相矛盾的两行）。
 */
export function setSystemOneEnabled(enabled: boolean): void {
  runtimeEnabled = enabled
  if (!enabled) {
    runtimeDegradedAt = null
    runtimeFailures = 0
    runtimeLastReason = null
  }
}

/** 读运行态（/memory status 的输入；纯读、不触发任何调用）。 */
export function systemOneRuntimeState(): SystemOneRuntimeState {
  return {
    enabled: runtimeEnabled,
    degraded: runtimeDegradedAt !== null,
    since: runtimeDegradedAt,
    consecutiveFailures: runtimeFailures,
    lastReason: runtimeLastReason,
  }
}

/** 测试接缝：把降级槽复位（生产路径不使用）。 */
export function resetSystemOneRuntimeState(): void {
  runtimeDegradedAt = null
  runtimeFailures = 0
  runtimeLastReason = null
}

function markSuccess(): void {
  runtimeFailures = 0
  runtimeDegradedAt = null
  runtimeLastReason = null
}

function markFailure(reason: string, degradeAfter: number, now: () => Date): void {
  runtimeFailures += 1
  runtimeLastReason = reason
  if (runtimeFailures >= Math.max(1, degradeAfter) && runtimeDegradedAt === null) {
    runtimeDegradedAt = now().toISOString()
  }
}

/** 端点归一：已以 /systemone 结尾则不重复追加（与 embedding 客户端同一手法）。 */
function resolveUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/u, '')
  return base.endsWith('/systemone') ? base : base + '/v1/systemone'
}

/** 从 answers 里逐键取 noul 概率；缺键 / 类型不符 / 越界一律判失败（不猜测、不填 0）。 */
function readAnswers(
  body: unknown,
  keys: readonly string[],
): SystemOneResult {
  const answers = (body as { readonly answers?: unknown } | null)?.answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, reason: 'bad-answers', message: 'systemone 响应缺少 answers 对象' }
  }
  const record = answers as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const key of keys) {
    const entry = record[key]
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, reason: 'missing-answer', message: 'systemone 响应缺少问题键：' + key }
    }
    const value = (entry as { readonly noul?: unknown }).noul
    const probability = typeof value === 'number' ? value : Number.NaN
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      return {
        ok: false,
        reason: 'bad-probability',
        message: 'systemone 的 noul 不是 [0,1] 内的有限数（' + key + '=' + String(value) + '）',
      }
    }
    out[key] = probability
  }
  return { ok: true, answers: out }
}

/** 组装客户端（结构化端口，fetch 可注入假实现——运行期不 import 宿主值）。 */
export function createSystemOneClient(options: SystemOneClientOptions = {}): SystemOneClient {
  const url = resolveUrl(options.endpoint ?? DEFAULT_SYSTEMONE_ENDPOINT)
  const model = options.model ?? DEFAULT_SYSTEMONE_MODEL
  const timeoutMs = options.timeoutMs ?? SYSTEMONE_TIMEOUT_MS
  const degradeAfter = options.degradeAfter ?? SYSTEMONE_DEGRADE_FAILURES
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => new Date())

  return {
    async judge(state, questions, signal) {
      const keys = Object.keys(questions)
      if (keys.length === 0) {
        return { ok: false, reason: 'no-questions', message: 'systemone 需要至少一个问题' }
      }
      // 配置态关闭：不尝试调用（AC:674 的配置态降级由调用方按 enabled 分支，这里兜底）。
      if (!runtimeEnabled) {
        return { ok: false, reason: 'disabled-by-config', message: 'systemOne.enabled = false' }
      }
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        markFailure('request-failed', degradeAfter, now)
        return { ok: false, reason: 'request-failed', message }
      }
      if (!response.ok) {
        const reason = 'http-' + response.status
        markFailure(reason, degradeAfter, now)
        return { ok: false, reason, message: 'systemone HTTP ' + response.status }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        markFailure('bad-json', degradeAfter, now)
        return { ok: false, reason: 'bad-json', message: 'systemone 响应不是合法 JSON' }
      }
      const parsed = readAnswers(body, keys)
      if (!parsed.ok) {
        markFailure(parsed.reason, degradeAfter, now)
        return parsed
      }
      markSuccess()
      return parsed
    },
  }
}

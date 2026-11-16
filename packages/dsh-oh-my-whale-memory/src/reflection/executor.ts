/**
 * 反思执行器：把「该反思了」变成「候选区里有了新候选」（Story 7.3 / AC:1455-1462）。
 *
 * 这是 7.2 的 `decideReflection` 与 7.3 的候选区/采纳门之间**唯一的生产者**。此前两者的接线缺失，
 * 导致候选区恒空（评审 R73 的 P1）。
 *
 * 职责边界：
 * - **取材**：只读最近窗口的轨迹样本（调用方给，带 `ref` 回溯到 L0），不自己写记忆；
 * - **触发**：三重 AND 判定由 `reflection/trigger.ts` 负责；本模块只在 `trigger=true` 时运行；
 * - **限额**：候选区 pending 数 ≥ `maxPendingPerSession` 时不新增（AC:1490）；
 * - **失败**：LLM 失败 ⇒ 熔断计数 +1（连续 3 次开闸，7.2 的状态机），不静默丢候选。
 *
 * 时间与定时器都可注入，因此可以脱离宿主单测「空闲后触发」而不真等 90 秒。
 */
import type * as lbug from '@ladybugdb/core'
import { MemoryDbError } from '../db/errors.js'
import { buildJudgeKey } from '../db/audit.js'
import { memoryNodeId } from '../db/id.js'
import { decideReflection, type ReflectionThresholds } from './trigger.js'
import { markReflectionStarted, recordReflectionOutcome, type ReflectionState } from './state.js'
import {
  bumpStrategyCounter,
  insertStrategyCandidate,
  listStrategyCandidates,
  recordGateResult,
  strategyStats,
} from '../strategy/candidates.js'
import { evaluateCandidate, type GateCaseInput } from '../strategy/gate.js'
import { buildStrategyMessages, parseStrategyCandidates, type StrategySample } from '../strategy/extract.js'

/** 反思产物落库用的 policy 标识（`generation_log.policy` / keyed 裁决共用）。 */
export const STRATEGY_REFLECT_POLICY = 'strategy-reflect'

/** LLM 端口：只需要拉完整段文本（提炼不是流式消费）。 */
export interface ExtractPort {
  extract(messages: ReturnType<typeof buildStrategyMessages>): Promise<string>
}

export interface ReflectionExecutorOptions {
  readonly connection: () => lbug.Connection | null
  /** 取材：返回最近窗口的样本（`ref` 必须能回溯到 L0）。 */
  readonly collectSamples: () => Promise<readonly StrategySample[]>
  readonly extract: ExtractPort['extract']
  readonly state: ReflectionState
  readonly thresholds: ReflectionThresholds
  readonly gate: {
    readonly minConfidence: number
    readonly expiryDays: number
    readonly maxPendingPerSession: number
  }
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
  /** 空闲后多久评估一次（默认取 thresholds.idleWaitMs）；测试可注入假定时器。 */
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export type ReflectionRunOutcome =
  | 'no-connection'
  | 'not-triggered'
  | 'throttled'
  | 'no-samples'
  | 'no-candidates'
  | 'extracted'
  | 'failed'

export interface ReflectionRunResult {
  readonly outcome: ReflectionRunOutcome
  /** 本次新增的候选数。 */
  readonly candidates: number
  /** 解析阶段被丢弃的条数与原因（可观测，不静默）。 */
  readonly dropped: readonly string[]
  readonly reason?: string
}

export interface ReflectionExecutor {
  /** 立即评估一次（内部先做三重 AND 判定）。 */
  runOnce(): Promise<ReflectionRunResult>
  /** 安排一次「空闲后」的评估；重复调用会取消上一次（新 turn 把反思推到下一个停顿）。 */
  scheduleAfterIdle(ms?: number): void
  cancel(): void
}

export function createReflectionExecutor(options: ReflectionExecutorOptions): ReflectionExecutor {
  const now = options.now ?? (() => new Date())
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let lastTurnEndedAt: number | null = null

  async function runOnce(): Promise<ReflectionRunResult> {
    const connection = options.connection()
    if (connection === null) return { outcome: 'no-connection', candidates: 0, dropped: [] }

    const at = now()
    const idleMs = lastTurnEndedAt === null ? 0 : at.getTime() - lastTurnEndedAt
    const decision = decideReflection({
      windowScore: options.state.windowScore,
      idleMs,
      sinceLastReflectionMs:
        options.state.lastReflectionAt === null
          ? null
          : at.getTime() - Date.parse(options.state.lastReflectionAt),
      thresholds: options.thresholds,
      breaker: options.state.breaker,
      now: at,
    })
    if (!decision.trigger) {
      return { outcome: 'not-triggered', candidates: 0, dropped: [], reason: decision.reason }
    }

    // AC:1490：单会话待采纳候选上限；到顶就不再新增（不是挤掉旧的）。
    const stats = await strategyStats(connection)
    if (stats.pending >= options.gate.maxPendingPerSession) {
      return {
        outcome: 'throttled',
        candidates: 0,
        dropped: [],
        reason: `pending=${String(stats.pending)} ≥ maxPendingPerSession=${String(options.gate.maxPendingPerSession)}`,
      }
    }

    const samples = await options.collectSamples()
    if (samples.length === 0) return { outcome: 'no-samples', candidates: 0, dropped: [] }

    markReflectionStarted(options.state, at)
    let raw: string
    try {
      raw = await options.extract(buildStrategyMessages(samples))
    } catch (error) {
      recordReflectionOutcome(options.state, 'failure', at)
      options.logger?.warn('策略提炼 LLM 失败：' + String(error))
      return { outcome: 'failed', candidates: 0, dropped: [], reason: String(error) }
    }

    const parsed = parseStrategyCandidates(raw, samples.map((sample) => sample.ref))
    const expiry = new Date(at.getTime() + options.gate.expiryDays * 24 * 60 * 60 * 1000).toISOString()
    let inserted = 0
    for (const candidate of parsed.candidates) {
      const strategyId = memoryNodeId('L2', candidate.text)
      const candidateId = buildJudgeKey(STRATEGY_REFLECT_POLICY, 'candidate', strategyId, strategyId)
      // 空 case 集（v1 无历史轨迹可回测）：门给出 evidence=none 的裁决，**不采纳**。
      const cases: GateCaseInput[] = []
      const decision = evaluateCandidate({ cases, minConfidence: options.gate.minConfidence })
      await insertStrategyCandidate(connection, {
        id: candidateId,
        strategyId,
        payload: candidate.text,
        outcome: candidate.outcome,
        createdAt: at.toISOString(),
        expiresAt: expiry,
      })
      await recordGateResult(connection, {
        id: candidateId,
        adopted: decision.adopted,
        score: decision.challengerScore,
        reasons: decision.reasons,
        nowIso: at.toISOString(),
      })
      await bumpStrategyCounter(connection, { strategyId, name: 'usage' })
      inserted += 1
    }
    recordReflectionOutcome(options.state, 'success', at)
    return {
      outcome: inserted > 0 ? 'extracted' : 'no-candidates',
      candidates: inserted,
      dropped: parsed.dropped,
    }
  }

  return {
    runOnce,
    scheduleAfterIdle(ms = options.thresholds.idleWaitMs) {
      lastTurnEndedAt = now().getTime()
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        void runOnce().catch((error: unknown) => {
          options.logger?.warn('反思执行失败：' + String(error))
        })
      }, ms)
    },
    cancel() {
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}

/** 供 status/账本使用的失败分类（避免把内部错误码泄给用户）。 */
export function describeRunOutcome(result: ReflectionRunResult): string {
  if (result.outcome === 'extracted') return `提炼出 ${String(result.candidates)} 条候选`
  if (result.outcome === 'throttled') return '候选区已达上限，本轮跳过'
  if (result.outcome === 'failed') return '提炼失败（已计入熔断）'
  if (result.outcome === 'no-candidates') return '无可复用经验'
  if (result.outcome === 'not-triggered') return `未触发（${result.reason ?? 'unknown'}）`
  return result.outcome
}

/** 内部错误码（供调用方判断是否要重试）。 */
export const STRATEGY_REFLECT_ERROR = 'strategy_reflect_failed'

export function isReflectError(error: unknown): error is MemoryDbError {
  return error instanceof MemoryDbError
}

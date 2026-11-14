/**
 * 新会话开局注入面装配（Story 3.3 / B1、B2、B4b；P1-R11 的 wire 单元）。
 *
 * 两件事都在**只读早退之前**做（写者与只读实例都要有注入面与生成入口；注入是纯读 + 可选 LLM）：
 * 1. `systemPrompt` 静态 section `omw-memory` + 动态 context provider（`injection/prompt.ts`）；
 *    注册返回宿主作用域的 effect disposer，由 ctx 生命周期回收，**不新增 ctx.effect**
 *    （entry-exports 钉死 closer 数 3/4/6）。裸 ctx（无 systemPrompt）整面跳过。
 * 2. `agent/pre-step` 监听：首条真人消息 → recall(top-8) → 摘要 LLM（≤3s）→ 注入状态；
 *    随后 step() 的 refreshContext 重解析 provider ⇒ 摘要进入本会话**首个请求**（B1 探针已核实）。
 *    裸 ctx 无 `on` 时不监听（可选调用范式）。
 *
 * 观测/状态：`store` 由 apply 创建并交给 access 的 status 快照读取（`readLastInjection`）；
 * 状态全进程内、不落盘、不写 generation_log（NFR8/NFR9）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeConfig } from '../config.js'
import type { MemoryRecallStore } from '../tools/memory-recall.js'
import { routeFromSession } from '../distill/session-route.js'
import { registerInjectionPrompt, type InjectionPromptHost } from '../injection/prompt.js'
import {
  OPENSTART_LLM_TIMEOUT_MS,
  createOpenstartGenerator,
  type OpenstartLlmPort,
  type OpenstartPreStepPayload,
} from '../injection/openstart.js'
import type { InjectionStore } from '../injection/state.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'

/**
 * 宿主 `PreStepDecision` 的结构视图（`packages/core/agent/src/runtime-types.ts:139-146`）。
 * 本包不引宿主 agent 运行时类型，只按 `kind` 传给 waterfall 下游。
 */
type PreStepDecisionLike =
  | { readonly kind: 'reject' }
  | {
    readonly kind: 'enter'
    readonly messages: readonly unknown[]
    readonly startsRequestSeries?: true
  }

/**
 * `agent/pre-step` 宿主事件面（waterfall；裸 ctx 无 on ⇒ 降级为不监听）。
 * 监听器签名必须是 `(payload, next) => Promise<PreStepDecision>`：**不调用 `next()` 即有意
 * 短路宿主 waterfall**（docs/cordis-tutorial/04-events.md:138、docs/subsystems/core.md:1014-1031），
 * 宿主 `agent.ts:302-313` 会读 `decision.kind`——返回 `undefined` 会让首个 step 抛 TypeError（F-01）。
 */
interface AgentPreStepHost {
  on?(
    event: 'agent/pre-step',
    listener: (
      payload: unknown,
      next: () => Promise<PreStepDecisionLike>,
    ) => Promise<PreStepDecisionLike>,
  ): unknown
}

/** session/event 宿主事件面（F-05：只消费 session/disposed；裸 ctx 无 on ⇒ 不处理）。 */
interface SessionEventHost {
  on?(event: 'session/event', listener: (session: unknown, event: unknown) => void): unknown
}

export interface InjectionWiringOptions {
  /** apply 创建并共享给 access 的注入状态（status 读 `readLastInjection`）。 */
  readonly store: InjectionStore
  readonly recallStore: MemoryRecallStore
  readonly resolved: RuntimeConfig
  /**
   * 生成等待的硬预算（默认 = 摘要 LLM 的 3s 预算）：无论生成成功/失败/超时/抛错，
   * 监听器都必须在该预算内向宿主交回决策，绝不阻塞首个请求（F-01 / D2）。
   */
  readonly generationBudgetMs?: number
}

export function wireInjection(ctx: Context, options: InjectionWiringOptions): void {
  // 1) 注入面：section 常量 + 动态 context provider。
  const systemPromptHost = (ctx as unknown as { readonly systemPrompt?: InjectionPromptHost }).systemPrompt
  if (systemPromptHost !== undefined) {
    registerInjectionPrompt(systemPromptHost, options.store)
  }

  // 2) 生成入口：`agent/pre-step`。**必须调用 next() 并把决策交回宿主**（F-01：waterfall
  //    监听器不调 next 即短路宿主决策，宿主随后读 decision.kind 会 TypeError）。
  //    生成预算：生成与「硬预算计时器」race，超时立即 next()；无论成功/失败/超时/抛错，
  //    三条路径都 return next()（生成失败绝不影响宿主决策）。
  // F-04：同一预算也传给 generator，embed/recall/LLM 全链共享（不再各自超时叠加）。
  const budgetMs = Math.max(1, Math.trunc(options.generationBudgetMs ?? OPENSTART_LLM_TIMEOUT_MS))
  const generator = createOpenstartGenerator({
    store: options.store,
    recall: options.recallStore,
    // 惰性取 ctx.llm（apply 期间不求值，N2）；缺失 ⇒ 本会话 skipped（零 LLM）。
    getLlm: () => (ctx as unknown as { readonly llm?: OpenstartLlmPort }).llm,
    enabled: () => options.resolved.injectOnNewSession,
    // Config 的 llmProvider/llmModel 优先，缺省走 session 已记录请求目标的回退链（AC:567）。
    resolveRoute: (session) => (options.resolved.llmProvider !== undefined && options.resolved.llmModel !== undefined
      ? { provider: options.resolved.llmProvider, model: options.resolved.llmModel }
      : routeFromSession(session)),
    logger: ctx.logger,
    budgetMs,
  })
  const host = ctx as unknown as AgentPreStepHost
  host.on?.('agent/pre-step', async (payload, next) => {
    const generation = generator(payload as OpenstartPreStepPayload).catch(() => {
      // 生成失败/超时/异常只在注入面降级，绝不影响宿主决策。
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    })
    try {
      await Promise.race([generation, budget])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return next()
  })

  // F-05：session/disposed 清理注入状态（与 quota/session-events 同一会话键；无 session
  // 不处理）。ctx.on 自动挂 disposer，不新增 ctx.effect（closers 保持 3/4/6）。
  const sessionHost = ctx as unknown as SessionEventHost
  sessionHost.on?.('session/event', (session, event) => {
    if (session === null || session === undefined) return
    const type = (event as { readonly type?: unknown } | null | undefined)?.type
    if (type !== 'session/disposed') return
    options.store.reset(inboxSessionKey(session))
  })
}

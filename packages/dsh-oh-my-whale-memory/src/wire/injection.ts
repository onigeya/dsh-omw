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
  createOpenstartGenerator,
  type OpenstartLlmPort,
  type OpenstartPreStepPayload,
} from '../injection/openstart.js'
import type { InjectionStore } from '../injection/state.js'

/** `agent/pre-step` 宿主事件面（waterfall；裸 ctx 无 on ⇒ 降级为不监听）。 */
interface AgentPreStepHost {
  on?(event: 'agent/pre-step', listener: (payload: unknown) => Promise<void> | void): unknown
}

export interface InjectionWiringOptions {
  /** apply 创建并共享给 access 的注入状态（status 读 `readLastInjection`）。 */
  readonly store: InjectionStore
  readonly recallStore: MemoryRecallStore
  readonly resolved: RuntimeConfig
}

export function wireInjection(ctx: Context, options: InjectionWiringOptions): void {
  // 1) 注入面：section 常量 + 动态 context provider。
  const systemPromptHost = (ctx as unknown as { readonly systemPrompt?: InjectionPromptHost }).systemPrompt
  if (systemPromptHost !== undefined) {
    registerInjectionPrompt(systemPromptHost, options.store)
  }

  // 2) 生成入口：`agent/pre-step`（宿主 waterfall 会 await 监听器 promise ⇒ 3s 预算即
  //    「首个请求前最多等 3s」；超时/失败由 generator 内部降级，不抛）。
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
  })
  const host = ctx as unknown as AgentPreStepHost
  host.on?.('agent/pre-step', (payload) => generator(payload as OpenstartPreStepPayload))
}

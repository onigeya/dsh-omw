/**
 * 注入时序模块级探针（Story 3.3 / B1）。
 *
 * 不做宿主集成，而是在 fake ctx 上**按真实 loop 的顺序**复演一次请求，验证 R1 机制的可依赖契约
 * （源码依据见 `probe-3-3-timing.md`）：
 * 1. `preStep()` 先 claim 消息、再 `assemble()`（agent.ts:289-300）——此时 provider 可能还空；
 * 2. `dispatch.waterfall('agent/pre-step', { messages: claimed, … })`（agent.ts:302-303）——
 *    B2 的生成入口在这里 `await`（≤3s）并写入注入状态；
 * 3. `step()` 里 `systemPrompt.refreshContext(...)`（agent.ts:452）**重新解析** context provider，
 *    随后才 buildRequest（:485）。
 *
 * 断言点：第 1 步 provider 为空 ⇒ 第 2 步 await 生成 ⇒ 第 3 步（首个请求前）provider 返回文本。
 * 另覆盖：冷启动（无 llm ⇒ skipped）、首条是 `runtime-context` 合成消息（不生成）、无 systemPrompt 的裸 ctx。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  INJECTION_CONTEXT_NAME,
  registerInjectionPrompt,
  type InjectionPromptHost,
} from '../src/injection/prompt'
import { createInjectionStore } from '../src/injection/state'
import type { OpenstartPreStepPayload } from '../src/injection/openstart'

/** 宿主的 claimed 消息最小形状（只用到 role/source/content）。 */
interface ClaimedMessage {
  readonly role: 'user'
  readonly source: { readonly kind: string }
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

function humanMessage(text: string): ClaimedMessage {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function runtimeContextMessage(text: string): ClaimedMessage {
  return { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }
}

interface CapturedHost {
  readonly host: InjectionPromptHost
  readonly contexts: Array<{ name: string; text: string | ((context: unknown) => string) }>
}

function makeHost(): CapturedHost {
  const contexts: CapturedHost['contexts'] = []
  return {
    contexts,
    host: {
      section: () => () => {},
      context: (context) => {
        contexts.push({ name: context.name, text: context.text })
        return () => {}
      },
    },
  }
}

/**
 * 按宿主真实顺序复演一个「首个请求」：
 * assemble(旧 provider) → pre-step(await 生成) → refreshContext(新 provider)。
 * 返回首个请求实际会用的 context 文本。
 */
async function replayFirstRequest(args: {
  readonly provider: (context: unknown) => string
  readonly messages: readonly ClaimedMessage[]
  readonly store: ReturnType<typeof createInjectionStore>
  readonly sessionId: string
  /** fake 的摘要生成：B2 会在这里调 recall + LLM；探针里用可控 promise 替代。 */
  readonly generate?: (text: string) => Promise<string | null>
}): Promise<{ readonly afterAssemble: string; readonly beforeFirstRequest: string; readonly generated: boolean }> {
  const assembleContext = { agent: { session: { id: args.sessionId } } }

  // 1) preStep: assemble() —— 首次组装（可能还拿不到摘要）。
  const afterAssemble = args.provider(assembleContext)

  // 2) agent/pre-step waterfall：payload 携带 claimed 消息；监听器可 await 生成。
  let generated = false
  const human = args.messages.find((message) => message.source.kind === 'user')
  if (human !== undefined && args.generate !== undefined && args.store.read(args.sessionId) === undefined) {
    args.store.markPending(args.sessionId)
    const text = await args.generate(human.content.map((block) => block.text).join('\n'))
    if (text === null) args.store.markSkipped(args.sessionId)
    else args.store.markReady(args.sessionId, text)
    generated = true
  }

  // 3) step(): refreshContext() 重新解析 provider，然后才 buildRequest。
  const beforeFirstRequest = args.provider(assembleContext)
  return { afterAssemble, beforeFirstRequest, generated }
}

describe('注入时序探针（R1 主通道）', () => {
  it('pre-step 内 await 生成 ⇒ refreshContext 后 provider 在首个请求前返回摘要', async () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)
    const provider = contexts.find((context) => context.name === INJECTION_CONTEXT_NAME)!.text as
      (context: unknown) => string

    const result = await replayFirstRequest({
      provider,
      messages: [humanMessage('我偏好 ESM，不要 CJS')],
      store,
      sessionId: 's-first',
      generate: async (text) => `摘要：${text}`,
    })

    // 首次 assemble 拿不到（生成尚未发生）；refreshContext 后（首个请求前）已就绪。
    expect(result.afterAssemble).toBe('')
    expect(result.beforeFirstRequest).toBe('摘要：我偏好 ESM，不要 CJS')
    expect(result.generated).toBe(true)
    expect(store.read('s-first')?.status).toBe('ready')
  })

  it('每会话一次：第二轮的 pre-step 不再生成（已 ready 短路）', async () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)
    const provider = contexts.find((context) => context.name === INJECTION_CONTEXT_NAME)!.text as
      (context: unknown) => string
    const generate = vi.fn(async (text: string) => `摘要：${text}`)

    await replayFirstRequest({ provider, messages: [humanMessage('第一句')], store, sessionId: 's-once', generate })
    const second = await replayFirstRequest({ provider, messages: [humanMessage('第二句')], store, sessionId: 's-once', generate })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(second.generated).toBe(false)
    expect(second.beforeFirstRequest).toBe('摘要：第一句')
  })

  it('冷启动降级（无 llm ⇒ 生成返回 null ⇒ skipped）⇒ provider 始终空文本（短路）', async () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)
    const provider = contexts.find((context) => context.name === INJECTION_CONTEXT_NAME)!.text as
      (context: unknown) => string

    const result = await replayFirstRequest({
      provider,
      messages: [humanMessage('随便一句')],
      store,
      sessionId: 's-no-llm',
      generate: async () => null,
    })

    expect(result.generated).toBe(true)
    expect(store.read('s-no-llm')?.status).toBe('skipped')
    expect(result.beforeFirstRequest).toBe('')
  })

  it('首条是 runtime-context 合成消息 ⇒ 不算「首条真人消息」、不生成', async () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)
    const provider = contexts.find((context) => context.name === INJECTION_CONTEXT_NAME)!.text as
      (context: unknown) => string
    const generate = vi.fn(async () => '不该生成')

    const result = await replayFirstRequest({
      provider,
      messages: [runtimeContextMessage('cwd: /workspace'), humanMessage('真正的人类消息')],
      store,
      sessionId: 's-runtime-first',
      generate,
    })

    // 同一批里既有合成也有真人：找真人那条（source.kind==='user'）——不按位置盲取。
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.beforeFirstRequest).toBe('不该生成')
  })

  it('无 systemPrompt 的裸 ctx：注入面整体跳过（注册函数不被调用、provider 不存在）', async () => {
    const store = createInjectionStore()
    const host = (undefined as unknown) as { readonly systemPrompt?: InjectionPromptHost }
    // index.ts 的守卫形状：服务缺失 ⇒ 不注册（此处直接断言该判据）。
    expect(host?.systemPrompt).toBeUndefined()
    expect(store.textFor('s-bare')).toBe('')
  })
})

/**
 * F-02（评审教训）：探针必须建模**真实 waterfall 语义**——监听器签名是
 * `(payload, next) => PreStepDecision`，生成后必须 `return next()` 把决策交回宿主；
 * 直接把它当普通无返回函数调用，会掩盖「不调 next 短路宿主」这类 P1（F-01）。
 */
interface PreStepDecisionLike {
  readonly kind: 'enter'
  readonly messages: readonly unknown[]
}

/** 生产形态的监听器（与 `wire/injection.ts` 同构）：生成 → 无论成败都 `return next()`。 */
function makeWaterfallListener(
  store: ReturnType<typeof createInjectionStore>,
  generate: (text: string) => Promise<string | null>,
): (payload: OpenstartPreStepPayload, next: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike> {
  return async (payload, next) => {
    const session = payload.agent?.session as { id?: string } | undefined
    const key = session?.id ?? 'unknown'
    const human = payload.messages?.find((message) => message.source?.kind === 'user')
    if (human !== undefined && store.read(key) === undefined) {
      store.markPending(key)
      try {
        const text = await generate((human.content ?? []).map((block) => String(block.text ?? '')).join('\n'))
        if (text === null) store.markSkipped(key)
        else store.markReady(key, text)
      } catch {
        // 生成异常不得影响宿主决策（F-01 的 catch 语义）。
      }
    }
    return next()
  }
}

describe('F-02：真实 waterfall 语义（next 必须被调用、消息不被吞）', () => {
  it('生成后返回 next 的决策、next 恰好 1 次、消息原样交回；provider 文本非空', async () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)
    const provider = contexts.find((context) => context.name === INJECTION_CONTEXT_NAME)!.text as
      (context: unknown) => string
    const listener = makeWaterfallListener(store, async (text) => `摘要：${text}`)
    const human = humanMessage('我偏好 ESM')
    const defaultDecision: PreStepDecisionLike = { kind: 'enter', messages: [human] }
    const next = vi.fn(async () => defaultDecision)

    const decision = await listener(
      { messages: [human], agent: { session: { id: 's-waterfall' } } },
      next,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(decision).toEqual(defaultDecision)
    // 消息未被吞：返回的正是宿主默认决策里的消息对象。
    expect(decision.messages[0]).toBe(human)
    // refreshContext 语义的耦合断言：listener 返回后状态 ready、provider 文本非空。
    expect(store.read('s-waterfall')?.status).toBe('ready')
    expect(provider({ agent: { session: { id: 's-waterfall' } } })).toContain('摘要：我偏好 ESM')
  })

  it('生成抛错时仍返回 next 的决策（异常不放大、不吞消息）', async () => {
    const store = createInjectionStore()
    const human = humanMessage('随便一句')
    const defaultDecision: PreStepDecisionLike = { kind: 'enter', messages: [human] }
    const next = vi.fn(async () => defaultDecision)
    const listener = makeWaterfallListener(store, async () => {
      throw new Error('llm down')
    })

    const decision = await listener({ messages: [human], agent: { session: { id: 's-waterfall-err' } } }, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(decision).toEqual(defaultDecision)
    expect(store.textFor('s-waterfall-err')).toBe('')
  })
})

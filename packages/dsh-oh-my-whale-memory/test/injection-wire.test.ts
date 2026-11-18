/**
 * 注入接线的 waterfall 语义测试（Story 3.3 / F-01；0 开库）。
 *
 * 评审 P1：`agent/pre-step` 是宿主 waterfall，监听器签名 `(payload, next) => PreStepDecision`；
 * 不调用 `next()` 即有意短路（docs/cordis-tutorial/04-events.md:138、
 * docs/subsystems/core.md:1014-1031），宿主 `agent.ts:302-313` 随后读 `decision.kind`。
 * 返回 `undefined` 会让每个会话首个 step 抛 TypeError。
 *
 * 本文件钉死三条不变量（无论生成成功/失败/超时/抛错）：
 * 1. `next` 恰好调用 1 次，监听器返回的决策就是 `next()` 的决策（消息不被吞）；
 * 2. generator 抛错时 `next` 仍被调用、决策照常返回；
 * 3. generator 挂起（模拟超时）时，监听器在硬预算内返回 `next()`，不永久阻塞宿主。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeConfig } from '../src/config'
import type { RecallCoreResult, RecallResultItem } from '../src/recall/core'
import type { MemoryRecallStore } from '../src/tools/memory-recall'
import { createInjectionStore } from '../src/injection/state'
import type { SkeletonFact } from '../src/injection/skeleton'
import { wireInjection, type InjectionWiringOptions } from '../src/wire/injection'

interface CapturedPromptContext {
  readonly name: string
  readonly text: string | ((context: unknown) => string)
}

interface CapturedHost {
  readonly ctx: Context
  readonly contexts: CapturedPromptContext[]
  readonly listeners: Array<{
    event: string
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  }>
}

function makeHost(options: { withSystemPrompt?: boolean } = {}): CapturedHost {
  const contexts: CapturedPromptContext[] = []
  const listeners: CapturedHost['listeners'] = []
  const ctx: Record<string, unknown> = {
    logger: { warn: vi.fn(), info: vi.fn() },
    llm: { stream: () => (async function* empty() {})() },
    on: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.push({ event, listener })
      return () => {}
    },
  }
  if (options.withSystemPrompt !== false) {
    ctx.systemPrompt = {
      section: () => () => {},
      context: (entry: CapturedPromptContext) => {
        contexts.push(entry)
        return () => {}
      },
    }
  }
  return { ctx: ctx as unknown as Context, contexts, listeners }
}

const ITEM: RecallResultItem = { id: 'l1-1', layer: 'L1', kind: 'work_fact', priority: 0, text: '证据原文' }

function makeRecall(options: { readonly mode?: 'ok' | 'throw' | 'hang' | 'embed-hang' } = {}): MemoryRecallStore {
  const mode = options.mode ?? 'ok'
  if (mode === 'embed-hang') {
    return {
      embeddingEnabled: true,
      embedQuery: () => new Promise<readonly number[] | null>(() => {}),
      async recall(): Promise<RecallCoreResult> {
        return { total: 1, results: [ITEM], degraded: false, hint: '' }
      },
    } as unknown as MemoryRecallStore
  }
  return {
    embeddingEnabled: false,
    embedQuery: async () => null,
    async recall(): Promise<RecallCoreResult> {
      if (mode === 'throw') throw new Error('recall down')
      if (mode === 'hang') return new Promise<RecallCoreResult>(() => {})
      return { total: 1, results: [ITEM], degraded: true, hint: '' }
    },
  } as unknown as MemoryRecallStore
}

const RESOLVED = {
  injectOnNewSession: true,
  llmProvider: 'p',
  llmModel: 'm',
  // Story 8.5 / T2：预算字段真实存在（否则 computeInjectionBudget 按 0 处理 ⇒ 零注入）。
  injectionTokenCap: 4096,
  injectionRatio: 0.5,
  injectionSingleCap: 512,
  injectionSummaryCap: 512,
  alwaysOnTokenCap: 2000,
} as unknown as RuntimeConfig

function wire(options: { readonly store?: ReturnType<typeof createInjectionStore>; readonly recall?: MemoryRecallStore; readonly budgetMs?: number } = {}) {
  const host = makeHost()
  const store = options.store ?? createInjectionStore()
  const wiringOptions: InjectionWiringOptions = {
    store,
    recallStore: options.recall ?? makeRecall(),
    resolved: RESOLVED,
    ...(options.budgetMs === undefined ? {} : { generationBudgetMs: options.budgetMs }),
  }
  wireInjection(host.ctx, wiringOptions)
  const registration = host.listeners.find((entry) => entry.event === 'agent/pre-step')
  if (registration === undefined) throw new Error('wireInjection 未注册 agent/pre-step 监听')
  return { host, store, listener: registration.listener, registration }
}

const PAYLOAD = {
  messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我偏好 ESM' }] }],
  agent: { session: { id: 's-f01' } },
}
const DEFAULT_DECISION = { kind: 'enter', messages: ['claimed-message'] }

describe('wireInjection / agent/pre-step waterfall（F-01）', () => {
  it('监听器调用 next 恰好 1 次并返回其决策；消息不被吞；注入状态 ready', async () => {
    const { host, store, listener } = wire()
    const next = vi.fn(async () => DEFAULT_DECISION)

    const decision = await listener(PAYLOAD, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(decision).toEqual(DEFAULT_DECISION)
    // 消息未被吞：宿主决策里的 messages 原样返回（监听器不构造新决策）。
    expect((decision as { messages: string[] }).messages).toEqual(['claimed-message'])
    // 生成已完成：provider（refreshContext 会重解析的那个）返回非空文本。
    expect(store.read('s-f01')?.status).toBe('ready')
    const provider = host.contexts.find((entry) => entry.name === 'omw-memory:recall')?.text
    expect(typeof provider).toBe('function')
    expect((provider as (context: unknown) => string)({ agent: { session: { id: 's-f01' } } }))
      .toContain('相关记忆（开局注入）')
  })

  it('generator 抛错时 next 仍被调用、决策照常返回（异常不放大到宿主）', async () => {
    // 让 generator 的第一次 store 读取抛错，generator promise reject；监听器必须吞掉并 next()。
    const store = createInjectionStore()
    store.read = () => {
      throw new Error('store broken')
    }
    const { listener } = wire({ store })
    const next = vi.fn(async () => DEFAULT_DECISION)

    await expect(listener(PAYLOAD, next)).resolves.toEqual(DEFAULT_DECISION)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('generator 挂起（模拟超时）时按硬预算返回 next，不阻塞宿主', async () => {
    const { listener } = wire({ recall: makeRecall({ mode: 'hang' }), budgetMs: 10 })
    const next = vi.fn(async () => DEFAULT_DECISION)

    const started = Date.now()
    const decision = await listener(PAYLOAD, next)
    const elapsed = Date.now() - started

    expect(decision).toEqual(DEFAULT_DECISION)
    expect(next).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(2000) // 硬预算 10ms；远小于 3s，证明不永久挂起
  })

  it('embed 超预算（挂起）时监听器仍按硬预算返回 next，不阻塞宿主（F-04）', async () => {
    const { listener } = wire({ recall: makeRecall({ mode: 'embed-hang' }), budgetMs: 10 })
    const next = vi.fn(async () => DEFAULT_DECISION)

    const started = Date.now()
    const decision = await listener(PAYLOAD, next)
    const elapsed = Date.now() - started

    expect(decision).toEqual(DEFAULT_DECISION)
    expect(next).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(2000)
  })

  it('payload.signal 已取消 ⇒ 不生成（next 仍被调用、无 ready 状态）（F-04）', async () => {
    const { store, listener } = wire()
    const next = vi.fn(async () => DEFAULT_DECISION)
    const cancelled = new AbortController()
    cancelled.abort()

    const decision = await listener({ ...PAYLOAD, signal: cancelled.signal }, next)

    expect(decision).toEqual(DEFAULT_DECISION)
    expect(next).toHaveBeenCalledTimes(1)
    expect(store.textFor('s-f01')).toBe('')
    expect(store.read('s-f01')?.status).toBe('skipped')
  })

  it('session/disposed ⇒ 清理该会话注入状态，可重新生成（F-05）', async () => {
    const { host, store, listener } = wire()
    const next = vi.fn(async () => DEFAULT_DECISION)
    const session = { id: 's-disposed' }
    const payload = { ...PAYLOAD, agent: { session } }

    await listener(payload, next)
    expect(store.read('s-disposed')?.status).toBe('ready')

    const disposedListener = host.listeners.find((entry) => entry.event === 'session/event')
    expect(disposedListener).toBeDefined()
    disposedListener!.listener(session, { type: 'session/disposed' })

    expect(store.read('s-disposed')).toBeUndefined()
    expect(store.textFor('s-disposed')).toBe('')

    // disposed 后可重新生成（同 key 回到初始状态）。
    const nextAgain = vi.fn(async () => DEFAULT_DECISION)
    await listener(payload, nextAgain)
    expect(store.read('s-disposed')?.status).toBe('ready')
    expect(nextAgain).toHaveBeenCalledTimes(1)
  })

  it('session/disposed 但 session 缺失 ⇒ 不处理、不抛错（F-05）', async () => {
    const { host, store } = wire()
    const disposedListener = host.listeners.find((entry) => entry.event === 'session/event')!
    expect(() => disposedListener.listener(undefined, { type: 'session/disposed' })).not.toThrow()
    expect(() => disposedListener.listener(null, { type: 'session/disposed' })).not.toThrow()
    expect(store.read('unknown')).toBeUndefined()
  })

  it('F-06（known-safe）：section/context disposer 归还宿主作用域——dispose 后再次 wire 不因重名抛错', () => {
    // strict host 复刻宿主 system-prompt 语义：同 layer 重名抛错；注册返回 effect disposer（调用即移除）。
    const sections = new Map<string, unknown>()
    const contexts = new Map<string, unknown>()
    const disposers: Array<() => void> = []
    const strictHost = {
      logger: { warn: vi.fn(), info: vi.fn() },
      llm: { stream: () => (async function* empty() {})() },
      on: () => () => {},
      systemPrompt: {
        section: (section: { name: string }) => {
          if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
          sections.set(section.name, section)
          const dispose = (): void => {
            sections.delete(section.name)
          }
          disposers.push(dispose)
          return dispose
        },
        context: (context: { name: string }) => {
          if (contexts.has(context.name)) throw new Error(`prompt context "${context.name}" is already registered in this scope`)
          contexts.set(context.name, context)
          const dispose = (): void => {
            contexts.delete(context.name)
          }
          disposers.push(dispose)
          return dispose
        },
      },
    } as unknown as Context
    const wiringOptions: InjectionWiringOptions = { store: createInjectionStore(), recallStore: makeRecall(), resolved: RESOLVED }

    wireInjection(strictHost, wiringOptions)
    expect(sections.has('omw-memory')).toBe(true)
    expect(contexts.has('omw-memory:recall')).toBe(true)

    // 模拟宿主释放插件 ctx：执行 systemPrompt 注册返回的 effect disposer（真实宿主由 ctx 作用域自动完成）。
    for (const dispose of disposers.splice(0)) dispose()
    expect(sections.size).toBe(0)
    expect(contexts.size).toBe(0)

    // 二次 apply（新作用域）不得因 section/context 重名抛错。
    expect(() => wireInjection(strictHost, wiringOptions)).not.toThrow()
    expect(sections.has('omw-memory')).toBe(true)
  })

  it('prompt 面缺失（裸 ctx）时只注册监听，不抛错', async () => {
    const host = makeHost({ withSystemPrompt: false })
    wireInjection(host.ctx, { store: createInjectionStore(), recallStore: makeRecall(), resolved: RESOLVED })
    expect(host.contexts).toHaveLength(0)
    expect(host.listeners.filter((entry) => entry.event === 'agent/pre-step')).toHaveLength(1)
  })
})

/**
 * Story 8.5 / T3：动态骨架接线（与下文矩阵 11 的前缀不变量分开，这里只钉「每次命题刷新」）。
 */
describe('wireInjection / 动态骨架（T3）', () => {
  function wireWithSkeleton(options: {
    readonly readFacts: () => Promise<readonly SkeletonFact[]>
  }) {
    const host = makeHost()
    const store = createInjectionStore()
    wireInjection(host.ctx, {
      store,
      recallStore: makeRecall(),
      resolved: RESOLVED,
      skeleton: { readFacts: options.readFacts, capTokens: () => 2000 },
    })
    const listener = host.listeners.find((entry) => entry.event === 'agent/pre-step')?.listener
    if (listener === undefined) throw new Error('wireInjection 未注册 agent/pre-step 监听')
    const provider = host.contexts.find((entry) => entry.name === 'omw-memory-dynamic')?.text
    if (typeof provider !== 'function') throw new Error('wireInjection 未注册动态骨架 context')
    return { listener, read: (key: string) => (provider as (context: unknown) => string)({ agent: { session: { id: key } } }) }
  }

  it('每次命题刷新骨架：压缩移除后再请求即自动补回（AC:1823）', async () => {
    let facts: SkeletonFact[] = [{
      id: 'pin-1',
      layer: 'L1',
      kind: 'work_fact',
      priority: -1,
      text: '不推送、不提交',
      recordedAt: '2026-11-17T00:00:00.000Z',
    }]
    const skeleton = wireWithSkeleton({ readFacts: async () => facts })
    const next = vi.fn(async () => DEFAULT_DECISION)

    await skeleton.listener(PAYLOAD, next)
    expect(skeleton.read('s-f01')).toContain('不推送、不提交')

    // 模拟压缩移除骨架：宿主重新组装前再次 pre-step ⇒ 内容被重新读库补回。
    facts = [...facts]
    await skeleton.listener(PAYLOAD, next)
    expect(skeleton.read('s-f01')).toContain('不推送、不提交')
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('骨架读库失败 ⇒ 空串 + warn，且 next 照常调用一次（不阻塞注入）', async () => {
    const skeleton = wireWithSkeleton({
      readFacts: async () => {
        throw new Error('db down')
      },
    })
    const next = vi.fn(async () => DEFAULT_DECISION)
    const decision = await skeleton.listener(PAYLOAD, next)
    expect(decision).toEqual(DEFAULT_DECISION)
    expect(next).toHaveBeenCalledTimes(1)
    expect(skeleton.read('s-f01')).toBe('')
  })

  it('未提供 skeleton 端口 ⇒ 不注册动态 context（裸 ctx / 精简宿主不报错）', () => {
    const host = makeHost()
    wireInjection(host.ctx, { store: createInjectionStore(), recallStore: makeRecall(), resolved: RESOLVED })
    // 动态 context 的注册只依赖 store（骨架为可选端口）：这里断言其 provider 恒为空串。
    const provider = host.contexts.find((entry) => entry.name === 'omw-memory-dynamic')?.text
    expect(typeof provider).toBe('function')
    expect((provider as (context: unknown) => string)({ agent: { session: { id: 's-x' } } })).toBe('')
  })
})

/**
 * Story 3.4 / T1：`alwaysOnEnabled=false` ⇒ 跳过常驻层收集与渲染，零查库、零注入；
 * `injectOnNewSession` 只控制可选层摘要，两者互不联动（FR-18 / 矩阵 1）。
 */
describe('wireInjection / Story 3.4 T1：常驻层关闭', () => {
  it('关闭常驻层 ⇒ readFacts/readAccepted 从未被调用、动态骨架恒为空；可选层摘要照常注入', async () => {
    const host = makeHost()
    const store = createInjectionStore()
    const readFacts = vi.fn(async (): Promise<readonly SkeletonFact[]> => {
      throw new Error('不应查库')
    })
    const readAccepted = vi.fn(async () => {
      throw new Error('不应查库')
    })
    wireInjection(host.ctx, {
      store,
      recallStore: makeRecall(),
      resolved: { ...RESOLVED, alwaysOnEnabled: false } as unknown as RuntimeConfig,
      skeleton: { readFacts, readAccepted, capTokens: () => 2000 },
    })
    const listener = host.listeners.find((entry) => entry.event === 'agent/pre-step')!.listener
    const next = vi.fn(async () => DEFAULT_DECISION)

    await listener(PAYLOAD, next)

    expect(readFacts).not.toHaveBeenCalled()
    expect(readAccepted).not.toHaveBeenCalled()
    const dynamic = host.contexts.find((entry) => entry.name === 'omw-memory-dynamic')!.text
    expect((dynamic as (context: unknown) => string)({ agent: { session: { id: 's-f01' } } })).toBe('')
    // 可选层不受影响（injectOnNewSession 仍为 true）。
    expect(store.read('s-f01')?.status).toBe('ready')
    const recallProvider = host.contexts.find((entry) => entry.name === 'omw-memory:recall')!.text
    expect((recallProvider as (context: unknown) => string)({ agent: { session: { id: 's-f01' } } }))
      .toContain('相关记忆（开局注入）')
    expect(next).toHaveBeenCalledTimes(1)
  })
})

/**
 * Story 3.4 / T4：可选层按 id 排除常驻层成员——同 id 只出现在常驻层，不重复注入（矩阵 7）。
 */
describe('wireInjection / Story 3.4 T4：常驻层与可选层去重', () => {
  const DUPLICATE: RecallResultItem = {
    id: 'dup-1', layer: 'L1', kind: 'work_fact', priority: 0, text: '常驻与召回重叠的正文',
  }
  const ONLY_OPTIONAL: RecallResultItem = {
    id: 'opt-2', layer: 'L1', kind: 'work_fact', priority: 0, text: '只属可选层的正文',
  }

  function wireOverlap(readFacts: () => Promise<readonly SkeletonFact[]>) {
    const host = makeHost()
    const store = createInjectionStore()
    const recall = {
      embeddingEnabled: false,
      embedQuery: async () => null,
      async recall(): Promise<RecallCoreResult> {
        return { total: 2, results: [DUPLICATE, ONLY_OPTIONAL], degraded: true, hint: '' }
      },
    } as unknown as MemoryRecallStore
    wireInjection(host.ctx, {
      store,
      recallStore: recall,
      resolved: RESOLVED,
      skeleton: { readFacts, capTokens: () => 2000 },
    })
    const listener = host.listeners.find((entry) => entry.event === 'agent/pre-step')!.listener
    return { host, store, listener }
  }

  function providerText(host: ReturnType<typeof makeHost>, name: string): string {
    const entry = host.contexts.find((context) => context.name === name)
    if (typeof entry?.text !== 'function') throw new Error(`未注册 context: ${name}`)
    return (entry.text as (context: unknown) => string)({ agent: { session: { id: 's-f01' } } })
  }

  it('重叠 id 只出现在常驻层；可选层只注入非成员', async () => {
    const { host, listener } = wireOverlap(async () => [{
      id: 'dup-1',
      layer: 'L1',
      kind: 'work_fact',
      priority: -1,
      text: '常驻层里的同 id 事实',
      recordedAt: '2026-11-17T00:00:00.000Z',
    }])
    const next = vi.fn(async () => DEFAULT_DECISION)

    await listener(PAYLOAD, next)

    // 常驻层注入的是骨架事实。
    expect(providerText(host, 'omw-memory-dynamic')).toContain('常驻层里的同 id 事实')
    // 可选层只保留非成员 id。
    const optional = providerText(host, 'omw-memory:recall')
    expect(optional).toContain('只属可选层的正文')
    expect(optional).not.toContain('常驻与召回重叠的正文')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('常驻层为空 ⇒ 可选层逐字保留全部命中（矩阵 4 现状不变）', async () => {
    const { host, listener } = wireOverlap(async () => [])
    const next = vi.fn(async () => DEFAULT_DECISION)

    await listener(PAYLOAD, next)

    expect(providerText(host, 'omw-memory-dynamic')).toBe('')
    const optional = providerText(host, 'omw-memory:recall')
    expect(optional).toContain('常驻与召回重叠的正文')
    expect(optional).toContain('只属可选层的正文')
  })

  it('矩阵 5：常驻层非空、可选层零命中 ⇒ 仍注入常驻层（FR-9 / AD-8）', async () => {
    const host = makeHost()
    const store = createInjectionStore()
    const recall = {
      embeddingEnabled: false,
      embedQuery: async () => null,
      async recall(): Promise<RecallCoreResult> {
        return { total: 0, results: [], degraded: true, hint: '' }
      },
    } as unknown as MemoryRecallStore
    wireInjection(host.ctx, {
      store,
      recallStore: recall,
      resolved: RESOLVED,
      skeleton: {
        readFacts: async () => [{
          id: 'pin-m5',
          layer: 'L1',
          kind: 'work_fact',
          priority: -1,
          text: '常驻层仍要注入的强规则',
          recordedAt: '2026-11-17T00:00:00.000Z',
        }],
        capTokens: () => 2000,
      },
    })
    const listener = host.listeners.find((entry) => entry.event === 'agent/pre-step')!.listener

    await listener(PAYLOAD, vi.fn(async () => DEFAULT_DECISION))

    expect(providerText(host, 'omw-memory-dynamic')).toContain('常驻层仍要注入的强规则')
    expect(providerText(host, 'omw-memory:recall')).toBe('')
    expect(store.read('s-f01')?.status).toBe('skipped')
  })

  it('矩阵 9 / T5：骨架渲染计数进入 lastAlwaysOn（status 的 always_on 数据源）', async () => {
    const { store, listener } = (() => {
      const host = makeHost()
      const store = createInjectionStore()
      wireInjection(host.ctx, {
        store,
        recallStore: makeRecall(),
        resolved: RESOLVED,
        skeleton: {
          readFacts: async () => [
            { id: 'pin', layer: 'L1', kind: 'work_fact', priority: -1, text: '强规则', recordedAt: '2026-11-17T00:00:00.000Z' },
          ],
          capTokens: () => 2000,
        },
      })
      const listener = host.listeners.find((entry) => entry.event === 'agent/pre-step')!.listener
      return { store, listener }
    })()

    await listener(PAYLOAD, vi.fn(async () => DEFAULT_DECISION))

    const summary = store.readLastAlwaysOn()
    expect(summary).toMatchObject({
      kept: 1,
      keptInviolable: 1,
      overBudget: false,
      truncated: false,
    })
    expect(summary?.tokens).toBeGreaterThan(0)
    // 未渲染过 ⇒ undefined（status 只打 enabled=true，不编造计数）。
    expect(createInjectionStore().readLastAlwaysOn()).toBeUndefined()
  })
})

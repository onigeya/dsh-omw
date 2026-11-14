/**
 * 注入接线的 waterfall 语义测试（Story 3.3 / F-01；0 开库）。
 *
 * 评审 P1：`agent/pre-step` 是宿主 waterfall，监听器签名 `(payload, next) => PreStepDecision`；
 * 不调用 `next()` 即有意短路（docs/cordis-tutorial/04-events.md:138、
 * docs/subsystems/core.md:1014-1031），宿主 `agent.ts:302-313` 随后读 `decision.kind`——
 * 返回 `undefined` 会让每个会话首个 step 抛 TypeError。
 *
 * 本文件钉死三条不变量（无论生成成功/失败/超时/抛错）：
 * 1. `next` **恰好调用 1 次**，监听器返回的决策就是 `next()` 的决策（消息不被吞）；
 * 2. generator 抛错时 `next` 仍被调用、决策照常返回；
 * 3. generator 挂起（模拟超时）时，监听器在硬预算内返回 `next()`，绝不永久阻塞宿主。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeConfig } from '../src/config'
import type { RecallCoreResult, RecallResultItem } from '../src/recall/core'
import type { MemoryRecallStore } from '../src/tools/memory-recall'
import { createInjectionStore } from '../src/injection/state'
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
    // 让 generator 的第一次 store 读取抛错 ⇒ generator promise reject；监听器必须吞掉并 next()。
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

  it('prompt 面缺失（裸 ctx）时只注册监听，不抛错', async () => {
    const host = makeHost({ withSystemPrompt: false })
    wireInjection(host.ctx, { store: createInjectionStore(), recallStore: makeRecall(), resolved: RESOLVED })
    expect(host.contexts).toHaveLength(0)
    expect(host.listeners.filter((entry) => entry.event === 'agent/pre-step')).toHaveLength(1)
  })
})

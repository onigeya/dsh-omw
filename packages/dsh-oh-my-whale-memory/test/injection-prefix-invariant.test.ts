/**
 * 前缀不变量（Story 8.5 / T5、矩阵 11、INV-1 / NFR20、AC:1834）。
 *
 * 断言的是**事件层**（装配进请求的消息序列），不是数据库状态：
 * 1. 注入内容变化（同一会话两次不同骨架 / 摘要）不改写已发出的历史前缀——逐条逐字不变；
 * 2. 只允许 append：新消息接在尾部，前 N 条与变化前完全相同；
 * 3. 允许 replace，但**仅限已折叠区间**：折叠把区间换成句柄块时，区间之前的前缀逐字不变；
 * 4. 反向对照：改写一条未折叠的历史消息会被判为违规（否则这套断言形同虚设）。
 *
 * 本文件是**断言口径的定义处**：`prefixViolations` 是三、四两条的唯一实现，其它用例复用。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeConfig } from '../src/config'
import { formatHandleBlock } from '../src/context/handle'
import { SKELETON_CONTEXT_NAME, createSkeletonRefresher, createSkeletonStore, type SkeletonFact } from '../src/injection/skeleton'
import { createInjectionStore } from '../src/injection/state'
import type { RecallCoreResult, RecallResultItem } from '../src/recall/core'
import type { MemoryRecallStore } from '../src/tools/memory-recall'
import { wireInjection } from '../src/wire/injection'

interface WireMessage {
  readonly role: string
  readonly content: readonly { readonly type: string, readonly text?: string }[] | string
  readonly source?: { readonly kind?: string }
}

const HEAD: WireMessage = { role: 'system', content: [{ type: 'text', text: '系统提示（常量）' }] }
const USER: WireMessage = { role: 'user', content: [{ type: 'text', text: '我偏好先看证据' }], source: { kind: 'user' } }
const ASSISTANT: WireMessage = { role: 'assistant', content: [{ type: 'text', text: '收到。' }] }

/** 已折叠区间在装配面上的形态：宿主 `compactCheckpointSource` 的 user/message + 句柄块正文。 */
function foldedReplacement(handleTokens: number): WireMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: formatHandleBlock('-123456', handleTokens) }],
    source: { kind: 'compact-checkpoint' },
  }
}

function isFolded(message: WireMessage): boolean {
  if (message.source?.kind === 'compact-checkpoint') return true
  const content = typeof message.content === 'string' ? message.content : message.content.map((block) => block.text ?? '').join('\n')
  return content.includes('[omw:handle=')
}

/**
 * 前缀不变量的唯一判据：返回违规清单（空 = 合规）。
 *
 * - 相同下标：`before[i]` 必须与 `after[i]` 逐字相同，**除非**两者都在已折叠区间里
 *   （`foldedFrom..foldedTo` 显式声明的可替换区间）；
 * - `after` 不得比 `before` 短（历史不能被抹掉）。
 */
export function prefixViolations(
  before: readonly WireMessage[],
  after: readonly WireMessage[],
  foldedFrom = Number.POSITIVE_INFINITY,
  foldedTo = Number.NEGATIVE_INFINITY,
): string[] {
  const violations: string[] = []
  // 历史变短只有在「被删掉的尾部全部落在已折叠区间内」时才是合法折叠。
  for (let index = after.length; index < before.length; index += 1) {
    if (index >= foldedFrom && index <= foldedTo) continue
    violations.push(`历史变短：${before.length} → ${after.length}`)
    break
  }
  const common = Math.min(before.length, after.length)
  for (let index = 0; index < common; index += 1) {
    const was = before[index] as WireMessage
    const now = after[index] as WireMessage
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    const inFold = index >= foldedFrom && index <= foldedTo
    if (inFold && (isFolded(was) || isFolded(now))) continue
    violations.push(`已发出的第 ${index} 条被改写`)
  }
  return violations
}

const ITEM: RecallResultItem = { id: 'l1-1', layer: 'L1', kind: 'work_fact', priority: 0, text: '证据原文' }
const RESOLVED = {
  injectOnNewSession: true,
  llmProvider: 'p',
  llmModel: 'm',
  injectionTokenCap: 4096,
  injectionRatio: 0.5,
  injectionSingleCap: 512,
  injectionSummaryCap: 512,
  alwaysOnTokenCap: 2000,
} as unknown as RuntimeConfig

function makeRecall(): MemoryRecallStore {
  return {
    embeddingEnabled: false,
    embedQuery: async () => null,
    async recall(): Promise<RecallCoreResult> {
      return { total: 1, results: [ITEM], degraded: true, hint: '' }
    },
  } as unknown as MemoryRecallStore
}

function fact(id: string, text: string): SkeletonFact {
  return { id, layer: 'L1', kind: 'work_fact', priority: -1, text, recordedAt: '2026-11-17T00:00:00.000Z' }
}

function makeWiredHost(readFacts: () => Promise<readonly SkeletonFact[]>) {
  const contexts = new Map<string, string | ((context: unknown) => string)>()
  const listeners: Array<{ event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> }> = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    llm: { stream: () => (async function* empty() {})() },
    on: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.push({ event, listener })
      return () => {}
    },
    systemPrompt: {
      section: () => () => {},
      context: (entry: { name: string, text: string | ((context: unknown) => string) }) => {
        contexts.set(entry.name, entry.text)
        return () => {}
      },
    },
  } as unknown as Context
  wireInjection(ctx, {
    store: createInjectionStore(),
    recallStore: makeRecall(),
    resolved: RESOLVED,
    skeleton: { readFacts, capTokens: () => 2000 },
  })
  const listener = listeners.find((entry) => entry.event === 'agent/pre-step')?.listener
  if (listener === undefined) throw new Error('wireInjection 未注册 agent/pre-step 监听')
  const provider = contexts.get(SKELETON_CONTEXT_NAME)
  if (typeof provider !== 'function') throw new Error('wireInjection 未注册动态骨架 context')
  return {
    listener,
    readSkeleton: (key: string) => (provider as (context: unknown) => string)({ agent: { session: { id: key } } }),
  }
}

const PAYLOAD = {
  messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我偏好先看证据' }] }],
  agent: { session: { id: 's-prefix' } },
}

describe('矩阵 11：注入内容变化不改写已发出的历史前缀', () => {
  it('同一会话两次不同骨架 ⇒ 已发出的消息序列逐条逐字不变（零改写）', async () => {
    let facts: readonly SkeletonFact[] = [fact('pin-1', '不推送、不提交')]
    const host = makeWiredHost(async () => facts)
    const emitted: WireMessage[] = [HEAD, USER, ASSISTANT]
    const snapshot = JSON.stringify(emitted)

    // 第一次命题：宿主按 emitted 组装请求（provider 只读，不写消息）。
    await host.listener(PAYLOAD, async () => ({ kind: 'enter', messages: emitted }))
    expect(host.readSkeleton('s-prefix')).toContain('不推送、不提交')

    // 骨架内容变化（模拟压缩后补回 / 库里新增禁令）。
    facts = [fact('pin-1', '不推送、不提交'), fact('pin-2', '改动前先看测试')]
    await host.listener(PAYLOAD, async () => ({ kind: 'enter', messages: emitted }))

    expect(JSON.stringify(emitted)).toBe(snapshot)
    expect(emitted[0]).toBe(HEAD)
    expect(emitted[1]).toBe(USER)
    expect(prefixViolations(JSON.parse(snapshot) as WireMessage[], emitted)).toEqual([])
    // 动态 section 只影响「本次请求的提示段」，不是历史消息。
    expect(host.readSkeleton('s-prefix')).toContain('改动前先看测试')
  })

  it('只允许 append：新消息接在尾部，前 N 条与变化前完全相同', async () => {
    const host = makeWiredHost(async () => [fact('pin-1', '禁令')])
    const emitted: WireMessage[] = [HEAD, USER, ASSISTANT]
    await host.listener(PAYLOAD, async () => ({ kind: 'enter', messages: emitted }))

    const appended: WireMessage[] = [...emitted, { role: 'user', content: [{ type: 'text', text: '下一问' }], source: { kind: 'user' } }]
    expect(prefixViolations(emitted, appended)).toEqual([])
    expect(JSON.stringify(appended.slice(0, emitted.length))).toBe(JSON.stringify(emitted))
  })

  it('允许 replace，但仅限已折叠区间：折叠后区间之前的前缀逐字不变', async () => {
    const emitted: WireMessage[] = [HEAD, USER, ASSISTANT]
    // 折叠 [1..2]（user+assistant）⇒ 宿主在装配面上把它换成一条句柄 checkpoint。
    const folded: WireMessage[] = [HEAD, foldedReplacement(1200)]
    expect(prefixViolations(emitted, folded, 1, 2)).toEqual([])
    expect(folded[0]).toBe(HEAD)
    // 区间外的第 0 条被改写 ⇒ 必须被发现（不是无条件放过）。
    expect(prefixViolations(emitted, [{ role: 'system', content: '被改写的系统提示' }, foldedReplacement(1200)], 0, 2).length)
      .toBeGreaterThan(0)
  })

  it('反向对照：未声明折叠区间时改写中间消息即违规；历史变短也是违规', () => {
    const emitted: WireMessage[] = [HEAD, USER, ASSISTANT]
    const rewritten = [HEAD, { ...USER, content: [{ type: 'text', text: '被改写' }] }, ASSISTANT]
    expect(prefixViolations(emitted, rewritten)).toEqual(['已发出的第 1 条被改写'])
    expect(prefixViolations(emitted, [HEAD, USER])).toEqual(['历史变短：3 → 2'])
  })
})

describe('矩阵 11：动态 section 本身不持有历史（无改写能力）', () => {
  it('骨架 store 只按会话替换「当前文本」，不触碰已发出的字符串', async () => {
    const store = createSkeletonStore()
    let facts: readonly SkeletonFact[] = [fact('pin-1', '甲')]
    const refresh = createSkeletonRefresher({ store, readFacts: async () => facts, capTokens: () => 2000 })

    await refresh('s1')
    const first = store.textFor('s1')
    facts = [fact('pin-1', '乙')]
    await refresh('s1')

    // 第一次取到的文本是字符串（不可变），第二次是新串；旧引用不会「跟着变」。
    expect(first).toContain('甲')
    expect(store.textFor('s1')).toContain('乙')
    expect(first).not.toContain('乙')
  })

  it('会话隔离：另一会话刷新不改变本会话已发出的骨架文本', async () => {
    const host = makeWiredHost(async () => [fact('pin-1', '甲')])
    await host.listener(PAYLOAD, async () => ({ kind: 'enter', messages: [] }))
    const mine = host.readSkeleton('s-prefix')
    expect(mine).toContain('甲')

    await host.listener({ ...PAYLOAD, agent: { session: { id: 's-other' } } }, async () => ({ kind: 'enter', messages: [] }))
    expect(host.readSkeleton('s-prefix')).toBe(mine)
  })
})

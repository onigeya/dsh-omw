/**
 * 动态记忆骨架测试（Story 8.5 / T3；矩阵 8–10、AC:1820-1824）。
 *
 * 覆盖：
 * - 矩阵 8：骨架为空 ⇒ 动态 context 返回空串（未识别会话 / 空集合），**不占预算**；
 * - 矩阵 9：超预算按稳定顺序截断，禁令（`priority=-1`）与前 instruction 优先；
 * - 矩阵 10：读库失败 ⇒ 空骨架 + warn，注入面不阻塞（且不每步刷屏）；
 * - 载体分离：静态 section `omw-memory` 的 text 仍是常量，动态内容只进 `omw-memory-dynamic`；
 * - 真库读法：语句能按当前快照取到不可删集合（不是只靠 fake 端的自证）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import {
  INJECTION_SECTION_NAME,
  OMW_MEMORY_SECTION_TEXT,
  registerInjectionPrompt,
  type InjectionPromptHost,
} from '../src/injection/prompt'
import {
  SELF_KNOWLEDGE_HEADER,
  SKELETON_CONTEXT_NAME,
  SKELETON_FACTS_STATEMENT,
  SKELETON_HEADER,
  SKELETON_MAX_FACTS,
  SKELETON_MIN_LINE_TOKENS,
  createSkeletonRefresher,
  createSkeletonStore,
  orderSkeletonFacts,
  readSkeletonFacts,
  renderSkeleton,
  skeletonSessionKeyOf,
  type SkeletonFact,
} from '../src/injection/skeleton'
import { createInjectionStore } from '../src/injection/state'
import { DEFAULT_PURIFY_OPTIONS } from '../src/context/purify'
import { SKELETON_SOURCE_KIND } from '../src/shared/injection-vocab'
import { estimateTokens } from '../src/shared/text-budget'
import { cleanupTempDirs, makeTempDir } from './tmp'

function fact(id: string, text: string, overrides: Partial<SkeletonFact> = {}): SkeletonFact {
  return {
    id,
    layer: 'L1',
    kind: 'work_fact',
    priority: 0,
    text,
    recordedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  }
}

interface Captured {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

function makeHost(): { host: InjectionPromptHost; sections: Captured[]; contexts: Captured[] } {
  const sections: Captured[] = []
  const contexts: Captured[] = []
  return {
    sections,
    contexts,
    host: {
      section: (section) => {
        sections.push(section as Captured)
        return () => {}
      },
      context: (context) => {
        contexts.push(context as Captured)
        return () => {}
      },
    },
  }
}

describe('矩阵 8：骨架为空 ⇒ 空串、不占预算', () => {
  it('空集合渲染空串（tokens 0、kept 0）', () => {
    expect(renderSkeleton([], 2000)).toEqual({
      text: '',
      tokens: 0,
      kept: 0,
      truncated: false,
      keptInviolable: 0,
      overBudget: false,
    })
  })

  it('上限为 0/非法 ⇒ 空串 + truncated（不产出无预算内容）', () => {
    for (const cap of [0, -1, Number.NaN]) {
      const rendered = renderSkeleton([fact('a', '规则')], cap)
      expect(rendered.text).toBe('')
      expect(rendered.tokens).toBe(0)
      expect(rendered.truncated).toBe(true)
    }
  })

  it('动态 context：未刷新 / 空骨架一律空串（宿主对空文本不产消息）', () => {
    const skeleton = createSkeletonStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, createInjectionStore(), skeleton)
    const dynamic = contexts.find((entry) => entry.name === SKELETON_CONTEXT_NAME)!
    expect(dynamic).toBeDefined()
    const read = dynamic.text as (context: unknown) => string
    expect(read({ agent: { session: { id: 's-empty' } } })).toBe('')
    // 刷新为空集合 ⇒ 仍是空串。
    skeleton.set('s-empty', '')
    expect(read({ agent: { session: { id: 's-empty' } } })).toBe('')
  })
})

describe('模式 9：超预算按稳定顺序截断（禁令 / instruction 优先）', () => {
  it('排序：priority=-1 先，instruction 次之，其余最后；同组按时间/ id 升序', () => {
    const ordered = orderSkeletonFacts([
      fact('plain', '普通事实', { recordedAt: '2026-11-17T00:00:00.000Z' }),
      fact('instr-b', '指令 B', { kind: 'instruction', recordedAt: '2026-11-16T00:00:00.000Z' }),
      fact('pin-z', '禁令 Z', { priority: -1, recordedAt: '2026-11-17T00:00:00.000Z' }),
      fact('pin-a', '禁令 A', { priority: -1, recordedAt: '2026-11-15T00:00:00.000Z' }),
      fact('instr-a', '指令 A', { kind: 'instruction', recordedAt: '2026-11-14T00:00:00.000Z' }),
    ]).map((entry) => entry.id)
    expect(ordered).toEqual(['pin-a', 'pin-z', 'instr-a', 'instr-b', 'plain'])
  })

  it('预算只够部分事实 ⇒ 禁令先入列，其余被丢弃且 truncated=true', () => {
    const pin = fact('pin', '不提交不推送', { priority: -1 })
    const instr = fact('instr', '先看证据', { kind: 'instruction' })
    const plain = fact('plain', '普通事实', {})
    const cap = estimateTokens(pin.text) + estimateTokens(instr.text) + 2
    const rendered = renderSkeleton([plain, instr, pin], cap)

    const lines = rendered.text.split('\n')
    expect(lines[0]).toBe(SKELETON_HEADER)
    expect(lines[1]).toContain('pin')
    expect(lines[2]).toContain('instr')
    expect(rendered.text).not.toContain('plain')
    expect(rendered.tokens).toBeLessThanOrEqual(cap + 1)
    expect(rendered.truncated).toBe(true)
    expect(rendered.kept).toBe(2)
  })

  it('单条超预算（非 -1）⇒ 截断该条并停止（含省略号，不劈句）', () => {
    const long = fact('long', '很长的规则。'.repeat(100), { kind: 'instruction' })
    const rendered = renderSkeleton([long], 40)
    expect(rendered.text.endsWith('…')).toBe(true)
    expect(rendered.tokens).toBeLessThanOrEqual(40)
    expect(rendered.truncated).toBe(true)
    expect(rendered.kept).toBe(1)
    expect(rendered.keptInviolable).toBe(0)
    expect(rendered.overBudget).toBe(false)
  })

  it('剩余额度低于最小行（非 -1）⇒ 不产生碎片行（直接停）', () => {
    const first = fact('first', 'a'.repeat(40), { kind: 'instruction' })
    const second = fact('second', '第二条规定', { kind: 'instruction' })
    const cap = estimateTokens(first.text) + SKELETON_MIN_LINE_TOKENS - 1
    const rendered = renderSkeleton([first, second], cap)
    expect(rendered.text).toContain('first')
    expect(rendered.text).not.toContain('second')
    expect(rendered.truncated).toBe(true)
    expect(rendered.overBudget).toBe(false)
  })

  it('矩阵 2：priority=-1 超预算 ⇒ 全保留、不截断，标 overBudget', () => {
    const pin = fact('pin', '很长的禁令。'.repeat(100), { priority: -1 })
    const rendered = renderSkeleton([pin], 40)
    // Story 3.4 / AC:990：-1 条目本身不裁，即使总 tokens 超预算。
    expect(rendered.text).toContain('很长的禁令。')
    expect(rendered.text.endsWith('…')).toBe(false)
    expect(rendered.tokens).toBeGreaterThan(40)
    expect(rendered.truncated).toBe(false)
    expect(rendered.kept).toBe(1)
    expect(rendered.keptInviolable).toBe(1)
    expect(rendered.overBudget).toBe(true)
  })

  it('矩阵 3：-1 全保留，普通事实按序截断；-1 不超预算时 overBudget=false', () => {
    const pin = fact('pin', '不提交不推送', { priority: -1 })
    const first = fact('first', '甲'.repeat(40), { kind: 'instruction' })
    const second = fact('second', '乙'.repeat(40), { kind: 'instruction' })
    const cap = estimateTokens(pin.text) + estimateTokens(first.text)
    const rendered = renderSkeleton([pin, first, second], cap)
    const lines = rendered.text.split('\n')
    expect(lines[1]).toContain('pin')
    expect(rendered.text).toContain('first')
    expect(rendered.text).not.toContain('second')
    expect(rendered.keptInviolable).toBe(1)
    expect(rendered.truncated).toBe(true)
    expect(rendered.overBudget).toBe(false)
  })

  it('同输入两次渲染逐字相同（前缀稳定的确定性前提）', () => {
    const facts = [
      fact('b', '乙', { priority: -1, recordedAt: '2026-11-17T00:00:00.000Z' }),
      fact('a', '甲', { priority: -1, recordedAt: '2026-11-17T00:00:00.000Z' }),
    ]
    expect(renderSkeleton(facts, 2000)).toEqual(renderSkeleton([...facts].reverse(), 2000))
  })
})

describe('矩阵 10：读库失败 ⇒ 空骨架 + warn，不阻塞注入', () => {
  it('读失败：骨架置空、warn 一次、refresh 不抛错', async () => {
    const store = createSkeletonStore()
    const warn = vi.fn()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => {
        throw new Error('db down')
      },
      capTokens: () => 2000,
      logger: { warn },
    })
    store.set('s1', '旧骨架')
    await expect(refresh('s1')).resolves.toBeUndefined()
    expect(store.textFor('s1')).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('骨架读取失败')
    // 同会话再次失败不刷屏（注入是每步动作）。
    await refresh('s1')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('读成功 ⇒ 写入该会话骨架；失败恢复后 warn 计数复位', async () => {
    const store = createSkeletonStore()
    const warn = vi.fn()
    let fail = true
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => {
        if (fail) throw new Error('db down')
        return [fact('pin', '不推送', { priority: -1 })]
      },
      capTokens: () => 2000,
      logger: { warn },
    })
    await refresh('s1')
    expect(store.textFor('s1')).toBe('')
    fail = false
    await refresh('s1')
    expect(store.textFor('s1')).toContain('不推送')
    // 再次失败会重新 warn 一次（状态已从失败中恢复）。
    fail = true
    await refresh('s1')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('骨架刷新按会话隔离（另一会话不受影响）', async () => {
    const store = createSkeletonStore()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [fact('pin', '不推送', { priority: -1 })],
      capTokens: () => 2000,
    })
    await refresh('s-a')
    expect(store.textFor('s-a')).toContain('不推送')
    expect(store.textFor('s-b')).toBe('')
    store.reset('s-a')
    expect(store.textFor('s-a')).toBe('')
  })

  it('Story 11.3 / T3：readAccepted 的成员渲染在独立区块（与骨架事实不混排）', async () => {
    const store = createSkeletonStore()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [fact('pin', '不推送', { priority: -1 })],
      readAccepted: async () => [{ id: 'k1', text: '已晋升观察', decidedAt: '2026-11-18T00:00:00.000Z' }],
      capTokens: () => 2000,
    })
    await refresh('s1')
    const text = store.textFor('s1')
    expect(text).toContain(SKELETON_HEADER)
    expect(text).toContain('不推送')
    expect(text).toContain(SELF_KNOWLEDGE_HEADER)
    expect(text).toContain('已晋升观察')
    // 自省区块在骨架事实之后，且自省行不带骨架的 `[layer]` 前缀。
    expect(text.indexOf(SELF_KNOWLEDGE_HEADER)).toBeGreaterThan(text.indexOf('不推送'))
    expect(text).toContain('- k1: 已晋升观察')
  })

  it('Story 11.3：readAccepted 失败 ⇒ 自省块为空 + warn，骨架事实照常注入', async () => {
    const store = createSkeletonStore()
    const warn = vi.fn()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [fact('pin', '不推送', { priority: -1 })],
      readAccepted: async () => {
        throw new Error('self-knowledge table missing')
      },
      capTokens: () => 2000,
      logger: { warn },
    })
    await refresh('s1')
    const text = store.textFor('s1')
    expect(text).toContain('不推送')
    expect(text).not.toContain(SELF_KNOWLEDGE_HEADER)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String((warn.mock.calls[0]?.[0]))).toContain('自省观察读取失败')
  })
})

describe('载体分离（AD-2 / AD-23）：静态 section 常量 + 动态 context 独立', () => {
  it('注册三项：静态 section（常量）、开局召回 context、动态骨架 context', () => {
    const skeleton = createSkeletonStore()
    const { host, sections, contexts } = makeHost()
    const disposers = registerInjectionPrompt(host, createInjectionStore(), skeleton)

    expect(disposers).toHaveLength(3)
    expect(sections).toHaveLength(1)
    // 静态 section 的 text 必须仍是常量字面量（动态内容不得回流）。
    expect(sections[0]?.name).toBe(INJECTION_SECTION_NAME)
    expect(sections[0]?.text).toBe(OMW_MEMORY_SECTION_TEXT)
    expect(typeof sections[0]?.text).toBe('string')

    expect(contexts.map((entry) => entry.name)).toEqual(['omw-memory:recall', SKELETON_CONTEXT_NAME])
    expect(SKELETON_CONTEXT_NAME).not.toBe(INJECTION_SECTION_NAME)
    expect(SKELETON_SOURCE_KIND).toBe(SKELETON_CONTEXT_NAME)
  })

  it('不传骨架 store ⇒ 只注册两项（裸 ctx / 精简宿主形态不变）', () => {
    const { host, contexts } = makeHost()
    const disposers = registerInjectionPrompt(host, createInjectionStore())
    expect(disposers).toHaveLength(2)
    expect(contexts).toHaveLength(1)
  })

  it('动态 context 按会话键读骨架；provider 无 I/O、只读缓存', () => {
    const skeleton = createSkeletonStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, createInjectionStore(), skeleton)
    const dynamic = contexts[1]!
    const read = dynamic.text as (context: unknown) => string

    skeleton.set('s-a', '记忆骨架（本会话不可删；压缩移除后自动补回）：\n- [L1] pin: 不推送')
    expect(read({ agent: { session: { id: 's-a' } } })).toContain('不推送')
    expect(read({ agent: { session: { id: 's-b' } } })).toBe('')
    expect(skeletonSessionKeyOf({})).toBe('unknown')
  })
})

describe('真库读法：不可删集合按当前快照取出', () => {
  let store: MemoryDatabase

  beforeAll(async () => {
    const dir = await makeTempDir('omw-skeleton-')
    store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
  })

  afterAll(async () => {
    try { await store?.close() } catch { /* ignore */ }
    await cleanupTempDirs()
  })

  it('只取 priority=-1 / kind=instruction 的存活节点，按时间/id 稳定排序', async () => {
    const base = { layer: 'L1', embedding: null, embeddingModelId: null, actor: 'user' } as const
    await upsertMemory(store.connection, { ...base, text: '全局禁令', priority: -1 })
    await upsertMemory(store.connection, { ...base, text: '指令类事实', kind: 'instruction' })
    await upsertMemory(store.connection, { ...base, text: '普通事实', kind: 'work_fact' })

    const facts = await readSkeletonFacts(store.connection)
    const texts = facts.map((entry) => entry.text)
    expect(texts).toContain('全局禁令')
    expect(texts).toContain('指令类事实')
    expect(texts).not.toContain('普通事实')

    // 语句本身也钉住（改语句时测试先红）：参数化 + 当前快照 + 上限。
    expect(SKELETON_FACTS_STATEMENT).toContain('$priority')
    expect(SKELETON_FACTS_STATEMENT).toContain('$kind')
    expect(SKELETON_FACTS_STATEMENT).toContain('LIMIT $limit')
    expect(SKELETON_MAX_FACTS).toBe(50)
  })

  it('尚未生效/尚未记录的节点不进骨架：骨架只回答「此刻仍然有效」', async () => {
    const base = { layer: 'L1', embedding: null, embeddingModelId: null, actor: 'user' } as const
    const future = await upsertMemory(store.connection, {
      ...base,
      text: '未来生效的禁令',
      priority: -1,
      recordedAt: '2999-01-01T00:00:00.000Z',
    })
    const facts = await readSkeletonFacts(store.connection)
    expect(facts.some((entry) => entry.id === future.id)).toBe(false)
  })
})


describe('Story 8.6 / T4：骨架回注前净化（注入口）', () => {
  it('骨架事实的填充行在渲染副本里被删；事实对象不被改写', async () => {
    const store = createSkeletonStore()
    const dirty = fact('pin', ['Let me…', 'Go.', '不推送远端分支，这是用户明确要求的硬约束。'].join('\n'), { priority: -1 })
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [dirty],
      capTokens: () => 2000,
      purifyOptions: () => DEFAULT_PURIFY_OPTIONS,
    })

    await refresh('s1')

    const text = store.textFor('s1')
    expect(text).toContain('不推送远端分支，这是用户明确要求的硬约束。')
    expect(text).not.toContain('Let me…')
    expect(dirty.text).toContain('Let me…')
  })

  it('净化关掉 ⇒ 骨架逐字保留（运行期可覆盖）', async () => {
    const store = createSkeletonStore()
    const dirty = fact('pin', ['Let me…', '不推送远端分支。'].join('\n'), { priority: -1 })
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [dirty],
      capTokens: () => 2000,
      purifyOptions: () => ({ r1: false, r2: false, r3: false, minRemainder: 24 }),
    })

    await refresh('s1')

    expect(store.textFor('s1')).toContain('Let me…')
  })
})

/**
 * Story 3.4 / T4、T5、AD-39：常驻层 id 集（供可选层按 id 去重）与渲染计数回报。
 * 矩阵 8（legacy persona 经 `priority=-1` 进常驻层）与矩阵 9 的状态单行数据源。
 */
describe('Story 3.4：常驻层 id 集与渲染计数（T4 / T5）', () => {
  it('矩阵 8：legacy persona 与 user_portrait 都按 priority=-1 进常驻层（id 集含两者）', () => {
    const store = createSkeletonStore()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [
        fact('legacy-persona', '旧 persona 的 -1 强规则', { kind: 'persona', priority: -1 }),
        fact('portrait', '新 user_portrait 的 -1 强规则', { kind: 'user_portrait', priority: -1 }),
      ],
      capTokens: () => 2000,
    })

    return refresh('s1').then(() => {
      // 常驻层 id 集 = 骨架事实 + accepted 自省（只按 id，不做语义去重）。
      expect(store.idsFor('s1').has('legacy-persona')).toBe(true)
      expect(store.idsFor('s1').has('portrait')).toBe(true)
    })
  })

  it('矩阵 9：onRendered 回报 SkeletonRender 的计数（kept / keptInviolable / overBudget / truncated / tokens）', async () => {
    const store = createSkeletonStore()
    const rendered = vi.fn()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => [
        fact('pin', '不推送', { priority: -1 }),
        fact('plain', '普通', {}),
      ],
      capTokens: () => 2000,
      onRendered: rendered,
    })

    await refresh('s1')

    expect(rendered).toHaveBeenCalledTimes(1)
    const report = rendered.mock.calls[0]?.[0] as { kept: number; keptInviolable: number; overBudget: boolean; truncated: boolean; tokens: number }
    expect(report.kept).toBe(2)
    expect(report.keptInviolable).toBe(1)
    expect(report.overBudget).toBe(false)
    expect(report.truncated).toBe(false)
  })

  it('矩阵 6：同一会话重复刷新常驻层区块字节稳定（会话内缓存，INV-1）', async () => {
    const store = createSkeletonStore()
    const facts: SkeletonFact[] = [
      fact('pin', '不推送', { priority: -1 }),
    ]
    const refresh = createSkeletonRefresher({
      store,
      readFacts: async () => facts,
      capTokens: () => 2000,
    })

    await refresh('s1')
    const first = store.textFor('s1')
    await refresh('s1')
    const second = store.textFor('s1')
    expect(second).toBe(first)
    expect(store.idsFor('s1').size).toBe(1)
  })
})
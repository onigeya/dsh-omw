/**
 * T1 无损折叠的纯函数与编排（Story 8.3 第 5 轮 / 矩阵行 1–6、9）。
 *
 * 重点：分类只看 role、渲染逐字（含 tool-call 参数）、锚点确定性、fail-open 一定委托 stock。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildT1Summary,
  classifyT1,
  fnv1aAnchor,
  regionMessages,
  renderRegionText,
  summarizeWithT1,
  type T1MessageLike,
} from '../src/context/compaction-t1'

const text = (value: string): T1MessageLike => ({ role: 'user', content: [{ type: 'text', text: value }] })

describe('regionMessages（矩阵行 1、3）', () => {
  it('去掉开头唯一的 system head；没有 head 时保持原样', () => {
    const head: T1MessageLike = { role: 'system', content: 'sys' }
    expect(regionMessages([head, text('u')])).toEqual([text('u')])
    expect(regionMessages([text('u'), head])).toEqual([text('u'), head])
    expect(regionMessages([])).toEqual([])
  })
})

describe('classifyT1（矩阵行 1–4）', () => {
  it('只有 system head ⇒ 不是 T1（不能把系统提示本身当折叠对象）', () => {
    expect(classifyT1([{ role: 'system', content: 'sys' }])).toBe(false)
  })

  it('region 含 user 原话 ⇒ T1', () => {
    expect(classifyT1([{ role: 'system', content: 'sys' }, text('u'), { role: 'assistant', content: 'a' }])).toBe(true)
  })

  it('region 含 system 消息（受保护记忆的注入形态）⇒ T1', () => {
    expect(classifyT1([{ role: 'system', content: 'head' }, { role: 'system', content: 'memory: priority=-1' }])).toBe(true)
  })

  it('只有 assistant / tool ⇒ 不是 T1（走 stock T2/T3）', () => {
    expect(classifyT1([{ role: 'system', content: 'head' }, { role: 'assistant', content: 'a' }, { role: 'tool', content: 'r' }])).toBe(false)
  })
})

describe('renderRegionText / fnv1aAnchor（矩阵行 5）', () => {
  it('逐字渲染 role + 正文，保持顺序；非 text 块保留 JSON', () => {
    const rendered = renderRegionText([
      { role: 'system', content: 'head' },
      { role: 'user', content: '第一行\n第二行' },
      { role: 'tool', content: [{ type: 'text', text: '结果' }] },
    ])
    expect(rendered).toBe('[user]\n第一行\n第二行\n[tool]\n结果')
  })

  it('tool-call 参数按 JSON 保留（无损折叠不丢工具调用）', () => {
    const rendered = renderRegionText([
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }] },
    ])
    expect(rendered).toBe('[assistant]\n[tool-call]{"type":"tool-call","name":"read","arguments":"{\\"path\\":\\"a\\"}"}')
  })

  it('同一文本 ⇒ 同一负锚点；不同文本 ⇒ 不同锚点', () => {
    const a = fnv1aAnchor('x')
    expect(a).toBe(fnv1aAnchor('x'))
    expect(a).toBeLessThan(0)
    expect(fnv1aAnchor('y')).not.toBe(a)
  })
})

describe('buildT1Summary / summarizeWithT1 编排（fail-open 与路由）', () => {
  const fallback = (): Promise<{ marker: string }> => Promise.resolve({ marker: 'stock' })

  it('buildT1Summary 写句柄并返回句柄块，锚点与渲染文本一致', async () => {
    const writer = vi.fn(() => Promise.resolve({ id: 'h-1' }))
    const summary = await buildT1Summary({ messages: [text('原文')], sessionId: 's-1', writeHandle: writer })
    const call = writer.mock.calls[0]?.[0] as { sessionId: string, seq: number, text: string, tokens: number }
    expect(call.text).toBe('[user]\n原文')
    expect(call.seq).toBe(fnv1aAnchor('[user]\n原文'))
    expect(summary.summary[0]?.text).toContain('[omw:handle=h-1')
    expect(summary.provider).toBe('omw-t1-fold')
  })

  it('只读实例 ⇒ 委托 stock，不调 writer', async () => {
    const writer = vi.fn()
    const outcome = await summarizeWithT1({ messages: [text('u')], sessionId: 's', readonly: true, writeHandle: writer, fallback })
    expect(outcome.route).toBe('delegate')
    expect(writer).not.toHaveBeenCalled()
  })

  it('非 T1 ⇒ 委托 stock', async () => {
    const outcome = await summarizeWithT1({
      messages: [{ role: 'assistant', content: 'a' }],
      sessionId: 's',
      readonly: false,
      writeHandle: vi.fn(),
      fallback,
    })
    expect(outcome.route).toBe('delegate')
  })

  it('T1 但 writer 缺失 ⇒ 委托 stock + warn', async () => {
    const warn = vi.fn()
    const outcome = await summarizeWithT1({ messages: [text('u')], sessionId: 's', readonly: false, writeHandle: null, fallback, logger: { warn } })
    expect(outcome.route).toBe('delegate')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('T1 且 writer 抛错 ⇒ 委托 stock（INV-3）+ warn', async () => {
    const warn = vi.fn()
    const writer = vi.fn(() => Promise.reject(new Error('db down')))
    const outcome = await summarizeWithT1({ messages: [text('u')], sessionId: 's', readonly: false, writeHandle: writer, fallback, logger: { warn } })
    expect(outcome.route).toBe('delegate')
    expect(outcome.result).toEqual({ marker: 'stock' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('T1 且无会话 id ⇒ 委托 stock + warn', async () => {
    const warn = vi.fn()
    const outcome = await summarizeWithT1({ messages: [text('u')], sessionId: '', readonly: false, writeHandle: vi.fn(), fallback, logger: { warn } })
    expect(outcome.route).toBe('delegate')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('T1 成功 ⇒ 返回句柄块，writer 收到逐字原文与负锚点', async () => {
    const writer = vi.fn(() => Promise.resolve({ id: 'h-1' }))
    const outcome = await summarizeWithT1({ messages: [{ role: 'system', content: 'head' }, text('原文')], sessionId: 's-1', readonly: false, writeHandle: writer, fallback })
    expect(outcome.route).toBe('t1')
    const call = writer.mock.calls[0]?.[0] as { sessionId: string, seq: number, text: string, tokens: number }
    expect(call.sessionId).toBe('s-1')
    expect(call.text).toBe('[user]\n原文')
    expect(call.seq).toBe(fnv1aAnchor('[user]\n原文'))
    expect(call.tokens).toBeGreaterThan(0)
    expect(JSON.stringify(outcome.result)).toContain('[omw:handle=h-1')
  })
})

import { describe, expect, it } from 'vitest'
import { contentText, renderMessage, renderTranscript, sessionMessages } from '../src/capture/transcript'

describe('对话原文渲染（三钩子共用）', () => {
  it('contentText：字符串 / 数组（字符串与 {text} 混合）/ 对象 {text} / 其它 → 空串', () => {
    expect(contentText('hi')).toBe('hi')
    expect(contentText(['a', { text: 'b' }, { other: 1 }])).toBe('a\nb')
    expect(contentText({ text: 'c' })).toBe('c')
    expect(contentText(42)).toBe('')
    expect(contentText(null)).toBe('')
  })

  it('renderMessage：role 缺省 unknown；空内容消息渲染为空串', () => {
    expect(renderMessage({ role: 'user', content: '你好' })).toBe('user: 你好')
    expect(renderMessage({ content: 'x' })).toBe('unknown: x')
    expect(renderMessage({ role: 'assistant', content: '' })).toBe('')
    expect(renderMessage(undefined)).toBe('')
  })

  it('renderTranscript：跳过空消息、以空行分隔', () => {
    expect(renderTranscript([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: [{ text: '结果' }] },
    ])).toBe('user: 你好\n\ntool: 结果')
  })

  it('sessionMessages：无 deriveMessages / 非数组 / 抛错一律 []', () => {
    expect(sessionMessages({})).toEqual([])
    expect(sessionMessages({ deriveMessages: () => 'nope' })).toEqual([])
    expect(sessionMessages({ deriveMessages: () => { throw new Error('boom') } })).toEqual([])
    const messages = [{ role: 'user', content: 'ok' }]
    expect(sessionMessages({ deriveMessages: () => messages })).toBe(messages)
  })
})

/**
 * 确定性净化 pass 的纯函数测试（Story 8.6 / T1、矩阵行 1–8）。
 *
 * 重点：三条规则各自的命中面、code fence 与结构化载荷的排除、以及 INV-3 的 fail-open
 * （抛错 / 结果为空 / 长度异常一律回原文）。零开库、零 LLM。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PURIFY_OPTIONS,
  PURIFY_EXCEPTIONS,
  PURIFY_RULES,
  hitsException,
  isPureFillerLine,
  isStructuredLine,
  normalizePurifyOptions,
  purifyMessages,
  purifyText,
  type PurifyMessageLike,
} from '../src/context/purify'

/** 默认配置 + 覆盖项（默认 R2 关，矩阵行 2 要显式打开）。 */
function options(overrides: Partial<typeof DEFAULT_PURIFY_OPTIONS> = {}): typeof DEFAULT_PURIFY_OPTIONS {
  return { ...DEFAULT_PURIFY_OPTIONS, ...overrides }
}

describe('默认配置（AC:1868）', () => {
  it('开 R1 + R3、关 R2，minRemainder 24', () => {
    expect(DEFAULT_PURIFY_OPTIONS).toEqual({ r1: true, r2: false, r3: true, minRemainder: 24 })
    expect(PURIFY_RULES).toEqual(['R1', 'R2', 'R3'])
  })

  it('normalizePurifyOptions：缺字段回落默认值，非法 minRemainder 不下探负数', () => {
    expect(normalizePurifyOptions(null)).toEqual(DEFAULT_PURIFY_OPTIONS)
    expect(normalizePurifyOptions({ r2: true })).toEqual({ ...DEFAULT_PURIFY_OPTIONS, r2: true })
    expect(normalizePurifyOptions({ minRemainder: -8 }).minRemainder).toBe(0)
    expect(normalizePurifyOptions({ minRemainder: Number.NaN }).minRemainder).toBe(24)
  })
})

describe('矩阵行 1：R1 整行纯填充删除', () => {
  it('`Let me…` / `Go.` 整行被删，removedChars 增加，正文保留', () => {
    const text = 'Let me…\nGo.\nThe migration ordering is documented in AD-34.'
    const result = purifyText(text, options())
    expect(result.changed).toBe(true)
    expect(result.text).toBe('The migration ordering is documented in AD-34.')
    expect(result.ruleHits).toContain('R1')
    expect(result.removedChars).toBe(text.length - result.text.length)
    expect(result.removedTokens).toBeGreaterThanOrEqual(0)
  })

  it('纯标点/省略号行也算填充；带实质宾语的句子不是 R1 的对象', () => {
    expect(isPureFillerLine('…')).toBe(true)
    expect(isPureFillerLine('---')).toBe(true)
    expect(isPureFillerLine('Let me')).toBe(true)
    expect(isPureFillerLine('Let me check the file')).toBe(false)
    expect(isPureFillerLine('I will')).toBe(true)
    expect(isPureFillerLine('The release notes are ready')).toBe(false)
  })

  it('R1 关闭 ⇒ 填充行原样保留', () => {
    const text = 'Let me…\nGo.\nReal content stays here.'
    const result = purifyText(text, options({ r1: false }))
    expect(result.changed).toBe(false)
    expect(result.text).toBe(text)
  })
})

describe('矩阵行 2：R2 句内前缀剥离与 minRemainder 安全阀', () => {
  it('剩余长度 < minRemainder ⇒ 整行不动（默认 R2 关时也不动）', () => {
    const text = 'Let me check the file'
    // 默认配置本身 R2 关
    expect(purifyText(text, options()).text).toBe(text)
    // 打开 R2，但剩余 `check the file`（14 字符）< 24 ⇒ 安全阀拦住
    const withR2 = purifyText(text, options({ r2: true }))
    expect(withR2.changed).toBe(false)
    expect(withR2.text).toBe(text)
  })

  it('剩余长度 >= minRemainder ⇒ 剥离行首前缀', () => {
    const text = 'Let me verify the migration ordering table rows before we ship.'
    const result = purifyText(text, options({ r2: true }))
    expect(result.changed).toBe(true)
    expect(result.ruleHits).toEqual(['R2'])
    expect(result.text.startsWith('verify the migration ordering table rows')).toBe(true)
    expect(result.text).not.toContain('Let me')
  })

  it('minRemainder 可配；阈值之上的剩余长度才采纳', () => {
    const text = 'Let me check the file now'
    // `check the file now` = 18 字符
    expect(purifyText(text, options({ r2: true, minRemainder: 18 })).changed).toBe(true)
    expect(purifyText(text, options({ r2: true, minRemainder: 19 })).changed).toBe(false)
  })

  it('缩进行同样能剥离行首前缀，缩进原样保留', () => {
    const text = '  Let me verify the migration ordering table rows before we ship.'
    const result = purifyText(text, options({ r1: false, r2: true, r3: false }))
    expect(result.changed).toBe(true)
    expect(result.text).toBe('  verify the migration ordering table rows before we ship.')
  })
})

describe('矩阵行 3：惯用句例外表', () => {
  it('例外短语同时约束 R1 与 R2', () => {
    for (const phrase of PURIFY_EXCEPTIONS) {
      const line = phrase.charAt(0).toUpperCase() + phrase.slice(1) + ' if you need more detail on this.'
      expect(hitsException(line)).toBe(true)
      const result = purifyText(line, options({ r2: true, r1: true }))
      expect(result.changed).toBe(false)
      expect(result.text).toBe(line)
    }
  })

  it('例外表之外的同类前缀仍会被剥离（例外表不是「let me 全豁免」）', () => {
    const text = 'Let me verify the migration ordering table rows before we ship.'
    expect(hitsException(text)).toBe(false)
    expect(purifyText(text, options({ r2: true })).changed).toBe(true)
  })
})

describe('矩阵行 4：R3 复读塌缩', () => {
  it('连续复读行塌缩为一行；非连续重复保留', () => {
    const text = 'Now reading the config schema.\nNow reading the config schema.\nThen the next section.\nNow reading the config schema.'
    const result = purifyText(text, options())
    expect(result.ruleHits).toEqual(['R3'])
    expect(result.text.split('\n')).toHaveLength(3)
    expect(result.text).toBe('Now reading the config schema.\nThen the next section.\nNow reading the config schema.')
  })

  it('R3 关闭 ⇒ 复读保留', () => {
    const text = 'Repeated statement line.\nRepeated statement line.'
    expect(purifyText(text, options({ r3: false })).changed).toBe(false)
  })

  it('空白行不参与塌缩（只压自然语言复读）', () => {
    const text = 'A real statement here.\n\n\nB real statement here.'
    expect(purifyText(text, options()).changed).toBe(false)
  })
})

describe('矩阵行 5：code fence 内不净化', () => {
  it('fence 内的填充行原样，fence 外的填充行被删', () => {
    const text = [
      'Let me…',
      '```text',
      'Let me…',
      'Go.',
      '```',
      'Go.',
      'Real content after the fence.',
    ].join('\n')
    const result = purifyText(text, options())
    expect(result.changed).toBe(true)
    expect(result.text).toBe(['```text', 'Let me…', 'Go.', '```', 'Real content after the fence.'].join('\n'))
    expect(result.ruleHits).toEqual(['R1'])
  })

  it('未闭合 fence ⇒ 其后全部视为 fence 内（不净化）', () => {
    const text = 'Intro line stays.\n```\nLet me…\nGo.'
    const result = purifyText(text, options())
    expect(result.changed).toBe(false)
    expect(result.text).toBe(text)
  })
})

describe('矩阵行 6：结构化载荷不净化', () => {
  it('JSON / 日志 / 表格 / 逐字转录行被判为结构化', () => {
    expect(isStructuredLine('{"summary":"Let me…"}')).toBe(true)
    expect(isStructuredLine('["Go.", "Let me…"]')).toBe(true)
    expect(isStructuredLine('2026-11-17T12:00:00Z INFO Let me…')).toBe(true)
    expect(isStructuredLine('[ERROR] Let me…')).toBe(true)
    expect(isStructuredLine('| Let me… | Go. |')).toBe(true)
    expect(isStructuredLine('user: Let me…')).toBe(true)
    expect(isStructuredLine('[assistant]')).toBe(false)
    expect(isStructuredLine('Plain natural language line.')).toBe(false)
  })

  it('结构化行整段原样返回（即便内容是填充词）', () => {
    const text = [
      '{"action":"Let me…"}',
      '2026-11-17T12:00:00Z WARN Let me…',
      '| Let me… | Go. |',
      'user: Let me…',
    ].join('\n')
    expect(purifyText(text, options()).changed).toBe(false)
  })
})

describe('矩阵行 7：规则抛错 ⇒ 返回原文（fail-open / INV-3）', () => {
  it('选项读取抛错不外泄异常，返回原文', () => {
    const text = 'Let me…\nGo.\nReal content here.'
    const throwing = {
      get r1(): boolean {
        throw new Error('boom')
      },
      get r2(): boolean {
        return false
      },
      get r3(): boolean {
        return false
      },
      get minRemainder(): number {
        return 24
      },
    }
    const result = purifyText(text, throwing)
    expect(result.changed).toBe(false)
    expect(result.text).toBe(text)
    expect(result.ruleHits).toEqual([])
  })
})

describe('矩阵行 8：结果为空 / 长度异常 ⇒ 返回原文', () => {
  it('整段都是填充 ⇒ 结果为空 ⇒ 回原文', () => {
    const text = 'Let me…\nGo.\nOkay.'
    const result = purifyText(text, options())
    expect(result.text).toBe(text)
    expect(result.changed).toBe(false)
  })

  it('删掉超过 80% ⇒ 判为长度异常，回原文', () => {
    const filler = Array.from({ length: 10 }, () => 'Let me…').join('\n')
    const text = filler + '\nTiny.'
    const result = purifyText(text, options())
    // 删掉 10 行只剩 `Tiny.`（> 80%）⇒ 不敢改，回原文
    expect(result.changed).toBe(false)
    expect(result.text).toBe(text)
  })
})

describe('消息级净化 purifyMessages（T3/T4 的执行副本）', () => {
  const assistant = (text: string): PurifyMessageLike => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })

  it('user 原话永不净化，assistant 的 text/reasoning 被净化', () => {
    const messages: PurifyMessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'Let me…\nGo.' }] },
      assistant('Let me…\nGo.\nThe answer is 42.'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Let me…\nThinking about the answer.' }] },
      { role: 'tool', content: [{ type: 'tool-result', text: 'Let me…' }] },
    ]
    const result = purifyMessages(messages, options())
    expect(result.changed).toBe(true)
    expect(result.messages[0]).toBe(messages[0])
    const assistantText = result.messages[1]?.content as readonly { type: string; text?: string }[]
    expect(assistantText[0]?.text).toBe('The answer is 42.')
    const reasoning = result.messages[2]?.content as readonly { type: string; text?: string }[]
    expect(reasoning[0]?.text).toBe('Thinking about the answer.')
    // 非 text/reasoning 块原样
    expect(result.messages[3]).toBe(messages[3])
    expect(result.ruleHits).toEqual(['R1'])
    expect(result.removedChars).toBeGreaterThan(0)
    expect(result.sourceChars).toBeGreaterThan(0)
  })

  it('未改动的消息保持原引用（不无故复制）', () => {
    const clean: PurifyMessageLike = { role: 'assistant', content: [{ type: 'text', text: 'Clean sentence.' }] }
    const result = purifyMessages([clean], options())
    expect(result.changed).toBe(false)
    expect(result.messages[0]).toBe(clean)
    expect(result.ruleHits).toEqual([])
  })

  it('字符串 content 也按文本净化；骨架消息逐字保留', () => {
    const messages: PurifyMessageLike[] = [
      { role: 'assistant', content: 'Let me…\nGo.\nString content with real detail.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me…' }],
        source: { kind: 'omw-memory-dynamic' },
      },
    ]
    const result = purifyMessages(messages, options())
    expect(result.messages[0]?.content).toBe('String content with real detail.')
    expect(result.messages[1]).toBe(messages[1])
  })
})

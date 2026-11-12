/**
 * `/memory list` 与 `/memory show` 的库外测试（Story 1.8 / 解析 + 渲染 + 错误收敛）。
 *
 * 这里只测命令层：dep 全部是假的，因此能精确断言「传给 dep 的参数形态」
 * （`{limit}` / `{query, limit}` / `id`）与「钉死的输出文案」，包括 NULL/空值
 * 占位、摘要折叠与 60 字符截断。真实库上的过滤/排序/截断/L1_INBOX 可见性由
 * command-browse-db.test.ts 覆盖；只读实例由该文件的跨进程用例覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_SUBCOMMAND,
  MEMORY_LIST_USAGE,
  MEMORY_SHOW_SUBCOMMAND,
  MEMORY_SHOW_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
  type MemoryCommandDetail,
} from '../src/command'

function makeDeps(overrides: Partial<MemoryCommandDependencies> = {}): MemoryCommandDependencies {
  return {
    writeInbox: async () => {},
    listMemories: async () => [],
    getMemoryById: async () => null,
    getStatus: async () => ({
      layers: { L1: 0, L2: 0 },
      inboxes: { L1: 0, L2: 0 },
      failed: 0,
      embeddingMode: 'enabled',
      unembedded: 0,
      readonly: false,
    }),
    ...overrides,
  }
}

/** 一个「全部有值」的详情基座，测试里按需覆盖字段。 */
const FULL_DETAIL: MemoryCommandDetail = {
  id: 'id-9',
  layer: 'L1',
  kind: 'note',
  priority: 3,
  text: '文本',
  validAt: '2026-11-01T00:00:00.000Z',
  recordedAt: '2026-11-01T00:00:01.000Z',
  invalidAt: null,
  expiredAt: null,
  sourceRefs: ['msg-1'],
  embeddingModelId: 'bge-m3',
}

/** 从列表文案里取回 id 顺序（断言倒序/上限时用）。 */
function idsFromListText(text: string): string[] {
  return text
    .split('\n')
    .slice(1)
    .map((line) => /^- (\S+) \[/.exec(line)?.[1] ?? line)
}

describe('parseMemoryCommand（list / show 分支）', () => {
  it("' list' → 无关键词（省略 query，而不是 undefined 字段）", () => {
    expect(parseMemoryCommand(' list')).toEqual({ kind: 'list' })
    expect(parseMemoryCommand('list')).toEqual({ kind: 'list' })
  })

  it("'list RRF' → 关键词 RRF", () => {
    expect(parseMemoryCommand('list RRF')).toEqual({ kind: 'list', query: 'RRF' })
    expect(parseMemoryCommand('   list   RRF   ')).toEqual({ kind: 'list', query: 'RRF' })
  })

  it('关键词 trim 首尾但保留内部空白；纯空白关键词视为无关键词', () => {
    expect(parseMemoryCommand('  list   泛型   协变  ')).toEqual({ kind: 'list', query: '泛型   协变' })
    expect(parseMemoryCommand('list    ')).toEqual({ kind: 'list' })
  })

  it("'show <id>' → id（trim 首尾）", () => {
    expect(parseMemoryCommand(' show id-9')).toEqual({ kind: 'show', id: 'id-9' })
    expect(parseMemoryCommand('show   abc-123  ')).toEqual({ kind: 'show', id: 'abc-123' })
  })

  it("'show' 缺 id → invalid + show usage（矩阵行「show 缺 id」）", () => {
    expect(parseMemoryCommand(' show')).toEqual({ kind: 'invalid', usage: MEMORY_SHOW_USAGE })
    expect(parseMemoryCommand('show   ')).toEqual({ kind: 'invalid', usage: MEMORY_SHOW_USAGE })
  })

  it('子命令常量与默认上限符合契约', () => {
    expect(MEMORY_LIST_SUBCOMMAND).toBe('list')
    expect(MEMORY_SHOW_SUBCOMMAND).toBe('show')
    expect(MEMORY_LIST_DEFAULT_LIMIT).toBe(20)
    expect(MEMORY_LIST_USAGE).toContain('/memory list [关键词]')
    expect(MEMORY_SHOW_USAGE).toContain('/memory show <id>')
  })
})

describe('handler：list 的参数与渲染', () => {
  it('无关键词：dep 收到 {limit}（不带 query 字段），渲染钉死表头与每行', async () => {
    const listMemories = vi.fn(async () => [
      { id: 'id-1', layer: 'L1_INBOX', text: '第一条' },
      { id: 'id-2', layer: 'L2', text: '第二条' },
    ])
    const definition = createMemoryCommandDefinition(makeDeps({ listMemories }))

    const result = await definition.handler({ rawInput: ' list' })

    expect(listMemories).toHaveBeenCalledExactlyOnceWith({ limit: MEMORY_LIST_DEFAULT_LIMIT })
    expect(result.kind).toBe('success')
    expect(result.text).toBe([
      '记忆列表（共 2 条，最近优先）：',
      '- id-1 [L1_INBOX] 第一条',
      '- id-2 [L2] 第二条',
    ].join('\n'))
  })

  it('带关键词：dep 收到 {query, limit}；首行仍是钉死文案，关键词由命中行承载（不改写大小写）', async () => {
    const listMemories = vi.fn(async () => [{ id: 'id-rrf', layer: 'L1', text: 'RRF 融合' }])
    const definition = createMemoryCommandDefinition(makeDeps({ listMemories }))

    const result = await definition.handler({ rawInput: ' list RRF' })

    expect(listMemories).toHaveBeenCalledExactlyOnceWith({ query: 'RRF', limit: MEMORY_LIST_DEFAULT_LIMIT })
    expect(result.kind).toBe('success')
    // spec「输出格式钉死」只枚举了不带关键词的首行，故带关键词时也不回显关键词到表头。
    expect(result.text).toBe([
      '记忆列表（共 1 条，最近优先）：',
      '- id-rrf [L1] RRF 融合',
    ].join('\n'))
    expect(result.text).toContain('RRF')
    expect(idsFromListText(result.text ?? '')).toEqual(['id-rrf'])
  })

  it('空库（无关键词）→ 暂无记忆。', async () => {
    const definition = createMemoryCommandDefinition(makeDeps())
    const result = await definition.handler({ rawInput: ' list' })
    expect(result).toEqual({ kind: 'success', text: '暂无记忆。' })
  })

  it('无匹配 → 没有匹配「<关键词>」的记忆。（含关键词本身）', async () => {
    const definition = createMemoryCommandDefinition(makeDeps())
    const result = await definition.handler({ rawInput: ' list zzz-不存在' })
    expect(result).toEqual({ kind: 'success', text: '没有匹配「zzz-不存在」的记忆。' })
  })

  it('摘要：空白折叠为单空格；超 60 字符截断加 …（恰好 60 不截断）', async () => {
    const listMemories = vi.fn(async () => [
      { id: 'a', layer: 'L1', text: '  多   空白\n文本  ' },
      { id: 'b', layer: 'L1', text: 'x'.repeat(61) },
      { id: 'c', layer: 'L1', text: 'y'.repeat(60) },
    ])
    const definition = createMemoryCommandDefinition(makeDeps({ listMemories }))

    const lines = (await definition.handler({ rawInput: ' list' })).text?.split('\n') ?? []

    expect(lines[1]).toBe('- a [L1] 多 空白 文本')
    expect(lines[2]).toBe(`- b [L1] ${'x'.repeat(60)}…`)
    expect(lines[3]).toBe(`- c [L1] ${'y'.repeat(60)}`)
  })

  it('摘要按 code point 截断：第 61 个 code point 是增补平面字符时不劈代理对', async () => {
    const emoji = '🙂'
    const text = `${'b'.repeat(59)}${emoji}c`
    const listMemories = vi.fn(async () => [{ id: 'e', layer: 'L1', text }])
    const definition = createMemoryCommandDefinition(makeDeps({ listMemories }))

    const lines = ((await definition.handler({ rawInput: ' list' })).text ?? '').split('\n')

    expect(lines[1]).toBe(`- e [L1] ${'b'.repeat(59)}${emoji}…`)
    const rendered = lines[1] ?? ''
    for (let index = 0; index < rendered.length; index += 1) {
      const code = rendered.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = rendered.charCodeAt(index + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
    }
  })
})

describe('handler：show 的渲染', () => {
  it('全字段按 AC 顺序渲染（dep 收到 id），有值字段原样输出', async () => {
    const getMemoryById = vi.fn(async () => FULL_DETAIL)
    const definition = createMemoryCommandDefinition(makeDeps({ getMemoryById }))

    const result = await definition.handler({ rawInput: ' show id-9' })

    expect(getMemoryById).toHaveBeenCalledExactlyOnceWith('id-9')
    expect(result.text).toBe([
      '记忆 id-9：',
      'layer: L1',
      'kind: note',
      'priority: 3',
      'text: 文本',
      'valid_at: 2026-11-01T00:00:00.000Z',
      'recorded_at: 2026-11-01T00:00:01.000Z',
      'invalid_at: (空)',
      'expired_at: (空)',
      'source_refs: [msg-1]',
      'embedding_model_id: bge-m3',
    ].join('\n'))
  })

  it('NULL / 空串 → (空)，空数组 → []，空 source_refs → []（绝不出现 undefined）', async () => {
    const getMemoryById = vi.fn(async () => ({
      ...FULL_DETAIL,
      kind: '',
      priority: 0,
      invalidAt: null,
      expiredAt: null,
      sourceRefs: [],
      embeddingModelId: null,
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ getMemoryById }))

    const result = await definition.handler({ rawInput: ' show id-9' })

    expect(result.text).toBe([
      '记忆 id-9：',
      'layer: L1',
      'kind: (空)',
      'priority: 0',
      'text: 文本',
      'valid_at: 2026-11-01T00:00:00.000Z',
      'recorded_at: 2026-11-01T00:00:01.000Z',
      'invalid_at: (空)',
      'expired_at: (空)',
      'source_refs: []',
      'embedding_model_id: (空)',
    ].join('\n'))
    expect(result.text).not.toContain('undefined')
  })

  it('多行 text 仍保持「每字段一行」：换行被转义，不与真实字段行混淆', async () => {
    const newline = String.fromCharCode(10)
    const multiline = ['第一行', '第二行'].join(newline)
    const getMemoryById = vi.fn(async () => ({ ...FULL_DETAIL, text: multiline }))
    const definition = createMemoryCommandDefinition(makeDeps({ getMemoryById }))

    const result = await definition.handler({ rawInput: ' show id-9' })

    // 11 行 = 1 行标题 + 10 个字段行；text 里的换行若未转义会多出第 12 行。
    const rows = (result.text ?? '').split(newline)
    expect(rows).toHaveLength(11)
    expect(rows[4]).toContain('第一行')
    expect(rows[4]).toContain('第二行')
    expect(rows[4]).not.toBe('text: 第一行')
  })

  it('已失效墓碑照样返回，并原样展示 invalid_at / expired_at（AC3 的非对称是有意的）', async () => {
    const getMemoryById = vi.fn(async () => ({
      ...FULL_DETAIL,
      invalidAt: '2026-11-05T00:00:00.000Z',
      expiredAt: '2026-11-06T00:00:00.000Z',
      sourceRefs: ['msg-1', 'msg-2'],
    }))
    const definition = createMemoryCommandDefinition(makeDeps({ getMemoryById }))

    const result = await definition.handler({ rawInput: ' show id-9' })

    expect(result.kind).toBe('success')
    expect(result.text).toContain('invalid_at: 2026-11-05T00:00:00.000Z')
    expect(result.text).toContain('expired_at: 2026-11-06T00:00:00.000Z')
    expect(result.text).toContain('source_refs: [msg-1, msg-2]')
  })

  it('未知 id（dep 返回 null）→ error 含 id 与「未找到」，不抛出', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({ getMemoryById: async () => null }))

    const result = await definition.handler({ rawInput: ' show no-such-id' })

    expect(result.kind).toBe('error')
    expect(result.text).toContain('未找到')
    expect(result.text).toContain('no-such-id')
  })
})

describe('handler：usage 身份（矩阵行「详情缺参」「未知/暂无子命令」）', () => {
  it('show 缺参 → MEMORY_SHOW_USAGE 原样作为 error text', async () => {
    const definition = createMemoryCommandDefinition(makeDeps())

    const result = await definition.handler({ rawInput: ' show' })

    expect(result).toEqual({ kind: 'error', text: MEMORY_SHOW_USAGE })
  })

  it('未知子命令 → MEMORY_COMMAND_USAGE 原样作为 error text，且含四条子命令用法', async () => {
    const definition = createMemoryCommandDefinition(makeDeps())

    const result = await definition.handler({ rawInput: ' bogus' })

    expect(result).toEqual({ kind: 'error', text: MEMORY_COMMAND_USAGE })
    expect(MEMORY_COMMAND_USAGE).toContain('/memory remember <内容>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory list [关键词]')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory show <id>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory status')
  })
})

describe('handler：错误收敛（命令永不抛出）', () => {
  it('list dep 抛 Error → error 结果', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      listMemories: async () => { throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆') },
    }))

    const result = await definition.handler({ rawInput: ' list' })

    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
  })

  it('show dep 抛非 Error 值 → error 结果', async () => {
    const definition = createMemoryCommandDefinition(makeDeps({
      getMemoryById: async () => { throw 'plain-string-failure' },
    }))

    const result = await definition.handler({ rawInput: ' show id-9' })

    expect(result).toEqual({ kind: 'error', text: 'plain-string-failure' })
  })
})

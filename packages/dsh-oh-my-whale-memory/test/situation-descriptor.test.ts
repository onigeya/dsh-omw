/**
 * 处境描述符测试（Story 9.3 / T1、spec I/O 矩阵 1–4）。
 *
 * 断言对象是 `src/recall/situation.ts` 的**实际**契约：
 * - 矩阵 1：空/不可构建 ⇒ `null`，且调用方（`createSituatedRecall`）完全回退 v1
 *   纯相似度（单 lane、不重排、不 embed 改写文本），标 `fallback-v1` 降级；
 * - 矩阵 2：只有工具结果 ⇒ 描述符含 tools/files/errors（封闭词表），goal 为空串合法；
 * - 矩阵 3：描述符进日志只含封闭词表字段（`goalPresent/goalChars/tools/files/errors/
 *   recentUserTurns` 计数），**不含**目标原文、用户回合原文与任何凭据；
 * - 矩阵 4：事件乱序/重复 ⇒ 确定性去重与稳定序，两次构建逐字段相同。
 *
 * 全部纯函数 + 注入依赖，无真实时钟、无网络、无库。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SITUATION_ERROR_KINDS,
  SITUATION_USER_EVENT,
  buildSituationDescriptor,
  buildSituationEvents,
  classifyToolError,
  filesInText,
  filesInToolArguments,
  scrubSituationText,
  situationQueryText,
} from '../src/recall/situation'
import { createSituatedRecall, type SituatedRecallDeps } from '../src/recall/situated-recall'
import { buildSituatedRecallDetail } from '../src/recall/situated-ledger'
import type { RecallCoreResult, RecallResultItem } from '../src/recall/core'

const NOW = '2026-11-18T00:00:00.000Z'

const HIT: RecallResultItem = {
  id: 'id-1',
  layer: 'L1',
  kind: 'work_fact',
  priority: 0,
  text: '用户偏好 ESM',
  recordedAt: NOW,
}

function coreOf(results: readonly RecallResultItem[] = [HIT]): RecallCoreResult {
  return { total: results.length, results, degraded: false, hint: '混合检索（语义向量路 + 关键词路，RRF 融合排序）。' }
}

/** 只被「回退 v1」用例消费的最小依赖集（其余端口给空实现，若被调用即失败）。 */
function makeDeps(overrides: Partial<SituatedRecallDeps> = {}): SituatedRecallDeps {
  return {
    embedQuery: async () => [1, 0, 0, 0],
    recallLane: async () => coreOf(),
    llm: null,
    routeFor: () => null,
    reranker: null,
    systemOne: null,
    systemOneRerankEnabled: false,
    rerankTopN: 20,
    rerankTimeoutMs: 1_200,
    rrfK: 60,
    priorityWeight: 0.5,
    nowIso: () => NOW,
    nowMs: () => 0,
    ...overrides,
  }
}

describe('矩阵 1：空 session 尾部 ⇒ descriptor null；回退纯相似度', () => {
  it('没有可用信号 ⇒ null（不抛错）', () => {
    expect(buildSituationDescriptor({ events: [] })).toBeNull()
    // 未知事件类型 / 空白正文 / 空工具名都产不出字段 ⇒ 仍是 null。
    expect(buildSituationDescriptor({
      events: [
        { type: 'unknown/event', text: '有内容但不是参与类型' },
        { type: SITUATION_USER_EVENT, text: '   ' },
        { type: 'tool/call', tool: '   ' },
      ],
    })).toBeNull()
  })

  it('描述符为 null ⇒ 单 lane v1 纯相似度、不重排、不 embed 改写文本，标 fallback-v1', async () => {
    const embedQuery = vi.fn(async () => [1, 0, 0, 0])
    const recallLane = vi.fn(async () => coreOf())
    const rerank = vi.fn()
    const judge = vi.fn()
    const recall = createSituatedRecall(makeDeps({
      embedQuery,
      recallLane,
      reranker: { rerank },
      systemOne: { judge },
      systemOneRerankEnabled: true,
    }))

    const outcome = await recall({ query: '召回 RRF', limit: 5, descriptor: null })

    // 恰好一次 lane 调用，查询串就是原 query（没有改写 lane、没有 poolLimit 放大）。
    expect(recallLane).toHaveBeenCalledExactlyOnceWith({
      query: '召回 RRF',
      queryVector: [1, 0, 0, 0],
      limit: 5,
    })
    expect(embedQuery).toHaveBeenCalledExactlyOnceWith('召回 RRF', undefined)
    expect(rerank).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()

    expect(outcome.audit.mode).toBe('fallback-v1')
    expect(outcome.audit.rewrite).toEqual({ lanes: [], degraded: true, reason: 'no-descriptor' })
    expect(outcome.audit.counts).toEqual({ original: 1, rewritten: 0, merged: 1, pinned: 0 })
    expect(outcome.core.degraded).toBe(true)
    expect(outcome.core.hint).toContain('回退 v1 纯相似度召回')
    expect(outcome.core.results.map((item) => item.id)).toEqual(['id-1'])
  })
})

describe('矩阵 2：只有工具结果 ⇒ tools/files/errors（封闭词表）', () => {
  it('工具调用给 tools/files，工具结果只挖路径与错误档（不落正文）', () => {
    const descriptor = buildSituationDescriptor({
      events: [
        { type: 'tool/call', tool: 'read_file', files: ['src/recall/rerank.ts'] },
        { type: 'tool/result', text: 'ETIMEDOUT reading D:\\worktree\\src\\a.ts', ok: false },
      ],
    })
    expect(descriptor).not.toBeNull()
    // goal 为空串是合法态：这段尾部没有用户回合。
    expect(descriptor?.goal).toBe('')
    expect(descriptor?.recentUserTurns).toEqual([])
    expect(descriptor?.tools).toEqual(['read_file'])
    // 结构化提示 + 从 tool/result 正文挖出的路径都归一化为 `/` 分隔并升序。
    // 注：`D:\worktree\src\a.ts` 的盘符 `D:` 后没有紧随字符，FILE_PATH_PATTERN 只吃
    // 到 `worktree\src\a.ts`（归一化后去掉首段，不带盘符）——这是实现的实际契约。
    expect(descriptor?.files).toEqual(['src/recall/rerank.ts', 'worktree/src/a.ts'])
    // 错误正文不进描述符，只留封闭档。
    expect(descriptor?.errors).toEqual(['timeout'])
    expect(JSON.stringify(descriptor)).not.toContain('ETIMEDOUT')
  })

  it('错误只按形态归入封闭档；描述符里的档名永不越出 SITUATION_ERROR_KINDS', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['request timeout after 30s', 'timeout'],
      ['operation aborted by signal', 'aborted'],
      ['HTTP 404 not found', 'http_4xx'],
      ['HTTP 503 service unavailable', 'http_5xx'],
      ['something exploded', 'tool_error'],
    ]
    for (const [text, expected] of cases) {
      expect(classifyToolError(text), text).toBe(expected)
    }
    const descriptor = buildSituationDescriptor({
      events: cases.map(([text]) => ({ type: 'tool/result', text, ok: false })),
    })
    // 去重后按封闭词表顺序输出（不是文本出现顺序）。
    expect(descriptor?.errors).toEqual(['timeout', 'aborted', 'http_4xx', 'http_5xx', 'tool_error'])
    for (const kind of descriptor?.errors ?? []) expect(SITUATION_ERROR_KINDS).toContain(kind)
  })

  it('文件路径识别需要分隔符（裸词不当文件名）；参数解析吃 JSON 串与对象两种形态', () => {
    expect(filesInText('看 src/a.ts 与裸词 hello')).toEqual(['src/a.ts'])
    expect(filesInToolArguments('{"file_path":"src\\\\a.ts"}')).toEqual(['src/a.ts'])
    expect(filesInToolArguments({ files: ['./b.ts', '  ', 7] })).toEqual(['b.ts'])
    expect(filesInToolArguments('not json at all: src/c.ts')).toEqual(['src/c.ts'])
    expect(filesInToolArguments(null)).toEqual([])
  })
})

describe('矩阵 3：描述符日志只含封闭词表字段（无原始正文 / 凭据）', () => {
  const SECRET = 'sk-live-abcdefgh12345678'

  it('credential 形态在描述符原文里就被脱敏（NFR9：脱敏先于截断）', () => {
    // 三类凭据形态各一条（Bearer / sk- 前缀 / key=value）。
    expect(scrubSituationText('Authorization: Bearer abcdefgh12345678', 200)).not.toContain('abcdefgh12345678')
    expect(scrubSituationText(`用 ${SECRET} 调接口`, 200)).not.toContain(SECRET)
    expect(scrubSituationText('api_key=zzzzzzzzzzzz', 200)).toContain('[redacted]')
    // 控制字符被压成单行空格（日志与检索式都是单行）。
    expect(scrubSituationText('第一行\n第二行\t带制表', 200)).toBe('第一行 第二行 带制表')
  })

  it('账本 detail 只含封闭字段：目标正文、用户回合原文与凭据一律不落', () => {
    const descriptor = buildSituationDescriptor({
      events: [
        { type: SITUATION_USER_EVENT, text: `把 access_token=${SECRET} 换掉，再看 src/recall/rerank.ts` },
        // 文件路径只从工具面（call 的结构化参数 / result 正文）识别，不从用户回合里挖。
        { type: 'tool/call', tool: 'memory_remember', files: ['src/recall/rerank.ts'] },
        { type: 'tool/result', text: 'HTTP 500 from https://api.example.com', ok: false },
      ],
    })
    expect(descriptor).not.toBeNull()

    const detail = buildSituatedRecallDetail({
      descriptor: descriptor!,
      rewrite: { lanes: ['context-rewrite', 'hyde'], degraded: false },
      mode: 'reranker-only',
      degraded: true,
      degradedReason: 'rerank:systemone-disabled',
      latencyMs: 123.6,
      overSoftTarget: false,
      counts: { original: 7, rewritten: 4, merged: 5, pinned: 1 },
    })

    // 顶层键集封闭。
    expect(Object.keys(JSON.parse(detail) as object).sort()).toEqual([
      'counts', 'degraded', 'descriptor', 'latencyMs', 'mode', 'overSoftTarget', 'reason', 'rewrite',
    ])
    // 描述符投影键集封闭：只留计数与标识，goal 原文与回合正文都没有键可落。
    const projection = (JSON.parse(detail) as { descriptor: Record<string, unknown> }).descriptor
    expect(Object.keys(projection).sort()).toEqual([
      'errors', 'files', 'goalChars', 'goalPresent', 'recentUserTurns', 'tools',
    ])
    expect(projection.goalPresent).toBe(true)
    expect(projection.goalChars).toBeGreaterThan(0)
    expect(projection.recentUserTurns).toBe(1)

    // 凭据、目标原文、用户回合正文都不在日志里；工具名/文件路径/错误档是允许的标识。
    expect(detail).not.toContain(SECRET)
    expect(detail).not.toContain('换掉')
    expect(detail).not.toContain('Bearer')
    expect(detail).toContain('src/recall/rerank.ts')
    expect(detail).toContain('http_5xx')
    // 数值取整、模式与原因可见（NFR12）。
    expect(JSON.parse(detail)).toMatchObject({
      mode: 'reranker-only',
      degraded: true,
      reason: 'rerank:systemone-disabled',
      latencyMs: 124,
    })
  })

  it('描述符为 null 时 detail 的 descriptor 为 null（不编造空对象）', () => {
    const detail = buildSituatedRecallDetail({
      descriptor: null,
      rewrite: { lanes: [], degraded: true, reason: 'no-descriptor' },
      mode: 'fallback-v1',
      degraded: true,
      degradedReason: 'no-descriptor',
      latencyMs: 1,
      overSoftTarget: false,
      counts: { original: 0, rewritten: 0, merged: 0, pinned: 0 },
    })
    expect(JSON.parse(detail)).toMatchObject({ descriptor: null, mode: 'fallback-v1' })
  })
})

describe('矩阵 4：事件乱序 / 重复 ⇒ 确定性去重与稳定序', () => {
  const events = [
    { type: 'tool/call', tool: 'zeta' },
    { type: 'tool/call', tool: 'alpha' },
    { type: 'tool/call', tool: 'zeta' },
    { type: 'tool/result', text: 'gateway returned HTTP 503', ok: false },
    { type: 'tool/result', text: 'user aborted the run', ok: false },
    { type: 'tool/result', text: 'gateway returned HTTP 503', ok: false },
    { type: 'tool/result', text: './src/b.ts 与 src/a.ts 都改过' },
  ]

  it('正序与逆序输入给出逐字段相同的描述符（tools/files/errors 去重 + 升序/词表序）', () => {
    const forward = buildSituationDescriptor({ events })
    const reversed = buildSituationDescriptor({ events: [...events].reverse() })

    expect(forward).not.toBeNull()
    expect(reversed).toEqual(forward)
    expect(forward?.tools).toEqual(['alpha', 'zeta'])
    expect(forward?.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(forward?.errors).toEqual(['aborted', 'http_5xx'])
  })

  it('同一输入构建两次结果相同（无时钟 / 无随机）', () => {
    const once = buildSituationDescriptor({ events })
    const twice = buildSituationDescriptor({ events })
    expect(twice).toEqual(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('用户回合去重取尾部 3 条（重复只留最后一次出现）；goal 与最后一条同源', () => {
    const descriptor = buildSituationDescriptor({
      events: ['修 A', '修 B', '修 B', '修 C', '修 D'].map((text) => ({ type: SITUATION_USER_EVENT, text })),
    })
    expect(descriptor?.recentUserTurns).toEqual(['修 B', '修 C', '修 D'])
    expect(descriptor?.goal).toBe('修 D')
  })

  it('标识与错误超过上限时截断（工具 8 / 文件 8），仍是稳定序', () => {
    const descriptor = buildSituationDescriptor({
      events: [
        ...Array.from({ length: 12 }, (_, index) => ({ type: 'tool/call', tool: 'tool-' + String(index).padStart(2, '0') })),
        ...Array.from({ length: 12 }, (_, index) => ({ type: 'tool/result', text: 'src/f' + String(index).padStart(2, '0') + '.ts' })),
      ],
    })
    expect(descriptor?.tools).toHaveLength(8)
    expect(descriptor?.files).toHaveLength(8)
    expect(descriptor?.tools[0]).toBe('tool-00')
    expect(descriptor?.files[0]).toBe('src/f00.ts')
  })
})

describe('宿主消息 → 描述符事件（buildSituationEvents 的窄视图）', () => {
  it('只认 user / assistant(tool-call) / tool 三类；其余忽略', () => {
    const events = buildSituationEvents([
      { role: 'user', content: '看 src/a.ts' },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read_file', arguments: '{"file_path":"src/a.ts"}' }] },
      { role: 'tool', content: 'ok', isError: false },
      { role: 'system', content: '系统提示不参与' },
    ])
    expect(events.map((event) => event.type)).toEqual([SITUATION_USER_EVENT, 'tool/call', 'tool/result'])
    expect(events[1]).toMatchObject({ tool: 'read_file', files: ['src/a.ts'] })
    expect(events[2]).toMatchObject({ ok: true })
    expect(events[2]?.errorKind).toBeUndefined()
  })

  it('isError=true 的 tool 消息带封闭错误档；再由描述符收敛成 errors', () => {
    const events = buildSituationEvents([{ role: 'tool', content: 'HTTP 502 bad gateway', isError: true }])
    expect(events[0]).toMatchObject({ type: 'tool/result', ok: false, errorKind: 'http_5xx' })
    expect(buildSituationDescriptor({ events })?.errors).toEqual(['http_5xx'])
  })

  it('处境原文把描述符拍成单行检索式（goal 与回合重复项只出现一次）', () => {
    const descriptor = buildSituationDescriptor({
      events: [
        { type: SITUATION_USER_EVENT, text: '修召回降级' },
        { type: 'tool/call', tool: 'memory_recall' },
        { type: 'tool/result', text: 'src/recall/rerank.ts', ok: false },
      ],
    })
    expect(situationQueryText(descriptor!)).toBe('修召回降级 memory_recall src/recall/rerank.ts tool_error')
  })
})

/**
 * System One 忠实性客户端（Story 2.5 / AC:674、U9、U12、AD-15）。
 *
 * 本文件不碰 LadybugDB（无开库），因此不受每进程约 15 个实例的上限约束。
 * 上游契约按 `_bmad-output/implementation-artifacts/brief-2-5-readiness.md` §1 与
 * Jev 客户端 `_validateQuestions` 实测：`questions` 必须是 key→question 的**对象**
 * （数组会被上游 400 拒绝），noul 返回 [0,1] 浮点。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SYSTEMONE_MODEL,
  SYSTEMONE_NOUL_THRESHOLD,
  createSystemOneClient,
  resetSystemOneRuntimeState,
  setSystemOneEnabled,
  systemOneRuntimeState,
  type SystemOneQuestions,
} from '../src/distill/system-one'

const QUESTIONS: SystemOneQuestions = {
  faithful: { type: 'noul', instructions: '该陈述是否忠实于所给来源？' },
  'no-conflict': { type: 'noul', instructions: '是否与来源冲突？' },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  setSystemOneEnabled(true)
  resetSystemOneRuntimeState()
})

describe('createSystemOneClient', () => {
  it('成功路径：请求体逐字 { model, state, questions }（questions 是对象不是数组），概率原样返回', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: DEFAULT_SYSTEMONE_MODEL, answers: { faithful: { type: 'noul', noul: 0.91 }, 'no-conflict': { type: 'noul', noul: 0.77 } } }),
    )
    const client = createSystemOneClient({ fetch: fetchImpl as unknown as typeof fetch })
    const result = await client.judge('state-正文', QUESTIONS, new AbortController().signal)

    expect(result).toEqual({ ok: true, answers: { faithful: 0.91, 'no-conflict': 0.77 } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/systemone')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>
    // AD-15：请求体字段名是 state，不是 content；questions 是对象映射。
    expect(sent.state).toBe('state-正文')
    expect(sent.model).toBe('Kev-4b')
    expect(Array.isArray(sent.questions)).toBe(false)
    expect(Object.keys(sent.questions as Record<string, unknown>)).toEqual(['faithful', 'no-conflict'])
  })

  it('端点归一化：自定义端点补 /v1/systemone，已带后缀则不重复追加', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return jsonResponse({ answers: { faithful: { noul: 0.9 }, 'no-conflict': { noul: 0.9 } } })
    }) as unknown as typeof fetch
    const signal = new AbortController().signal

    await createSystemOneClient({ endpoint: 'https://example.com', fetch: fetchImpl }).judge('s', QUESTIONS, signal)
    await createSystemOneClient({ endpoint: 'https://example.com/v1/systemone', fetch: fetchImpl }).judge('s', QUESTIONS, signal)

    expect(calls).toEqual(['https://example.com/v1/systemone', 'https://example.com/v1/systemone'])
  })

  it('答案缺失 / 概率越界 → ok:false 且 reason 精确（不猜测、不填 0）', async () => {
    const missing = createSystemOneClient({
      fetch: (async () => jsonResponse({ answers: { faithful: { noul: 0.9 } } })) as unknown as typeof fetch,
    })
    expect(await missing.judge('s', QUESTIONS, new AbortController().signal)).toMatchObject({ ok: false, reason: 'missing-answer' })

    const bad = createSystemOneClient({
      fetch: (async () =>
        jsonResponse({ answers: { faithful: { noul: 1.2 }, 'no-conflict': { noul: 0.5 } } })) as unknown as typeof fetch,
    })
    expect(await bad.judge('s', QUESTIONS, new AbortController().signal)).toMatchObject({ ok: false, reason: 'bad-probability' })
  })

  it('配置态关闭 → disabled-by-config 且不发请求', async () => {
    setSystemOneEnabled(false)
    const fetchImpl = vi.fn()
    const client = createSystemOneClient({ fetch: fetchImpl as unknown as typeof fetch })
    const result = await client.judge('s', QUESTIONS, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, reason: 'disabled-by-config' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('U12：连续 3 次失败打开运行态降级，随后一次成功立即复原（阈值常量锁定）', async () => {
    const failing = createSystemOneClient({
      fetch: (async () => jsonResponse({}, 503)) as unknown as typeof fetch,
      now: () => new Date('2026-11-13T00:00:00.000Z'),
    })
    const signal = new AbortController().signal

    expect((await failing.judge('s', QUESTIONS, signal)).ok).toBe(false)
    expect(systemOneRuntimeState().degraded).toBe(false)
    await failing.judge('s', QUESTIONS, signal)
    expect(systemOneRuntimeState().degraded).toBe(false)
    await failing.judge('s', QUESTIONS, signal)
    const degraded = systemOneRuntimeState()
    expect(degraded.degraded).toBe(true)
    expect(degraded.since).toBe('2026-11-13T00:00:00.000Z')
    expect(degraded.lastReason).toBe('http-503')

    const healthy = createSystemOneClient({
      fetch: (async () =>
        jsonResponse({ answers: { faithful: { noul: 0.8 }, 'no-conflict': { noul: 0.8 } } })) as unknown as typeof fetch,
    })
    await healthy.judge('s', QUESTIONS, signal)
    expect(systemOneRuntimeState()).toMatchObject({ degraded: false, since: null, consecutiveFailures: 0 })
  })

  it('网络异常与坏 JSON 都收敛成 ok:false（失败不抛，交由调用方决定重试归属）', async () => {
    const throwing = createSystemOneClient({
      fetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    expect(await throwing.judge('s', QUESTIONS, new AbortController().signal)).toMatchObject({ ok: false, reason: 'request-failed' })

    const badJson = createSystemOneClient({
      fetch: (async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    })
    expect(await badJson.judge('s', QUESTIONS, new AbortController().signal)).toMatchObject({ ok: false, reason: 'bad-json' })

    const noAnswers = createSystemOneClient({
      fetch: (async () => jsonResponse({ model: 'x' })) as unknown as typeof fetch,
    })
    expect(await noAnswers.judge('s', QUESTIONS, new AbortController().signal)).toMatchObject({ ok: false, reason: 'bad-answers' })
  })

  it('空 questions 直接拒绝（上游同样要求非空）', async () => {
    const fetchImpl = vi.fn()
    const client = createSystemOneClient({ fetch: fetchImpl as unknown as typeof fetch })
    expect(await client.judge('s', {}, new AbortController().signal)).toMatchObject({ ok: false, reason: 'no-questions' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('阈值常量是插件侧判定的单一来源（AD-15：noul 是概率不是布尔）', () => {
    expect(SYSTEMONE_NOUL_THRESHOLD).toBe(0.5)
  })
})

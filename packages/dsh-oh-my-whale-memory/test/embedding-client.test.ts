/**
 * embeddings 客户端契约测试（Story 2.3 / N4）。
 *
 * 契约：POST {endpoint}/embeddings（已以 /embeddings 结尾则不重复）；Bearer + JSON；
 * 体 { model, input: string[] }；单请求 ≤8 条；按 index 对齐；**失败一律 ok:false 不抛错**，
 * 让调用方得以「只记审计、L1 照常写入、embedding 两列留空」。
 */
import { describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MAX_BATCH, createEmbeddingClient } from '../src/embedding/client'

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as unknown as Response

interface Captured {
  readonly url: string
  readonly init: RequestInit
}

function capturingFetch(response: Response | (() => Promise<Response>)): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return typeof response === 'function' ? response() : response
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const client = (overrides: { fetch: typeof fetch; endpoint?: string; dim?: number }) =>
  createEmbeddingClient({
    endpoint: overrides.endpoint ?? 'http://127.0.0.1:9999/v1',
    token: 'sk-secret',
    dim: overrides.dim ?? 4,
    fetch: overrides.fetch,
  })

describe('请求形态', () => {
  it('拼 /embeddings、带 Bearer 与 JSON 体，并按 index 对齐返回', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse({
      data: [{ embedding: [1, 0, 0, 0] }, { embedding: [0, 1, 0, 0] }],
    }))
    const result = await client({ fetch }).embed('bge-m3', ['甲', '乙'], AbortSignal.timeout(1_000))
    expect(result).toEqual({ ok: true, vectors: [[1, 0, 0, 0], [0, 1, 0, 0]] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/v1/embeddings')
    const init = calls[0]!.init
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'bge-m3', input: ['甲', '乙'] })
  })

  it('endpoint 已以 /embeddings 结尾（含尾斜杠）时不重复追加', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse({ data: [{ embedding: [1, 0, 0, 0] }] }))
    const c = client({ fetch, endpoint: 'http://host/v1/embeddings/' })
    await c.embed('m', ['x'], AbortSignal.timeout(1_000))
    expect(calls[0]!.url).toBe('http://host/v1/embeddings')
  })

  it('评审 T5：乱序返回按 data[].index 落位（不错配到别的文本上）', async () => {
    const { fetch } = capturingFetch(jsonResponse({
      data: [{ index: 1, embedding: [0, 1, 0, 0] }, { index: 0, embedding: [1, 0, 0, 0] }],
    }))
    const result = await client({ fetch }).embed('m', ['甲', '乙'], AbortSignal.timeout(1_000))
    expect(result).toEqual({ ok: true, vectors: [[1, 0, 0, 0], [0, 1, 0, 0]] })
  })

  it('评审 T5：index 重复 / 越界 ⇒ ok:false（宁可无向量也不错配）', async () => {
    const dup = capturingFetch(jsonResponse({
      data: [{ index: 0, embedding: [1, 0, 0, 0] }, { index: 0, embedding: [0, 1, 0, 0] }],
    }))
    expect(await client({ fetch: dup.fetch }).embed('m', ['甲', '乙'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'index-duplicate' })

    const outOfRange = capturingFetch(jsonResponse({
      data: [{ index: 9, embedding: [1, 0, 0, 0] }, { index: 0, embedding: [0, 1, 0, 0] }],
    }))
    expect(await client({ fetch: outOfRange.fetch }).embed('m', ['甲', '乙'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'index-out-of-range' })
  })

  it('空输入不发请求', async () => {
    const spy = vi.fn()
    const { fetch } = capturingFetch(jsonResponse({ data: [] }))
    const result = await client({ fetch: spy.mockImplementation(fetch as never) }).embed('m', [], AbortSignal.timeout(1_000))
    expect(result).toEqual({ ok: true, vectors: [] })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('失败一律 ok:false（N4）', () => {
  it('超过单请求上限的条数直接拒绝且不发请求', async () => {
    const spy = vi.fn()
    const result = await client({ fetch: spy as unknown as typeof fetch })
      .embed('m', Array.from({ length: EMBEDDING_MAX_BATCH + 1 }, (_, i) => 't' + i), AbortSignal.timeout(1_000))
    expect(result).toMatchObject({ ok: false, reason: 'batch-too-large' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('HTTP 非 2xx → http-<status>', async () => {
    const { fetch } = capturingFetch(jsonResponse({}, 503))
    expect(await client({ fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'http-503' })
  })

  it('响应不是 JSON → bad-json', async () => {
    const { fetch } = capturingFetch({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as unknown as Response)
    expect(await client({ fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'bad-json' })
  })

  it('条数不符 → count-mismatch；维度不符或非数字 → dim-mismatch', async () => {
    const one = capturingFetch(jsonResponse({ data: [] }))
    expect(await client({ fetch: one.fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'count-mismatch' })

    const short = capturingFetch(jsonResponse({ data: [{ embedding: [1, 0] }] }))
    expect(await client({ fetch: short.fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'dim-mismatch' })

    const notNumber = capturingFetch(jsonResponse({ data: [{ embedding: [1, 0, 0, 'x'] }] }))
    expect(await client({ fetch: notNumber.fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'dim-mismatch' })
  })

  it('网络异常 → request-failed（不抛错）', async () => {
    const { fetch } = capturingFetch(async () => { throw new Error('ECONNREFUSED') })
    expect(await client({ fetch }).embed('m', ['x'], AbortSignal.timeout(1_000)))
      .toMatchObject({ ok: false, reason: 'request-failed' })
  })
})

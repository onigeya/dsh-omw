/**
 * OpenAI 兼容 embeddings 客户端（Story 2.3 / N4）。
 *
 * - `POST {endpoint}/embeddings`（endpoint 已以 /embeddings 结尾则不重复追加）；不写默认 base URL。
 * - 请求头 `Authorization: Bearer {token}` + `Content-Type: application/json`；体 `{ model, input: string[] }`。
 * - 单请求 `input` ≤ 8 条；响应 `{ data: [{ embedding, index }] }` **按 index 落位**（评审 T5：
 *   提供方乱序返回时不能把向量挂到错误文本上）；缺失 index 才回退位置序，index 重复/越界/缺位即失败。
 * - 超时 ≤10s（AbortSignal，与调用方任务预算的 signal 合并）；失败**不抛错**，返回 ok:false——
 *   调用方必须让 L1 照常写入、只记审计、embedding 两列留空（N4）。
 */

/** 单次请求的最大文本条数。 */
export const EMBEDDING_MAX_BATCH = 8

/** 默认超时（毫秒）。 */
export const EMBEDDING_TIMEOUT_MS = 10_000

export type EmbedResult =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | { readonly ok: false; readonly reason: string; readonly message: string }

export interface EmbedClient {
  /**
   * 对一批文本取向量。失败返回 ok:false（reason 自由字符串），不抛错——
   * 调用方据此只记审计、不阻塞 L1 写入。
   */
  embed(model: string, input: readonly string[], signal: AbortSignal): Promise<EmbedResult>
}

export interface EmbeddingClientOptions {
  readonly endpoint: string
  readonly token: string
  readonly dim: number
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/** 组装 embeddings 客户端（结构端口，fetch 可注入假实现）。 */
export function createEmbeddingClient(options: EmbeddingClientOptions): EmbedClient {
  const base = options.endpoint.trim().replace(/\/+$/u, '')
  const url = base.endsWith('/embeddings') ? base : base + '/embeddings'
  const dim = options.dim
  const timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    async embed(model, input, signal) {
      if (input.length === 0) return { ok: true, vectors: [] }
      if (input.length > EMBEDDING_MAX_BATCH) {
        return { ok: false, reason: 'batch-too-large', message: `单次请求最多 ${EMBEDDING_MAX_BATCH} 条，实际 ${input.length}` }
      }
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + options.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, input: Array.from(input) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
      } catch (error) {
        return { ok: false, reason: 'request-failed', message: error instanceof Error ? error.message : String(error) }
      }
      if (!response.ok) {
        return { ok: false, reason: 'http-' + response.status, message: 'embeddings HTTP ' + response.status }
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'bad-json', message: 'embeddings 响应不是合法 JSON' }
      }
      const data = (body as { readonly data?: unknown } | null)?.data
      if (!Array.isArray(data) || data.length !== input.length) {
        return { ok: false, reason: 'count-mismatch', message: 'embeddings 返回条数与输入不符' }
      }
      // 按 data[i].index 落位（评审 T5）：只按数组位置 push 会把乱序响应静默错配到别的文本上。
      const slots: (readonly number[] | null)[] = input.map(() => null)
      let positional = 0
      for (const item of data) {
        const record = item as { readonly embedding?: unknown; readonly index?: unknown } | null
        const rawIndex = record?.index
        const slot = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
          ? Math.trunc(rawIndex)
          : positional
        positional += 1
        if (!Number.isInteger(slot) || slot < 0 || slot >= input.length) {
          return { ok: false, reason: 'index-out-of-range', message: 'embeddings 返回的 index 越界：' + String(rawIndex) }
        }
        if (slots[slot] !== null) {
          return { ok: false, reason: 'index-duplicate', message: 'embeddings 返回的 index 重复：' + String(slot) }
        }
        const embedding = record?.embedding
        if (!Array.isArray(embedding) || embedding.length !== dim || embedding.some((v) => typeof v !== 'number')) {
          return {
            ok: false,
            reason: 'dim-mismatch',
            message: 'embeddings 向量维度与配置 dim 不符（应 ' + dim + '）',
          }
        }
        slots[slot] = (embedding as readonly number[]).map(Number)
      }
      if (slots.some((vector) => vector === null)) {
        return { ok: false, reason: 'index-missing', message: 'embeddings 返回的 index 未覆盖全部输入' }
      }
      return { ok: true, vectors: slots as (readonly number[])[] }
    },
  }
}

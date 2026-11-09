/**
 * Config schema 与运行时配置投影（Story 1.3）。
 *
 * 契约锁定（见 spec frozen block / AD-9 / AD-11 / FR-18）：
 * - 凭据字段命名 `token` 且标 `.role('secret')`——redact.ts 按 node.meta?.role === 'secret' 判定，
 *   字段名不参与脱敏判定（AD-9）。
 * - 所有进 /settings 表单的字段标 `.volatile()`——宿主 volatileForm() 只递归 volatile 节点（AD-11）。
 * - 嵌套对象（embedding / rerank / layerWeights / systemOne）整体 `.volatile()`，子字段保持 plain：
 *   schemastery 的 validateVolatileSchema 硬约束禁止 volatile 嵌套 volatile，否则启动即抛
 *   ValidationError('volatile fields require a fixed object path without an enclosing volatile field')。
 * - ReRank 字段 v2 预留：schema 先落，v1 不消费、不校验（本文件 resolveRuntimeConfig 不触达 rerank）。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** Volatile 子对象：整体标 .volatile()，子字段保持 plain（AD-11 / Design Notes）。 */
const EmbeddingSchema = Schema.object({
  endpoint: Schema.string(),
  token: Schema.string().role('secret'),
  model: Schema.string(),
}).default({}).volatile()

const RerankSchema = Schema.object({
  endpoint: Schema.string(),
  token: Schema.string().role('secret'),
  model: Schema.string(),
}).default({}).volatile()

const LayerWeightsSchema = Schema.object({
  l2: Schema.number().default(0.7),
  l1: Schema.number().default(0.4),
}).default({}).volatile()

const SystemOneSchema = Schema.object({
  enabled: Schema.boolean().default(true),
}).default({}).volatile()

/** FR-18 全字段 Config schema。每项 `.volatile()`；凭据标 `.role('secret')`。 */
export const Config = Schema.object({
  embedding: EmbeddingSchema,
  rerank: RerankSchema,
  captureSteps: Schema.number().default(50).volatile(),
  inboxRefineConcurrency: Schema.number().default(4).volatile(),
  injectOnNewSession: Schema.boolean().default(true).volatile(),
  rrfK: Schema.number().default(60).volatile(),
  retrievalTopK: Schema.number().default(50).volatile(),
  layerWeights: LayerWeightsSchema,
  llmProvider: Schema.string().volatile(),
  llmModel: Schema.string().volatile(),
  systemOne: SystemOneSchema,
})

/**
 * 解析后的运行时配置形态。
 * `embedding` 为降级开关：token 或 model 任一缺失即 'disabled'（FR-18）。
 * `warnings` 收集降级说明，调用方按需写入日志 / status（本 story 只落日志通道）。
 */
export interface RuntimeConfig {
  embedding: { endpoint?: string; token?: string; model?: string }
  embeddingMode: 'enabled' | 'disabled'
  captureSteps: number
  inboxRefineConcurrency: number
  injectOnNewSession: boolean
  rrfK: number
  retrievalTopK: number
  layerWeights: { l2: number; l1: number }
  llmProvider?: string
  llmModel?: string
  systemOne: { enabled: boolean }
  warnings: string[]
}

/** 统一读法：既接受 volatile 节点（.get()），也接受普通值——便于纯单测直接传值包装。 */
type Getter<T> = { get(): T } | T
function read<T>(field: Getter<T>): T {
  return typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function'
    ? (field as { get(): T }).get()
    : (field as T)
}

/** HTTP(S) URL 硬校验。失败抛 Error，消息含字段名 + 期望格式 + 当前值。 */
function requireHttpUrl(field: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${field}（期望 http(s):// URL，实际 ${JSON.stringify(raw)}）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field}（期望 http(s):// URL，实际 ${JSON.stringify(raw)}）`)
  }
  return raw
}

/** 正整数硬校验（captureSteps / inboxRefineConcurrency）。 */
function requirePositiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field}（期望 ≥ 1 的整数，实际 ${value}）`)
  }
  return value
}

/** 层权重硬校验：值必须 ∈ (0, 1]。 */
function requireUnitWeight(field: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${field}（期望 ∈ (0, 1]，实际 ${value}）`)
  }
  return value
}

/**
 * 分级校验入口。
 * 硬校验失败即抛 Error（仅阻塞本插件，宿主继续运行）；
 * Embedding token/model 缺失走降级（warn + embeddingMode='disabled'，FR-18）。
 * 凭据字段（token）的错误信息固定只含字段名——值本身是秘密，不得入错误日志（NFR9）。
 */
export function resolveRuntimeConfig(config: {
  embedding?: Getter<{ endpoint?: string; token?: string; model?: string }>
  captureSteps?: Getter<number>
  inboxRefineConcurrency?: Getter<number>
  injectOnNewSession?: Getter<boolean>
  rrfK?: Getter<number>
  retrievalTopK?: Getter<number>
  layerWeights?: Getter<{ l2?: number; l1?: number }>
  llmProvider?: Getter<string | undefined>
  llmModel?: Getter<string | undefined>
  systemOne?: Getter<{ enabled?: boolean }>
}): RuntimeConfig {
  const warnings: string[] = []

  // Embedding endpoint：填了就硬校验 http(s)
  const embeddingRaw = read(config.embedding ?? {}) as { endpoint?: string; token?: string; model?: string }
  const embeddingEndpoint = requireHttpUrl('embedding.endpoint', embeddingRaw.endpoint)

  // Embedding token / model：任一缺失即降级，不抛错（FR-18）
  const token = embeddingRaw.token?.trim() || ''
  const model = embeddingRaw.model?.trim() || ''
  let embeddingMode: RuntimeConfig['embeddingMode'] = 'enabled'
  if (!token || !model) {
    embeddingMode = 'disabled'
    const missing = [
      !token ? 'embedding.token' : null,
      !model ? 'embedding.model' : null,
    ].filter(Boolean).join(' / ')
    warnings.push(`embedding 降级为 disabled：缺少 ${missing}（可留空走关键词单路）`)
  }

  const captureSteps = requirePositiveInt('captureSteps', read(config.captureSteps ?? 50))
  const inboxRefineConcurrency = requirePositiveInt('inboxRefineConcurrency', read(config.inboxRefineConcurrency ?? 4))
  const rrfK = read(config.rrfK ?? 60)
  if (!Number.isFinite(rrfK) || rrfK <= 0) {
    throw new Error(`rrfK（期望 > 0 的数，实际 ${rrfK}）`)
  }
  const retrievalTopK = read(config.retrievalTopK ?? 50)

  const weightsRaw = read(config.layerWeights ?? {}) as { l2?: number; l1?: number }
  const l2 = requireUnitWeight('layerWeights.l2', weightsRaw.l2 ?? 0.7)
  const l1 = requireUnitWeight('layerWeights.l1', weightsRaw.l1 ?? 0.4)

  const systemOneRaw = read(config.systemOne ?? {}) as { enabled?: boolean }
  const systemOneEnabled = systemOneRaw.enabled ?? true
  const injectOnNewSession = read(config.injectOnNewSession ?? true)
  const llmProvider = read(config.llmProvider ?? undefined)
  const llmModel = read(config.llmModel ?? undefined)

  return {
    embedding: {
      endpoint: embeddingEndpoint,
      token: token || undefined,
      model: model || undefined,
    },
    embeddingMode,
    captureSteps,
    inboxRefineConcurrency,
    injectOnNewSession,
    rrfK,
    retrievalTopK,
    layerWeights: { l2, l1 },
    llmProvider: llmProvider || undefined,
    llmModel: llmModel || undefined,
    systemOne: { enabled: systemOneEnabled },
    warnings,
  }
}

/**
 * Schema 字段类型（供外部消费者 / IDE 类型推导）。
 * 每字段对应一个 volatile 节点，读取用 `.get()`。
 */
export interface ConfigShape {
  embedding: Volatile<{ endpoint?: string; token?: string; model?: string }>
  rerank: Volatile<{ endpoint?: string; token?: string; model?: string }>
  captureSteps: Volatile<number>
  inboxRefineConcurrency: Volatile<number>
  injectOnNewSession: Volatile<boolean>
  rrfK: Volatile<number>
  retrievalTopK: Volatile<number>
  layerWeights: Volatile<{ l2: number; l1: number }>
  llmProvider: Volatile<string | undefined>
  llmModel: Volatile<string | undefined>
  systemOne: Volatile<{ enabled: boolean }>
}

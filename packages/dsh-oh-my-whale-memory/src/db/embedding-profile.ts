/**
 * 建库时 pin 的 embedding 档案（AC2 / AD-14）。
 *
 * 维度必须来自配置：LadybugDB `FLOAT[DIM]` 要求固定的 numElements，一旦建库就无法改。
 * 优先级：显式 `embedding.dim` > 已知模型表 > 默认 1024（AD-14：bge-m3 = 1024）。
 * 换模型时必须同步改 `embedding.dim`，否则启动即 fail-loud（AC5）。
 */
import { assertEmbeddingDim } from './schema.js'

export const DEFAULT_EMBEDDING_DIM = 1024
export const DEFAULT_EMBEDDING_MODEL_ID = 'BAAI/bge-m3'

/** 已知模型 → 向量维度（仅收 AD-14 明确给出的 bge-m3，不猜别的模型）。 */
const MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  'baai/bge-m3': DEFAULT_EMBEDDING_DIM,
}

export interface EmbeddingProfile {
  /** 建库 pin 的向量维度。 */
  dim: number
  /** 写入库级元数据的模型 id。 */
  modelId: string
  /** 需要落到日志的降级/提示信息。 */
  warnings: string[]
}

export function resolveEmbeddingProfile(embedding: { model?: string; dim?: number }): EmbeddingProfile {
  const modelId = embedding.model?.trim() || DEFAULT_EMBEDDING_MODEL_ID
  const warnings: string[] = []

  if (embedding.dim !== undefined) {
    return { dim: assertEmbeddingDim(embedding.dim), modelId, warnings }
  }

  const known = MODEL_DIMENSIONS[modelId.toLowerCase()]
  if (known !== undefined) return { dim: known, modelId, warnings }

  warnings.push(
    `未知 embedding 模型 ${modelId} 的向量维度，按默认 ${DEFAULT_EMBEDDING_DIM} 建库；` +
    '如与模型实际输出不符，请设置 embedding.dim（否则写入时维度校验会失败）',
  )
  return { dim: DEFAULT_EMBEDDING_DIM, modelId, warnings }
}

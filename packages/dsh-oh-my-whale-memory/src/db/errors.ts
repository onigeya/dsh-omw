/**
 * 记忆库层统一错误（错误信封契约 { code, message, retryable }，ARCHITECTURE-SPINE 约定）。
 *
 * 建库/写入阶段的失败一律 fail-loud：抛出本类型让宿主看到具体 code，
 * 不做静默降级（AD-14 维度不符、指纹空文本等）。retryable 固定 false——
 * 这些都是语义错误，重试不会变好。
 */
export type MemoryDbErrorCode =
  | 'db_open_failed'
  | 'schema_mismatch'
  | 'embedding_dim_mismatch'
  | 'empty_fingerprint_text'
  | 'invalid_layer'
  | 'invalid_embedding_dim'
  | 'readonly_mode'

export class MemoryDbError extends Error {
  readonly code: MemoryDbErrorCode
  /** 完整错误信封 { code, message, retryable }——见 ARCHITECTURE-SPINE:144 / 本文件头。 */
  readonly retryable = false

  constructor(code: MemoryDbErrorCode, message: string) {
    super(message)
    this.name = 'MemoryDbError'
    this.code = code
  }
}

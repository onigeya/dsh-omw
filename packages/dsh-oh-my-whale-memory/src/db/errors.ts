/**
 * 记忆库层统一错误（错误信封契约 { code, message, retryable }，ARCHITECTURE-SPINE 约定）。
 *
 * 建库/写入阶段的失败一律 fail-loud：抛出本类型让宿主看到具体 code，
 * 不做静默降级（AD-14 维度不符、指纹空文本等）。retryable 固定 false——
 * 这些都是语义错误，重试不会变好。
 *
 * Story 1.6 新增两个工具层错误码（不抛，由 memory_remember 在 execute 内
 * catch 后作为 canonical value 返回，见 tools/memory-remember.ts）：
 * - 'db_unavailable'：库未就绪（无 profile / 句柄缺失）时工具调用不可用；
 * - 'db_write_failed'：底层驱动抛出非 MemoryDbError 时的兜底写入失败。
 * 这两个码只作为返回值出现：db/ 层没有任何
 * `new MemoryDbError('db_unavailable' | 'db_write_failed')` 构造点，
 * MemoryDbError 的抛出路径不产生它们。
 */
export type MemoryDbErrorCode =
  | 'db_open_failed'
  | 'schema_mismatch'
  | 'embedding_dim_mismatch'
  | 'empty_fingerprint_text'
  | 'invalid_layer'
  | 'invalid_embedding_dim'
  | 'readonly_mode'
  | 'db_unavailable'
  | 'db_write_failed'
  | 'audit_record_missing'
  /** 存储后端模块装载失败（native 在 Electron 下不可用、wasm 包缺失等，AD-32）。 */
  | 'db_backend_unavailable'
  /** 时间参数不是合法 UTC ISO-8601 时刻（Story 2.6：闭包谓词需内联时刻字面量）。 */
  | 'invalid_instant'

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

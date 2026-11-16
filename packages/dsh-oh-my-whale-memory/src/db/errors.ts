/**
 * 记忆库层统一错误（错误信封契约 { code, message, retryable }，ARCHITECTURE-SPINE 约定）。
 *
 * 建库/写入阶段的失败一律 fail-loud：抛出本类型让宿主看到具体 code，
 * 不做静默降级（AD-14 维度不符、指纹空文本等）。retryable 固定 false，
 * 这些都是语义错误，重试不会变好。
 *
 * Story 1.6 新增两个工具层错误码（不抛，由 memory_remember 在 execute 内
 * catch 后作为 canonical value 返回，见 tools/memory-remember.ts）：
 * - 'db_unavailable'：库未就绪（无 profile / 句柄缺失）时工具调用不可用；
 * - 'db_write_failed'：底层驱动抛出非 MemoryDbError 时的兜底写入失败。
 * Story 3.1 再加三个同类返回值码（见 tools/memory-recall.ts）：
 * - 'quota_exceeded'：同一回合召回族工具调用已用尽配额（FR-10）；
 * - 'db_read_failed'：读路径抛出非 MemoryDbError 时的兜底检索失败；
 * - 'invalid_query'：query 为空白等无效输入（F-13），参数错误先于配额与检索。
 * 这些码只作为返回值出现：db/ 层没有任何
 * `new MemoryDbError('db_unavailable' | 'db_write_failed' | 'quota_exceeded' | 'db_read_failed' | 'invalid_query')` 构造点，
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
  /** 同轮召回族工具配额用尽（Story 3.1 / FR-10；仅作返回值码，见文件头）。 */
  | 'quota_exceeded'
  /** 读路径兜底失败：检索抛出非 MemoryDbError（Story 3.1；仅作返回值码）。 */
  | 'db_read_failed'
  /** 检索参数无效（空白 query 等，Story 3.1 / F-13；仅作返回值码）。 */
  | 'invalid_query'
  /** 写入参数无效（priority 越界等；仅作返回值码）。 */
  | 'invalid_priority'
  | 'audit_record_missing'
  /** 存储后端模块装载失败（native 在 Electron 下不可用、wasm 包缺失等，AD-32）。 */
  | 'db_backend_unavailable'
  /** 时间参数不是合法 UTC ISO-8601 时刻（Story 2.6：闭包谓词需内联时刻字面量）。 */
  | 'invalid_instant'
  /** 目标 id 在库里不存在（Story 4.1 / forget：命令面渲染成「未找到 id 为 <id> 的记忆。」）。 */
  | 'memory_not_found'
  /** 待裁决记录不存在（Story 7.1 / /memory resolve：id 失效或已被裁决）。 */
  | 'pending_decision_not_found'
  /** 慢路径任务不存在（Story 7.2：ail/complete 的 id 已失效）。 */
  | 'slow_task_not_found'
  /** 整窗重扫已达上限（> 2 轮），调用方应转运行级短路（Story 7.2 / Q-4）。 */
  | 'slow_task_window_exhausted'
  /** 策略候选不存在（Story 7.3）。 */
  | 'strategy_candidate_not_found'
  /** 候选重写次数用尽（Story 7.3 / AC:1490：2 次后丢弃）。 */
  | 'strategy_rewrite_exhausted'
  /** 候选不在 pending 状态（Story 7.3：只有 pending 可判定/重写，评审 R73）。 */
  | 'strategy_candidate_not_pending'
  /** schema 迁移无法安全执行（备份失败 / 迁移中途报错，Story 4.2 / AD-34：拒绝启动）。 */
  | 'schema_migration_failed'

export class MemoryDbError extends Error {
  readonly code: MemoryDbErrorCode
  /** 完整错误信封 { code, message, retryable }，见 ARCHITECTURE-SPINE:144 / 本文件头。 */
  readonly retryable = false

  constructor(code: MemoryDbErrorCode, message: string) {
    super(message)
    this.name = 'MemoryDbError'
    this.code = code
  }
}

/**
 * 引擎「表/目录项不存在」判据（0.22.3 实测两种措辞）：
 * - `CALL table_info('x')` → "Catalog exception: x does not exist in catalog."
 * - `MATCH (m:x)` → "Binder exception: Table x does not exist."
 *
 * 只认这类文案；其余错误仍由调用方继续冒泡（表缺失 = 「不可用/未知」，不是真失败）。
 */
export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /does not exist/i.test(message)
}

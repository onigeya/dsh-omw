/**
 * 召回/关联工具面的**共享小件**（Story 3.2 / spec Code Map 的 `recall-shared.ts`）。
 *
 * 存在理由：`memory_recall` 与 `memory_related` 是同一「召回族」的两个模型工具，它们的
 * 配额 owner 解析与失败信封必须逐字同源，否则两个工具的配额桶/错误码会静默分叉。
 * 只放纯函数与结构类型——不含 I/O、不含 ctx。
 */
import type { MemoryDbErrorCode } from '../db/errors.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'

/** canonical 失败信封（工具**绝不 throw**：宿主把 throw 渲染成 isError）。 */
export interface ToolFailure {
  action: 'failed'
  error: {
    code: MemoryDbErrorCode
    message: string
    retryable: boolean
  }
}

/** 组装 canonical failed 值（错误码锁回封闭联合，编译期防任意文本外发）。 */
export function failedEnvelope(code: MemoryDbErrorCode, message: string, retryable = false): ToolFailure {
  return { action: 'failed', error: { code, message, retryable } }
}

/**
 * 配额 owner（spec D7）：宿主 `ToolRunContext` 本身没有 session 字段，但 `exec.agent.session`
 * 存在（宿主 filesystem.md:316 的 owner 同源用法）。经 `inboxSessionKey` 取会话键——与 turn
 * 边界 `session/event` 监听器（tools/recall-quota.ts）落到**同一个键**，两边才能对上同一只桶。
 * 缺 session 身份时归 `'unknown'` 桶（保守拒绝）。结构窄化而不引 dsh-agent/dsh-session 类型。
 */
export function quotaOwnerOf(exec: unknown): string {
  const session = (exec as { readonly agent?: { readonly session?: unknown } } | null | undefined)?.agent?.session
  return inboxSessionKey(session)
}

/** 工具执行取消信号（Story 3.2 / F-09 同款结构窄化；宿主必填 signal）。 */
export function toolSignalOf(exec: unknown): AbortSignal | undefined {
  return (exec as { readonly signal?: AbortSignal } | null | undefined)?.signal
}

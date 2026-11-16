/**
 * `memory_expand` 的返回形态与错误映射（Story 8.2 / AC:1615-1622、NFR18、INV-3）。
 *
 * 契约（PRD §11.1）：
 * - 成功：`{handle, total, text, restored: true, bytes?, tokens?, expandCount?}`；
 * - 失败：`{restored: false, error: {code, message, retryable}}`，`code ∈ {handle_not_found, handle_expired, session_mismatch}`；
 * - **不 throw**（fail-open）、**不删除任何内容**（INV-3）、**不返回其它 session 的正文**。
 *
 * 本模块只做「句柄查询结果 → 返回信封」的纯映射；库访问与配额在调用方。
 */
import type { HandleLookupFailure, HandleRecord } from './handles.js'

export type ExpandErrorCode = HandleLookupFailure | 'db_unavailable' | 'quota_exceeded' | 'handle_text_empty'

export interface ExpandSuccess {
  readonly handle: string
  readonly total: number
  readonly text: string
  readonly restored: true
  readonly bytes: number
  readonly tokens?: number
  readonly expandCount?: number
}

export interface ExpandFailure {
  readonly restored: false
  readonly error: {
    readonly code: ExpandErrorCode
    readonly message: string
    readonly retryable: boolean
  }
}

export type ExpandResult = ExpandSuccess | ExpandFailure

/** 失败码的 retryable：只有 `handle_expired` 与 `db_unavailable` 值得重试（AC:1621 + 库未就绪）。 */
export function isRetryableExpandError(code: ExpandErrorCode): boolean {
  return code === 'handle_expired' || code === 'db_unavailable'
}

const MESSAGES: Record<ExpandErrorCode, string> = {
  handle_not_found: '句柄不存在（可能已被清理或从未创建）',
  handle_expired: '句柄已失效（对应内容已被折叠窗口淘汰）',
  session_mismatch: '该句柄属于其它会话，拒绝返回正文',
  db_unavailable: '记忆库尚未就绪，暂时无法还原',
  quota_exceeded: '本轮工具调用配额已用尽（上限 3 次），请下一轮再试',
  handle_text_empty: '句柄正文为空，无法还原',
}

/** 构造失败信封（**不抛**；调用方直接把它作为工具返回值）。 */
export function expandFailure(code: ExpandErrorCode, detail?: string): ExpandFailure {
  const message = detail === undefined ? MESSAGES[code] : MESSAGES[code] + '：' + detail
  return { restored: false, error: { code, message, retryable: isRetryableExpandError(code) } }
}

/**
 * 成功信封：`text` 必须**逐字**等于写入内容（NFR18）。
 * `total` 是字符数（与 `text.length` 一致，方便调用方核对是否截断）；`bytes` 是 UTF-8 字节数。
 */
export function expandSuccess(record: HandleRecord, options: { readonly expandCount?: number } = {}): ExpandSuccess {
  const success: ExpandSuccess = {
    handle: record.id,
    total: record.text.length,
    text: record.text,
    restored: true,
    bytes: Buffer.byteLength(record.text, 'utf8'),
    ...(options.expandCount === undefined ? {} : { expandCount: options.expandCount }),
  }
  return success
}

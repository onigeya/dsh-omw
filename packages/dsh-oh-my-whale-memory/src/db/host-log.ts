/**
 * 宿主日志 hydrate 适配层（Story 10.2 / AD-36、AD-33）。
 *
 * INBOX 的 `payload` 自本 story 起只存指针 `{sessionId, seqs[], eventTypes[]}`；精炼时
 * 必须按 seq 读回宿主事件正文。**读宿主日志的唯一位置就是本文件**（kernel 适配层）：
 * 上层（distill）只得到渲染好的文本与 seq 解析结果，不接触 `ctx.sessionPersistence`。
 *
 * 纪律（spec `Always/Never`）：
 * - 只经 `sessionPersistence.open(id, 'read')` 的 read 句柄读；不直接读 JSONL、不猜 `.sessions/` 路径；
 * - 读失败抛结构化错误（可重试），**绝不伪造正文、不静默当墓碑**；
 * - seq 部分缺失时把缺失列表返回给调用方：可用的照常精炼，缺失由调用方计数，不伪造。
 *
 * 本文件不 import `capture/`（domain）——渲染来自 `shared/message-text.ts`，方向合法。
 */
import { renderMessage } from '../shared/message-text.js'

/** 宿主日志事件的最小形状（宿主 SessionEvent：`{type, seq, time, data}`）。 */
interface HostLogEventLike {
  readonly seq?: unknown
  readonly type?: unknown
  readonly data?: unknown
}

/** read 句柄的最小形状（宿主 `SessionHandle` 的只读子集）。 */
export interface HostLogHandleLike {
  read(offset?: number, length?: number): Promise<{ readonly events?: readonly unknown[] }>
  close?(): Promise<void>
}

/** `ctx.sessionPersistence` 的最小形状（只用到 open/read）。 */
export interface HostLogServiceLike {
  open(id: string, access: 'read'): Promise<HostLogHandleLike>
}

/** hydrate 失败的两种可重试原因（由 processor 收敛成 `InboxRefineError`）。 */
export type HostLogFailureReason = 'host-log-unavailable' | 'host-log-read-failed'

export class HostLogError extends Error {
  readonly reason: HostLogFailureReason

  constructor(reason: HostLogFailureReason, message: string) {
    super(message)
    this.name = 'HostLogError'
    this.reason = reason
  }
}

/** 一条解析成功的事件（渲染好的 `role: text`）。 */
export interface HydratedPointerEvent {
  readonly seq: number
  /** 宿主事件类型（`user/message` / `assistant/message` / `tool/result`）。 */
  readonly type: string
  readonly text: string
}

export interface PointerHydration {
  /** 按 seq 升序的已解析事件（只含能渲染出非空文本的）。 */
  readonly events: readonly HydratedPointerEvent[]
  /** `events` 的 `role: text` 以空行拼接；没有可用事件时为空串。 */
  readonly text: string
  /** 请求了但宿主日志里没有可渲染事件（或根本没有该 seq）的 seq 列表。 */
  readonly missing: readonly number[]
  /** 实际解析成功的 seq（= `events` 的 seq），供 sourceRefs 使用。 */
  readonly resolvedSeqs: readonly number[]
}

/** 从事件取消息体：宿主把消息放 `data.message`（部分路径直接放 `data`）。 */
function eventMessage(event: unknown): unknown {
  const data = (event as { readonly data?: unknown } | null | undefined)?.data
  if (typeof data !== 'object' || data === null) return null
  const payload = data as Record<string, unknown>
  return payload.message ?? payload
}

function eventSeq(event: unknown): number | null {
  const seq = (event as HostLogEventLike | null | undefined)?.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

function eventType(event: unknown): string {
  const type = (event as HostLogEventLike | null | undefined)?.type
  return typeof type === 'string' ? type : ''
}

/** 请求的 seq 清洗：去重、升序、只留 ≥0 整数（非法值直接丢弃，不抛）。 */
export function normalizePointerSeqs(seqs: readonly number[]): number[] {
  const out: number[] = []
  let last = -1
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq === last) continue
    out.push(seq)
    last = seq
  }
  return out
}

/**
 * 按 seq 读回宿主事件并渲染。
 *
 * @param service `ctx.sessionPersistence`（缺失/形状不符 ⇒ `host-log-unavailable`）
 * @param sessionId 指针里记录的会话 id
 * @param seqs 指针里记录的 seq 列表（顺序无关）
 * @throws HostLogError `host-log-unavailable` / `host-log-read-failed`（都可重试）
 */
export async function hydratePointerEvents(
  service: HostLogServiceLike | null | undefined,
  sessionId: string,
  seqs: readonly number[],
): Promise<PointerHydration> {
  const requested = normalizePointerSeqs(seqs)
  if (requested.length === 0) return { events: [], text: '', missing: [], resolvedSeqs: [] }
  if (!service || typeof service.open !== 'function') {
    throw new HostLogError('host-log-unavailable', 'sessionPersistence 不可用：无法 hydrate INBOX 指针（session=' + sessionId + '）')
  }

  let handle: HostLogHandleLike
  try {
    handle = await service.open(sessionId, 'read')
  } catch (error) {
    throw new HostLogError(
      'host-log-unavailable',
      '打开宿主会话日志失败（session=' + sessionId + '）：' + errorText(error),
    )
  }

  let rawEvents: readonly unknown[] = []
  try {
    // 宿主 read(offset, length) 的 offset 是逻辑事件 seq；seq 列表通常连续，直接取区间。
    const first = requested[0]!
    const last = requested[requested.length - 1]!
    const slice = await handle.read(first, last - first + 1)
    rawEvents = Array.isArray(slice?.events) ? slice.events : []
  } catch (error) {
    throw new HostLogError(
      'host-log-read-failed',
      '读取宿主会话日志失败（session=' + sessionId + '，seq=' + requested.join(',') + '）：' + errorText(error),
    )
  } finally {
    // 只读句柄的 close 失败不应掩盖真正的读结果（也不该让一次成功 hydrate 变成失败）。
    try {
      await handle.close?.()
    } catch {
      // idempotent teardown：关闭失败没有可恢复动作。
    }
  }

  const wanted = new Set(requested)
  const bySeq = new Map<number, HydratedPointerEvent>()
  for (const event of rawEvents) {
    const seq = eventSeq(event)
    if (seq === null || !wanted.has(seq) || bySeq.has(seq)) continue
    const text = renderMessage(eventMessage(event))
    if (text.length === 0) continue
    bySeq.set(seq, { seq, type: eventType(event), text })
  }

  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  const resolved = new Set(events.map((event) => event.seq))
  const missing = requested.filter((seq) => !resolved.has(seq))
  return {
    events,
    text: events.map((event) => event.text).join('\n\n'),
    missing,
    resolvedSeqs: events.map((event) => event.seq),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

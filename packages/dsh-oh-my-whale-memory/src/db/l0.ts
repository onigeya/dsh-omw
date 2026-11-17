/**
 * L0 原始流水写入原语（Story 2.1 / AD-4、NFR10）。
 *
 * L0 是只追加的原始事实源：本文件只提供 MERGE ... ON CREATE SET（同 id 重放幂等、
 * 永不覆盖既有行），没有 UPDATE / DELETE。
 *
 * 与 db/memory.ts 的 writeMemoryVersion 同形：由调用方开事务，采集侧要把
 * 「L0 行 + INBOX 行」放进同一个事务（FR-2），自开事务的原语在调用方事务内会命中
 * transaction.ts:74-81 的重入守卫。
 */
import type * as lbug from '@ladybugdb/core'
import { uuid5 } from './id.js'
import { collectRows } from './rows.js'
import { L0_RAW_TABLE } from './schema.js'

export type L0Connection = lbug.Connection

/** 一次采集的稳定身份：同 (kind, sessionId, ref) 永远算出同一对 id（崩溃重放幂等）。 */
export function captureStableKey(kind: string, sessionId: string, ref: string | number): string {
  return kind + ':' + sessionId + ':' + ref
}

/**
 * L0 行 id（确定性；uuid5 同 db/id.ts 的命名空间）。
 *
 * 一次采集 = 一个身份（Story 2.3 评审 T1）：L0 行与 INBOX 行共用本 id，
 * 这样精炼产出的 L1 节点 source_refs / 审计 l0Refs 直接指向真实存在的 L0 行
 * （原先 INBOX 用 'inbox:' 前缀另算一个 id，uuid5 单向 ⇒ 引用永远命不中 L0）。
 */
export function l0RawId(stableKey: string): string {
  return uuid5('l0:' + stableKey)
}

/**
 * Story 10.1 / AD-36：pointer 行的确定性 id —— `uuid5('L0:' + sessionId + '#' + seq)`。
 *
 * 前缀用大写 `L0:`（与 inline 行的 `l0:` 命名空间不同）：两型行 id 不互相覆盖，
 * 同一 `(sessionId, seq)` 重放算出同一 id，因此 MERGE 幂等、崩溃重放不新增行。
 * seq 必须是宿主持久日志的非负整数序号（不来自事件 payload 的自由文本）。
 */
export const L0_POINTER_PREFIX = 'L0:'

export function l0PointerId(sessionId: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new RangeError('L0 pointer seq 必须是 ≥ 0 的整数（实际 ' + String(seq) + '）')
  }
  return uuid5(L0_POINTER_PREFIX + sessionId + '#' + String(seq))
}

export interface L0RawInput {
  readonly id: string
  readonly text: string
  readonly recordedAt?: Date
  readonly actor?: string
}

/**
 * Story 10.1：pointer 行的写入输入。**没有 `text`** —— 指针行不复制正文（`raw_text` 保持 NULL）。
 * 正文按需经 `ctx.sessionPersistence` 的 read 句柄解析（AD-36）。
 */
export interface L0PointerInput {
  /** `l0PointerId(sessionId, seq)` 的结果；由调用方算好以便与 INBOX id 共用同一身份。 */
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  /** 宿主事件类型（`user/message` / `assistant/message` / `tool/result`）。 */
  readonly eventType: string
  readonly recordedAt?: Date
}

const INSERT_RAW = [
  'MERGE (l:' + L0_RAW_TABLE + ' {id: $id})',
  '  ON CREATE SET l.raw_text = $raw_text, l.recorded_at = $recorded_at, l.actor = $actor',
].join('')

/**
 * pointer 行的 MERGE。**刻意不写 `raw_text`**：不写即 NULL，墓碑判据
 * （`raw_text IS NULL AND seq IS NULL`）才能把 pointer 与墓碑区分开。
 *
 * 与 {@link writeL0Raw} 同形：不自开事务（调用方开），ON CREATE SET 只创建不覆盖。
 */
const INSERT_POINTER = [
  'MERGE (l:' + L0_RAW_TABLE + ' {id: $id})',
  '  ON CREATE SET l.recorded_at = $recorded_at, l.actor = $actor,',
  '    l.seq = $seq, l.event_type = $event_type',
].join('')

/** 在调用方已开启的事务内追加一条 L0 原始流水，返回其 id。 */
export async function writeL0Raw(connection: L0Connection, input: L0RawInput): Promise<string> {
  const recordedAt = (input.recordedAt ?? new Date()).toISOString()
  const prepared = await connection.prepare(INSERT_RAW)
  await collectRows(await connection.execute(prepared, {
    id: input.id,
    raw_text: input.text,
    recorded_at: recordedAt,
    actor: input.actor ?? '',
  }))
  return input.id
}

/**
 * 在调用方已开启的事务内追加一条 pointer 行（Story 10.1），返回其 id。
 *
 * 契约：`actor = sessionId`、`seq`、`event_type`、`recorded_at`（UTC ISO-8601）、`raw_text = NULL`；
 * 同一 `(sessionId, seq)` 重放不新增（MERGE ON CREATE）。
 */
export async function writeL0Pointer(connection: L0Connection, input: L0PointerInput): Promise<string> {
  const recordedAt = (input.recordedAt ?? new Date()).toISOString()
  const prepared = await connection.prepare(INSERT_POINTER)
  await collectRows(await connection.execute(prepared, {
    id: input.id,
    recorded_at: recordedAt,
    actor: input.sessionId,
    seq: input.seq,
    event_type: input.eventType,
  }))
  return input.id
}

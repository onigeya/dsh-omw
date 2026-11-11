/**
 * L0 原始流水写入原语（Story 2.1 / AD-4、NFR10）。
 *
 * L0 是**只追加**的原始事实源：本文件只提供 MERGE ... ON CREATE SET（同 id 重放幂等、
 * 永不覆盖既有行），没有 UPDATE / DELETE。
 *
 * 与 db/memory.ts 的 writeMemoryVersion 同形：**由调用方开事务**——采集侧要把
 * 「L0 行 + INBOX 行」放进同一个事务（FR-2），自开事务的原语在调用方事务内会命中
 * transaction.ts:67-80 的重入守卫。
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
 * **一次采集 = 一个身份**（Story 2.3 评审 T1）：L0 行与 INBOX 行共用本 id，
 * 这样精炼产出的 L1 节点 source_refs / 审计 l0Refs 直接指向真实存在的 L0 行
 * （原先 INBOX 用 'inbox:' 前缀另算一个 id，uuid5 单向 ⇒ 引用永远命不中 L0）。
 */
export function l0RawId(stableKey: string): string {
  return uuid5('l0:' + stableKey)
}

export interface L0RawInput {
  readonly id: string
  readonly text: string
  readonly recordedAt?: Date
  readonly actor?: string
}

const INSERT_RAW = [
  'MERGE (l:' + L0_RAW_TABLE + ' {id: $id})',
  '  ON CREATE SET l.raw_text = $raw_text, l.recorded_at = $recorded_at, l.actor = $actor',
].join('')

/** 在**调用方已开启的事务**内追加一条 L0 原始流水，返回其 id。 */
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

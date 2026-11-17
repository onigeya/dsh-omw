/**
 * 本体闸门的丢弃账本（Story 9.1 / T5、AD-21 家族、AD-31:443）。
 *
 * 口径：
 * - 只写既有 `generation_log`，不建表、不加列（AD-31 / AD-34）；
 * - **按维分桶**：一次精炼里某一维丢弃了 N 条，就落一行 `action=ontology_discard`，
 *   `detail` 记 `{dimension, dropped}`；各维 `dropped` 之和 = 本次候选丢失总数；
 * - 只读实例不写（AD-12）：写入发生在精炼事务内（消费者本身在只读实例不启动），
 *   读侧只做聚合，不产生任何写副作用。
 */
import type * as lbug from '@ladybugdb/core'
import { isMissingTableError } from '../db/errors.js'
import { queryAll } from '../db/rows.js'
import { GENERATION_LOG_TABLE } from '../db/schema.js'
import { ONTOLOGY_DIMENSIONS, type OntologyDimension } from './gate.js'

/** 丢弃账本的 action（`/memory status` 按它聚合；与其它审计行分开计数）。 */
export const ONTOLOGY_DISCARD_ACTION = 'ontology_discard'

/** 按维分桶的丢弃计数。 */
export type OntologyDropCounts = Readonly<Record<OntologyDimension, number>>

/** 全零桶（每次返回新冻结对象，调用方可安全累加自己的副本）。 */
export function emptyOntologyDropCounts(): OntologyDropCounts {
  return Object.freeze({
    nameNormalization: 0,
    duplicateTypeDiscard: 0,
    entityType: 0,
    relationType: 0,
    domainRange: 0,
    datatype: 0,
  })
}

/** 一行的 detail JSON（字段名固定，供 status 聚合；不含正文 / 凭据）。 */
export function ontologyDropDetail(dimension: OntologyDimension, dropped: number): string {
  return JSON.stringify({ dimension, dropped })
}

/** 解析一行 detail；不认识的维度或非法数量返回 null（旧行 / 损坏行不参与聚合）。 */
export function parseOntologyDropDetail(raw: unknown): { readonly dimension: OntologyDimension; readonly dropped: number } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const value = parsed as { readonly dimension?: unknown; readonly dropped?: unknown } | null
  const dimension = value?.dimension
  const dropped = value?.dropped
  if (typeof dimension !== 'string' || !(ONTOLOGY_DIMENSIONS as readonly string[]).includes(dimension)) return null
  if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped < 0) return null
  return { dimension: dimension as OntologyDimension, dropped: Math.trunc(dropped) }
}

/** 各维之和 = 候选丢失总数（守恒口径，SM-9 ③）。 */
export function sumOntologyDrops(counts: OntologyDropCounts): number {
  let total = 0
  for (const dimension of ONTOLOGY_DIMENSIONS) total += counts[dimension]
  return total
}

/** 只读聚合：审计表缺失返回 null（status 渲染「n/a」，不静默报 0）。 */
export async function countOntologyDrops(connection: lbug.Connection): Promise<OntologyDropCounts | null> {
  try {
    await queryAll(connection, `CALL table_info('${GENERATION_LOG_TABLE}') RETURN name`)
    const rows = await queryAll(
      connection,
      'MATCH (g:' + GENERATION_LOG_TABLE + ')' +
        ' WHERE g.action = ' + JSON.stringify(ONTOLOGY_DISCARD_ACTION) +
        ' RETURN g.detail AS detail',
    )
    const counts = { ...emptyOntologyDropCounts() } as Record<OntologyDimension, number>
    for (const row of rows) {
      const parsed = parseOntologyDropDetail(row.detail)
      if (parsed !== null) counts[parsed.dimension] += parsed.dropped
    }
    return Object.freeze(counts)
  } catch (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
}

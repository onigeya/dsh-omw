/**
 * 每连接一次的「新列是否存在」探测（Story 4.2 评审 FIX-1）。
 *
 * 为什么必须探测：0.22.3 对**未定义属性**不是读成 NULL，而是 binder 直接抛错
 * （实测：`Binder exception: Cannot find property evidence_degraded for m.`、
 * `Invalid struct field name: redacted_at.`）。v1 旧库（无 `memory.evidence_degraded`、
 * 无 `l0_raw.redacted_at`）被**只读实例**打开时不会迁移，任何引用新列的谓词
 * （EII/漂移、存活 L0 计数、status 降级计数）都会把整条读路径打崩——而 D-5 的
 * 「未知（库缺少该列）」恰恰只在这种情况下出现。
 *
 * 因此：谓词不能「假定缺列=NUL 」，必须先问这里，再按存在性拼语句。
 * 本模块只读（`table_info`），不写库、不开事务；只读连接可安全调用。
 *
 * 探测失败（表缺失、查询异常、只读连接拒答）一律按「缺列」处理、不抛：
 * 探测是降级路径的入口，它自己抛错会让「旧库仍能打开」这个目标落空。
 */
import type * as lbug from '@ladybugdb/core'
import { queryRows } from './rows.js'
import { L0_RAW_TABLE, MEMORY_TABLE } from './schema.js'

export interface SchemaColumnPresence {
  /** `memory.evidence_degraded`（Story 4.2 迁移 0002）。 */
  readonly evidenceDegraded: boolean
  /** `l0_raw.redacted_at`（Story 4.2 迁移 0002）。 */
  readonly redactedAt: boolean
}

/** 每连接一份（WeakMap：连接被回收时缓存随之消失；不引入生命周期管理）。 */
const cache = new WeakMap<object, Promise<SchemaColumnPresence>>()

async function columnNames(connection: lbug.Connection, table: string): Promise<Set<string>> {
  try {
    const rows = await queryRows(connection, `CALL table_info('${table}') RETURN name`)
    return new Set(rows.map((row) => String(row.name)))
  } catch {
    // 表缺失 / 只读连接拒答 / 引擎差异：都按「这一列不存在」降级，不把读路径打死。
    return new Set()
  }
}

async function probe(connection: lbug.Connection): Promise<SchemaColumnPresence> {
  const [memory, l0] = await Promise.all([
    columnNames(connection, MEMORY_TABLE),
    columnNames(connection, L0_RAW_TABLE),
  ])
  return {
    evidenceDegraded: memory.has('evidence_degraded'),
    redactedAt: l0.has('redacted_at'),
  }
}

/** 取（并在首次调用时探测）该连接的新列存在性；同一连接上只真正查询一次。 */
export function schemaColumnPresence(connection: lbug.Connection): Promise<SchemaColumnPresence> {
  const key = connection as unknown as object
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const pending = probe(connection)
  cache.set(key, pending)
  return pending
}

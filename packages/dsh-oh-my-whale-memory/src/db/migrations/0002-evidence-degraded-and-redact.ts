/**
 * 迁移 0002：证据降级与 L0 墓碑（Story 4.2 / FR-14、AD-4、AD-19、AD-21、AD-34）。
 *
 * 三个对象一次迁移：
 * - `memory.evidence_degraded BOOL`：该记忆的证据链被用户授权抹除（AD-19:267，与 audit_gap 分离）；
 * - `l0_raw.redacted_by` / `l0_raw.redacted_at`：AD-4 的「L0 墓碑唯一豁免」所需的两列；
 * - `generation_log.detail STRING`：AD-21:295 的净化明细列（本 story 只加列，无写入方）。
 *
 * 新库由 `schema.ts` 的三条建表 DDL 直接带列（bootstrap 直建到目标版本），本迁移只服务旧库。
 * 列名刻意从 `schema.ts` 取常量，不在迁移里再写一遍字面量（改名时只改一处）。
 */
import {
  EVIDENCE_DEGRADED_COLUMN,
  GENERATION_LOG_DETAIL_COLUMN,
  GENERATION_LOG_TABLE,
  L0_RAW_TABLE,
  MEMORY_TABLE,
  REDACTED_AT_COLUMN,
  REDACTED_BY_COLUMN,
} from '../schema.js'

// 不在这里 import `Migration` 类型：迁移文件 → 清单的 import 会构成 check:deps 的环。
// 结构一致性由 `migrations.ts` 的 `readonly Migration[]` 赋值处检查（typo 在那里报错）。
export const MIGRATION_0002 = {
  version: 2,
  name: 'evidence-degraded-and-redact',
  statements: [
    {
      table: MEMORY_TABLE,
      column: EVIDENCE_DEGRADED_COLUMN,
      ddl: `ALTER TABLE ${MEMORY_TABLE} ADD ${EVIDENCE_DEGRADED_COLUMN} BOOL`,
    },
    {
      table: L0_RAW_TABLE,
      column: REDACTED_BY_COLUMN,
      ddl: `ALTER TABLE ${L0_RAW_TABLE} ADD ${REDACTED_BY_COLUMN} STRING`,
    },
    {
      table: L0_RAW_TABLE,
      column: REDACTED_AT_COLUMN,
      ddl: `ALTER TABLE ${L0_RAW_TABLE} ADD ${REDACTED_AT_COLUMN} STRING`,
    },
    {
      table: GENERATION_LOG_TABLE,
      column: GENERATION_LOG_DETAIL_COLUMN,
      ddl: `ALTER TABLE ${GENERATION_LOG_TABLE} ADD ${GENERATION_LOG_DETAIL_COLUMN} STRING`,
    },
  ],
}

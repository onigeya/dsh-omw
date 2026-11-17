/**
 * 迁移 0008：档位落账 + 句柄展开统计（Story 8.4 / T1、FR-29、AD-26、AD-34）。
 *
 * 六列，两个对象：
 * - `compaction_run.plan_json` / `tier` / `delegate`：那次压缩「档位怎么定的」；
 *   `plan_json` 存判定计划（与 `config_snapshot_json` 的 criteria 同源，AD-26 可重放），
 *   `tier` 存最终档位，`delegate` 存实际的摘要路径（T1 折叠 / stock）。三列全可空：
 *   没有 plan 的事件流（矩阵行 6）留 NULL，不编造。
 * - `memory.expand_count` / `chain_depth` / `last_expanded_at`：句柄与摘要节点的展开次数、
 *   重写链深与最近展开时刻（FR-29 的超阈判据）。两列计数带 `DEFAULT 0`（0.22.3 的
 *   ALTER 接受 DEFAULT，与 0002 的 `evidence_degraded BOOL DEFAULT false` 同一实测口径），
 *   时刻列可空。
 *
 * 新库由 `schema.ts` 的两条建表 DDL 直接带列（bootstrap 直建到目标版本），本迁移只服务旧库。
 * 列名一律从 `schema.ts` 取常量，不在迁移里再写字面量。
 */
import {
  CHAIN_DEPTH_COLUMN,
  COMPACTION_DELEGATE_COLUMN,
  COMPACTION_PLAN_JSON_COLUMN,
  COMPACTION_RUN_TABLE,
  COMPACTION_TIER_COLUMN,
  EXPAND_COUNT_COLUMN,
  LAST_EXPANDED_AT_COLUMN,
  MEMORY_TABLE,
} from '../schema.js'

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0008 = {
  version: 8,
  name: 'tier-threshold',
  statements: [
    {
      table: COMPACTION_RUN_TABLE,
      column: COMPACTION_PLAN_JSON_COLUMN,
      ddl: `ALTER TABLE ${COMPACTION_RUN_TABLE} ADD ${COMPACTION_PLAN_JSON_COLUMN} STRING`,
    },
    {
      table: COMPACTION_RUN_TABLE,
      column: COMPACTION_TIER_COLUMN,
      ddl: `ALTER TABLE ${COMPACTION_RUN_TABLE} ADD ${COMPACTION_TIER_COLUMN} STRING`,
    },
    {
      table: COMPACTION_RUN_TABLE,
      column: COMPACTION_DELEGATE_COLUMN,
      ddl: `ALTER TABLE ${COMPACTION_RUN_TABLE} ADD ${COMPACTION_DELEGATE_COLUMN} STRING`,
    },
    {
      table: MEMORY_TABLE,
      column: EXPAND_COUNT_COLUMN,
      ddl: `ALTER TABLE ${MEMORY_TABLE} ADD ${EXPAND_COUNT_COLUMN} INT64 DEFAULT 0`,
    },
    {
      table: MEMORY_TABLE,
      column: CHAIN_DEPTH_COLUMN,
      ddl: `ALTER TABLE ${MEMORY_TABLE} ADD ${CHAIN_DEPTH_COLUMN} INT64 DEFAULT 0`,
    },
    {
      table: MEMORY_TABLE,
      column: LAST_EXPANDED_AT_COLUMN,
      ddl: `ALTER TABLE ${MEMORY_TABLE} ADD ${LAST_EXPANDED_AT_COLUMN} STRING`,
    },
  ],
}

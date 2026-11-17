/**
 * 迁移 0009：L0 指针化两列（Story 10.1 / AD-36、AD-34）。
 *
 * `l0_raw` 加两列：
 * - `seq INT64`：pointer 行的宿主持久日志序号（墓碑判据从「`raw_text IS NULL`」改成
 *   「两者皆空」；既有 inline 行读回 NULL，行为不变）；
 * - `event_type STRING`：pointer 行来自哪个宿主事件（`user/message` / `assistant/message` /
 *   `tool/result`），正文按需解析时用来区分渲染形态。
 *
 * 两列都可空，**没有 DEFAULT**：inline 行必须读回 NULL（不是 0 / 空串），否则
 * 「墓碑 = 两者皆空」会把全部既有 inline 行误判成 pointer 行。
 *
 * 新库由 `schema.ts` 的 `createL0RawTableStatement()` 直接带列（bootstrap 直建到目标版本），
 * 本迁移只服务旧库。列名取 `schema.ts` 的常量，不在迁移里再写字面量。
 */
import { EVENT_TYPE_COLUMN, L0_RAW_TABLE, SEQ_COLUMN } from '../schema.js'

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0009 = {
  version: 9,
  name: 'l0-pointer',
  statements: [
    {
      table: L0_RAW_TABLE,
      column: SEQ_COLUMN,
      ddl: `ALTER TABLE ${L0_RAW_TABLE} ADD ${SEQ_COLUMN} INT64`,
    },
    {
      table: L0_RAW_TABLE,
      column: EVENT_TYPE_COLUMN,
      ddl: `ALTER TABLE ${L0_RAW_TABLE} ADD ${EVENT_TYPE_COLUMN} STRING`,
    },
  ],
}

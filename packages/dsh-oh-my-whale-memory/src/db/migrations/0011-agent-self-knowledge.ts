/**
 * 迁移 0011：建 `agent_self_knowledge` 表（Story 11.3 / AD-38、AD-34；ADR-11.1 方案 B）。
 *
 * 与 0004–0007 的「加表」迁移同形态：DDL 走 `run`（`CREATE NODE TABLE IF NOT EXISTS`，幂等），
 * 新库靠 bootstrap 重放建出，旧库由本迁移补表。`statements` 为空是因为 AD-34 的语句清单只
 * 表达「加列」，加表必须走 `run`（`check:migrations` 只校验 SCHEMA_VERSION = 最大迁移号）。
 *
 * 只读实例不迁移（`db/migrate.ts` 只在写者路径调用）⇒ 迁移前旧库以只读打开时本表不存在，
 * 自省面为空（ADR-11.1 方案 B 的已知缺点，由 `persona/self-knowledge.ts` 的缺表处理与
 * `/memory status` 的「未知」行显式暴露）。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from '../backend.js'
import { createAgentSelfKnowledgeTableStatement } from '../schema.js'

async function createAgentSelfKnowledgeTable(connection: lbug.Connection): Promise<void> {
  await runStatement(connection, createAgentSelfKnowledgeTableStatement())
}

// 不 import `Migration` 类型（迁移文件 → 清单的 import 会构成 check:deps 的环）。
export const MIGRATION_0011 = {
  version: 11,
  name: 'agent-self-knowledge',
  statements: [],
  run: createAgentSelfKnowledgeTable,
}

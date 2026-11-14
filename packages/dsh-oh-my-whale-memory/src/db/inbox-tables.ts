/**
 * INBOX 队列表的迁移执行点（schema 归 db 所有：DDL 文本在 ./schema.ts，执行在本文）。
 *
 * 为什么在这里而不是 src/inbox/queue.ts：db 是存储层的最底层，`db/database.ts` 的建库
 * 迁移点必须建全部表，若反过来 import inbox 层就形成 `db ↔ inbox` 的目录级环（AD-33）。
 * 因此把「建表」这件 db 职责下沉到本文件，队列（inbox 层）改为调用它。
 *
 * 范式同 ./audit.ts 的 ensureAuditTables：DDL 在单事务内执行，失败即整体回滚。
 * 表名只接受 ./schema.ts 导出的常量（或 createInboxQueue 在创建时绑定的常量），
 * 绝不把外部输入拼进 DDL。
 */
import type * as lbug from '@ladybugdb/core'
import { runStatement } from './backend.js'
import { L1_INBOX_TABLE, L2_INBOX_TABLE, createInboxTableStatement } from './schema.js'
import { runInTransaction } from './transaction.js'

/**
 * 建某张 INBOX 队列表（IF NOT EXISTS，幂等）。
 * @param table 表名，只应是 ./schema.ts 的 INBOX 表名常量。
 */
export async function ensureInboxTable(connection: lbug.Connection, table: string): Promise<void> {
  await runInTransaction(connection, async () => {
    // 结果必须释放，否则 pin 满 buffer pool（见 ./backend.ts closeQueryResult）。
    await runStatement(connection, createInboxTableStatement(table))
  })
}

/** 建 L1 精炼队列（`l1_inbox`）：唯一迁移点由 ./database.ts 调用。 */
export async function ensureInboxTables(connection: lbug.Connection): Promise<void> {
  await ensureInboxTable(connection, L1_INBOX_TABLE)
}

/** 建 L2 提升队列表（`l2_inbox`，Story 2.5 / U1）：与 l1_inbox 同列同状态机。 */
export async function ensureL2InboxTables(connection: lbug.Connection): Promise<void> {
  await ensureInboxTable(connection, L2_INBOX_TABLE)
}

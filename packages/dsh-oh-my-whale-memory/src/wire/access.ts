/**
 * 命令面的数据访问装配（Story 1.7–1.9 / 3.1 / 3.2）。
 *
 * 全部是**惰性**依赖：命令在 profileContext 早退之前注册，闭包到 handler 被调用时才读库句柄。
 * 库未就绪时抛明确错误，由命令层收敛成 `{kind:'error'}`，绝不静默返回空列表/0 计数。
 * 本单元不做任何注册，只把读/写依赖与 status 快照组装成纯函数对象。
 */
import type { MemoryDatabase } from '../db/database.js'
import { computeAuditGap, countUncertainAudits } from '../db/audit.js'
import { computeEvidenceGap } from '../db/eii.js'
import {
  countMemoriesByLayer,
  countUnembeddedMemories,
  getMemoryById as readMemoryById,
  listMemories as readMemories,
} from '../db/memory.js'
import {
  INBOX_FAILED_VIEW_LIMIT,
  countInboxByStatus,
  l2InboxQueue,
  listRecentFailedInboxItems,
} from '../inbox/queue.js'
import { MEMORY_REMEMBER_LAYER } from '../tools/memory-remember.js'
import { countRelatedSkips } from '../wiki/relations.js'
import type { MemoryCommandDependencies, MemoryInboxWriteOptions } from '../command.js'
import type { RuntimeConfig } from '../config.js'
import type { SystemOneClient } from '../distill/system-one.js'

export interface MemoryAccessOptions {
  /** 惰性取库句柄（建库之前为 undefined）。 */
  readonly getDb: () => MemoryDatabase | undefined
  /** apply 时 resolve 的配置（status 的 embeddingMode 与 System One 开关）。 */
  readonly resolved: RuntimeConfig
  /** 本实例自身的只读态（模块级 runtimeState 可能属于另一次 apply，不能读它）。 */
  readonly readonlyState: () => { readonly readonly: boolean; readonly reason?: string }
  readonly getSystemOneClient: () => SystemOneClient | null
}

export interface MemoryAccess {
  /** 库未就绪时 throw（命令层收敛为 error 结果）。 */
  readonly readConnection: () => MemoryDatabase
  readonly writeInbox: MemoryCommandDependencies['writeInbox']
  readonly listMemories: MemoryCommandDependencies['listMemories']
  readonly getMemoryById: MemoryCommandDependencies['getMemoryById']
  readonly getStatus: MemoryCommandDependencies['getStatus']
}

/** 库未就绪的统一文案：写入与读取各一句，逐字保留命令层既有输出。 */
const DB_NOT_READY_WRITE = '记忆库未就绪：无 profile 归属或建库未完成，当前无法写入 L1'
const DB_NOT_READY_READ = '记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆'

export function createMemoryAccess(options: MemoryAccessOptions): MemoryAccess {
  const readConnection = (): MemoryDatabase => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_READ)
    return database
  }

  // Story 1.11（AC2/AC3）：INBOX 采集写路径。层收敛为唯一枚举——写 `L1`
  // （= MEMORY_REMEMBER_LAYER），`L1_INBOX` 从此只是 INBOX 队列标识/表名，不是 memory.layer 取值。
  // 可选分类旗标（kind / priority，含 -1）透传到落库，与 memory_remember 同一条写路径。
  const writeInbox = async (text: string, writeOptions?: MemoryInboxWriteOptions): Promise<void> => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    // 三列 embedding/embedding_model_id/embedding_dim 同落 NULL（不写零向量污染 HNSW cosine 索引）。
    await database.upsertMemory({
      layer: MEMORY_REMEMBER_LAYER,
      text,
      kind: writeOptions?.kind,
      priority: writeOptions?.priority,
      embedding: null,
      embeddingModelId: null,
      actor: 'user',
    })
  }

  const listMemories: MemoryAccess['listMemories'] = (input) =>
    readMemories(readConnection().connection, input)
  const getMemoryById: MemoryAccess['getMemoryById'] = (id) =>
    readMemoryById(readConnection().connection, id)

  // Story 1.9：只读层计数 + 本实例运行态（readonly/reason）+ 配置态（apply 时 resolve 的
  // embeddingMode）。纯读、无 LLM / 网络；库未就绪经 readConnection() 抛错，由命令层收敛。
  const getStatus: MemoryAccess['getStatus'] = async () => {
    const connection = readConnection().connection
    const counts = await countMemoriesByLayer(connection)
    const auditGap = await computeAuditGap(connection)
    // Story 2.2 / AC4：failed 换成 l1_inbox 的真实计数；有条目才读明细（最近 5 条 + stale），
    // 无失败时不追加任何行，status 既有输出逐字不变。队列表缺失照抛（可见错误，不静默报 0）。
    const unembedded = await countUnembeddedMemories(connection)
    // Story 2.6 / F2：边侧差额（EII 违例 + 边↔source_refs 漂移）与关系降级计数。
    // computeEvidenceGap 在边表缺失时返回 null（渲染成未知，不静默报 0）。
    const evidenceGap = await computeEvidenceGap(connection, new Date().toISOString())
    const relatedSkipped = await countRelatedSkips(connection)
    const inboxCounts = await countInboxByStatus(connection)
    // Story 2.5 / U1：L2_INBOX 行从「memory.layer 的历史计数槽」换成 **l2_inbox 的真实队列深度**
    // （pending + processing = 待提升条目；done/failed 不计入——failed 另有 failed 行）。
    const l2InboxCounts = await l2InboxQueue.countByStatus(connection)
    const failedEntries = inboxCounts.failed > 0
      ? await listRecentFailedInboxItems(connection, { limit: INBOX_FAILED_VIEW_LIMIT })
      : []
    const readonlyState = options.readonlyState()
    return {
      layers: { L1: counts.L1, L2: counts.L2 },
      inboxes: {
        L1: counts.L1_INBOX,
        L2: l2InboxCounts.pending + l2InboxCounts.processing,
      },
      failed: inboxCounts.failed,
      failedEntries,
      embeddingMode: options.resolved.embeddingMode,
      // Story 2.5 / U6 + 评审 P19：配置态优先（enabled=false ⇒ 不构造客户端），
      // 否则读**本实例**客户端的运行态（端点持续不可达 ⇒ degraded）。
      systemOne: !options.resolved.systemOne.enabled
        ? 'disabled-by-config'
        : (options.getSystemOneClient()?.runtimeState().degraded === true ? 'degraded' : 'enabled'),
      unembedded,
      readonly: readonlyState.readonly,
      readonlyReason: readonlyState.reason,
      auditGap,
      evidenceGap,
      relatedSkipped,
      // Story 2.5 / 评审 P8：L2 死信（T8：此前 l2InboxCounts.failed 被整个丢弃 ⇒ L2 死信
      // 在 status 完全不可见）与疑似失效账目（T27：U14 只有写侧、没有读取出口）。
      l2Failed: l2InboxCounts.failed,
      l2FailedEntries: l2InboxCounts.failed > 0
        ? await l2InboxQueue.listRecentFailed(connection, { limit: INBOX_FAILED_VIEW_LIMIT })
        : [],
      uncertain: await countUncertainAudits(connection),
    }
  }

  return { readConnection, writeInbox, listMemories, getMemoryById, getStatus }
}

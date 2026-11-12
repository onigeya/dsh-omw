/**
 * NULL 向量有界回填（Story 2.4 / U5；deferred-work.md 的 Story 1.6 遗留项）。
 *
 * Epic 1 的直写路径（memory_remember / 手动写入）不产向量，节点三列保持 NULL；
 * 这些节点进不了 HNSW 索引，等于对路径②（语义去重）与 2.5 的语义检索隐形。
 * 本模块在**写者空闲窗口**把它们补齐：
 *
 * - 只在 `embeddingMode === 'enabled'` 且维度已 pin 时接线（由 src/index.ts 决定）；
 * - 受空闲闸门约束（`gate.isIdle()` 为假立即返回 0，既不查库也不发网络）；
 * - 每轮至多 `BACKFILL_BATCH_SIZE`（50）条，按 `EMBEDDING_MAX_BATCH`（8）切请求；
 * - 逐条失败只记一条 `backfill_embedding` 审计并继续，**绝不**阻塞 apply/启动或中断整轮；
 * - `setMemoryEmbedding` 的 `WHERE embedding IS NULL` 让重复/并发调用幂等，绝不覆盖已有向量。
 *
 * 调用方式是消费者的 maintenance 钩子（不是新定时器）——因此不新增 ctx.effect，
 * 且天然被 2.2 既有的 `stop() → drainInboxBackgroundTasks() → db.close()` 序列覆盖。
 */
import type * as lbug from '@ladybugdb/core'
import {
  BACKFILL_EMBEDDING_ACTION,
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  insertGenerationLog,
} from '../db/audit.js'
import { listUnembeddedMemories, setMemoryEmbedding, type UnembeddedMemoryEntry } from '../db/memory.js'
import { runInTransaction } from '../db/transaction.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import { EMBEDDING_MAX_BATCH, type EmbedClient } from './client.js'

/** 每轮回填条数上界（U5 的 N=50）：把一轮的时长与内存占用钉死，剩余留到下一轮。 */
export const BACKFILL_BATCH_SIZE = 50

/** 一轮回填的整体预算：超时后本轮剩余请求立即失败并逐条记账，下一轮再来（幂等）。 */
export const BACKFILL_RUN_TIMEOUT_MS = 20_000

export interface EmbeddingBackfillOptions {
  /** 惰性取连接（apply 期间建库完成后才可用；未就绪 → 本轮不做事）。 */
  readonly connection: () => lbug.Connection | null
  readonly gate: IdleGate
  /** 复用 Story 2.3 的 embedding 客户端，**不另写**一个（U5）。 */
  readonly client: EmbedClient
  /** 请求体里的模型名。 */
  readonly model: string
  /** 写入 `embedding_model_id` 列的值（ResolvedEmbeddingProfile.modelId）。 */
  readonly modelId: string
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
  readonly batchSize?: number
}

export interface EmbeddingBackfill {
  /** 跑一轮：返回本轮成功补齐的条数（测试与诊断入口）。 */
  runOnce(): Promise<number>
}

/** 逐条失败审计：一条节点一条行，node id 写进 reason（l0_refs 只放证据引用，不放节点 id）。 */
async function recordBackfillFailure(
  connection: lbug.Connection,
  entry: UnembeddedMemoryEntry,
  reason: string,
  now: Date,
): Promise<void> {
  await insertGenerationLog(connection, {
    recordedAt: now.toISOString(),
    actor: 'system',
    kind: CAPTURE_KIND,
    action: BACKFILL_EMBEDDING_ACTION,
    policy: DEFAULT_CAPTURE_POLICY,
    outcome: 'failure',
    reason: `node=${entry.id} ${reason}`,
  })
}

export function createEmbeddingBackfill(options: EmbeddingBackfillOptions): EmbeddingBackfill {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? BACKFILL_BATCH_SIZE))
  const runOnce = async (): Promise<number> => {
    if (!options.gate.isIdle()) return 0
    const connection = options.connection()
    if (!connection) return 0
    const entries = await listUnembeddedMemories(connection, batchSize)
    if (entries.length === 0) return 0
    const now = (options.now ?? (() => new Date())).call(undefined)
    const signal = AbortSignal.timeout(BACKFILL_RUN_TIMEOUT_MS)
    let filled = 0
    for (let start = 0; start < entries.length; start += EMBEDDING_MAX_BATCH) {
      const batch = entries.slice(start, start + EMBEDDING_MAX_BATCH)
      const embedded = await options.client.embed(
        options.model,
        batch.map((entry) => entry.text),
        signal,
      )
      if (!embedded.ok) {
        for (const entry of batch) {
          await recordBackfillFailure(connection, entry, embedded.reason + ': ' + embedded.message, now)
        }
        options.logger?.warn(
          'NULL 向量回填批次失败（' + batch.length + ' 条，reason=' + embedded.reason + '）：' + embedded.message,
        )
        continue
      }
      for (let i = 0; i < batch.length; i += 1) {
        const entry = batch[i]!
        const vector = embedded.vectors[i]
        if (vector === undefined) {
          await recordBackfillFailure(connection, entry, 'vector-missing', now)
          continue
        }
        // 幂等 + 原子：WHERE embedding IS NULL 让第二次调用不再命中，返回 false 即静默跳过。
        const applied = await runInTransaction(connection, async () => {
          const updated = await setMemoryEmbedding(connection, entry.id, vector, options.modelId)
          if (!updated) return false
          await insertGenerationLog(connection, {
            recordedAt: now.toISOString(),
            actor: 'system',
            kind: CAPTURE_KIND,
            action: BACKFILL_EMBEDDING_ACTION,
            policy: DEFAULT_CAPTURE_POLICY,
            outcome: 'success',
            reason: `node=${entry.id} dim=${vector.length}`,
          })
          return true
        })
        if (applied) filled += 1
      }
    }
    return filled
  }
  return { runOnce }
}

/**
 * NULL 向量有界回填（Story 2.4 / U5；deferred-work.md 的 Story 1.6 遗留项）。
 *
 * Epic 1 的直写路径（memory_remember / 手动写入）不产向量，节点三列保持 NULL；
 * 这些节点进不了 HNSW 索引，等于对路径②（语义去重）与 2.5 的语义检索隐形。
 * 本模块在**写者空闲窗口**把它们补齐：
 *
 * - 只在 `embeddingMode === 'enabled'` 且维度已 pin 时接线（由 src/index.ts 决定）；
 * - 受空闲闸门约束：入口查一次 `gate.isIdle()`，**每个批次迭代前再复查一次**
 *   （评审 P9⑥ / EC-4）——为假立即 break，一轮绝不跨 turn 边界继续发网络或写库；
 * - 每轮至多 `BACKFILL_BATCH_SIZE`（50）条，按 `EMBEDDING_MAX_BATCH`（8）切请求；
 *   每个批次各自拿一个 `AbortSignal.timeout(BACKFILL_RUN_TIMEOUT_MS)` 预算
 *   （评审 P9①：整轮共用一个 signal 时，首批耗尽预算会让余批全部 abort）；
 * - 每轮起始读一次库内 pin 的 dim：未 pin 或条目向量长度不符 ⇒ 不写
 *   （评审 P9④：绝不把未校验长度绑进 FLOAT[dim]）；
 * - 每条写入走 `runInTransaction(setMemoryEmbedding + 成功审计)`：DB 写失败只记失败并
 *   continue，**不再中止整轮**（评审 P9② / BH-12）；审计与写入同事务（评审 P9②/ BH-06：
 *   事务外写审计可能落进别人未结算的连接级事务）；
 * - 失败审计改为**每轮至多一条聚合行**（失败条数 + 首个 reason），替代逐条/逐批
 *   （评审 P9③ / EC-3）——端点故障时不再每分钟灌数十行；审计 reason 只写机器 reason，
 *   完整 message 只进 logger（评审 P9⑦ / EC-6，与 processor.ts 的记账口径统一）；
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
import { readPinnedEmbeddingDim } from '../db/dedup.js'
import { listUnembeddedMemories, setMemoryEmbedding } from '../db/memory.js'
import { runInTransaction } from '../db/transaction.js'
import type { IdleGate } from '../inbox/idle-gate.js'
import { EMBEDDING_MAX_BATCH, type EmbedClient } from './client.js'

/** 每轮回填条数上界（U5 的 N=50）：把一轮的时长与内存占用钉死，剩余留到下一轮。 */
export const BACKFILL_BATCH_SIZE = 50

/**
 * 单个 embedding 请求的预算（评审 P9①：按**批次**计时，不是按轮）。
 * 超时后这一批失败并计入聚合失败行，其余批次仍各拿一份自己的预算。
 */
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

/**
 * 每轮至多一条的**聚合**失败审计（评审 P9③ / EC-3）：失败条数 + 首个 reason。
 * 与节点写入一样放进事务（评审 P9② / BH-06：审计在事务外用同一连接写，可能落进别人
 * 未结算的连接级事务，随对方 COMMIT/ROLLBACK）。
 */
async function recordRoundFailure(
  connection: lbug.Connection,
  failed: number,
  firstReason: string,
  nowIso: string,
): Promise<void> {
  await runInTransaction(connection, async () => {
    await insertGenerationLog(connection, {
      recordedAt: nowIso,
      actor: 'system',
      kind: CAPTURE_KIND,
      action: BACKFILL_EMBEDDING_ACTION,
      policy: DEFAULT_CAPTURE_POLICY,
      outcome: 'failure',
      reason: `failed=${failed} first=${firstReason}`,
    })
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
    const nowIso = now.toISOString()
    // 评审 P9④：每轮起始读一次库内 pin 的 dim。读不到就无法校验向量长度 ⇒ 本轮一条都不写
    //（宁可留到维度 pin 好之后，也不把未经校验的向量绑进 FLOAT[dim]）。
    const dim = await readPinnedEmbeddingDim(connection)
    if (dim === null) {
      options.logger?.warn('NULL 向量回填跳过：库内未 pin embedding 维度（dim 缺失）')
      await recordRoundFailure(connection, entries.length, 'dim-not-pinned', nowIso)
      return 0
    }
    let filled = 0
    let failed = 0
    let firstFailure: string | null = null
    for (let start = 0; start < entries.length; start += EMBEDDING_MAX_BATCH) {
      // 评审 P9⑥ / EC-4：每次批次迭代前复查空闲闸门——一轮里宿主随时可能开始新 turn。
      if (!options.gate.isIdle()) break
      const batch = entries.slice(start, start + EMBEDDING_MAX_BATCH)
      // 评审 P9①：每批一个新预算，避免首批耗尽后余批全部 abort。
      const signal = AbortSignal.timeout(BACKFILL_RUN_TIMEOUT_MS)
      const embedded = await options.client.embed(
        options.model,
        batch.map((entry) => entry.text),
        signal,
      )
      if (!embedded.ok) {
        failed += batch.length
        firstFailure ??= embedded.reason
        // 完整 message（可能含 endpoint URL）只进 logger；审计行只留机器 reason（EC-6）。
        options.logger?.warn(
          'NULL 向量回填批次失败（' + batch.length + ' 条，reason=' + embedded.reason + '）：' + embedded.message,
        )
        continue
      }
      for (let i = 0; i < batch.length; i += 1) {
        const entry = batch[i]!
        const vector = embedded.vectors[i]
        if (vector === undefined) {
          failed += 1
          firstFailure ??= 'vector-missing'
          continue
        }
        if (vector.length !== dim) {
          failed += 1
          firstFailure ??= `dim-mismatch got=${vector.length} pinned=${dim}`
          continue
        }
        try {
          // 评审 P9②：幂等 + 原子（WHERE embedding IS NULL 让第二次调用不再命中）；单条写失败
          // 只记失败并继续，绝不中止整轮。
          const applied = await runInTransaction(connection, async () => {
            const updated = await setMemoryEmbedding(connection, entry.id, vector, options.modelId)
            if (!updated) return false
            await insertGenerationLog(connection, {
              recordedAt: nowIso,
              actor: 'system',
              kind: CAPTURE_KIND,
              action: BACKFILL_EMBEDDING_ACTION,
              policy: DEFAULT_CAPTURE_POLICY,
              outcome: 'success',
              reason: `node=${entry.id} dim=${vector.length}`,
            })
            return true
          })
          if (applied) {
            filled += 1
          } else {
            failed += 1
            firstFailure ??= 'already-embedded'
          }
        } catch (error) {
          failed += 1
          const message = error instanceof Error ? error.message : String(error)
          firstFailure ??= message
          options.logger?.warn(`NULL 向量回填写库失败（node=${entry.id}）：${message}`)
        }
      }
    }
    // 评审 P9③：整轮只落一条聚合失败行（成功行仍逐条，总量受库内 NULL 节点数约束）。
    if (failed > 0) await recordRoundFailure(connection, failed, firstFailure ?? 'unknown', nowIso)
    return filled
  }
  return { runOnce }
}

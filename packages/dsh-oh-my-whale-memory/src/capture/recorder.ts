/**
 * 三钩子采集器（Story 2.1 / FR-2、AD-4、AD-7）：把 session/event 的三个事件落成
 * L0 原始流水 + L1_INBOX 排队条目。
 *
 * 三条纪律：
 * 1. **同一事务**：L0 行与 INBOX 行在同一个 runInTransaction 里写（FR-2 原子）。id 由稳定身份
 *    经 uuid5 确定性算出，故崩溃重放不会造出第二条队列条目（否则同一段对话会被精炼两次）。
 * 2. **绝不抛给宿主**：session/event 监听器返回 void，且压缩主路径不能被采集失败牵连；
 *    因此所有落库都登记进 INBOX_BACKGROUND_TASKS（防 GC、dispose 前统一 drain）并在内部
 *    捕获异常，只留下 warn。
 * 3. **压缩走同步快照**：compaction/start 的同步路径只做「取文本 + 落快照文件」，< 50ms；
 *    落库转后台，快照文件是崩溃标记，未删即孤儿，启动时重放（AC5）。
 */
import type * as lbug from '@ladybugdb/core'
import { captureStableKey, l0InboxId, l0RawId, writeL0Raw } from '../db/l0.js'
import { runInTransaction } from '../db/transaction.js'
import { trackInboxBackgroundTask } from '../inbox/consumer.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import { writeInboxItem } from '../inbox/queue.js'
import { createStepCounter, type StepCounter } from './step-counter.js'
import { listSnapshots, removeSnapshot, writeSnapshot } from './snapshot-store.js'
import { renderTranscript, sessionMessages } from './transcript.js'

/** 宿主合成、非 live 发射的 turn/end：不是真实轮末，跳过（Spec Change Log 第 1 条）。 */
const SYNTHETIC_TURN_END = ['interrupted', 'forked']

export interface CaptureRecorderOptions {
  /** 惰性取连接：建库完成前为 null（那一次采集直接放弃，不抛）。 */
  readonly connection: () => lbug.Connection | null
  /** 步数阈值 N（Config.captureSteps）。 */
  readonly captureSteps: number
  /** 快照目录（<profile>/memory/capture）。 */
  readonly snapshotDir: string
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void; info?(message: string): void }
  /** turn/end 采集前的持久化屏障（ctx.sessions.flush；宿主无该能力时缺省 no-op）。 */
  readonly flush?: (session: unknown) => Promise<unknown>
}

export interface CaptureRecorder {
  recordStepEnd(session: unknown, event: unknown): void
  recordCompactionStart(session: unknown, event: unknown): void
  recordTurnEnd(session: unknown, event: unknown): void
  /** 启动扫描残留快照（有文件 = 事务未提交）并重放；返回重放条数。 */
  replayOrphanSnapshots(): Promise<number>
}

interface CaptureEntry {
  readonly kind: string
  readonly sessionId: string
  readonly ref: string
  readonly text: string
  readonly actor: string
  readonly recordedAt: Date
}

export function createCaptureRecorder(options: CaptureRecorderOptions): CaptureRecorder {
  const now = options.now ?? (() => new Date())
  const steps: StepCounter = createStepCounter({ limit: options.captureSteps })
  /** 每会话已采集的最大 turn：turn 号单调，故 turn <= 已采集值即重复（每轮至多一次）。 */
  const lastTurn = new Map<string, number>()
  const warn = (message: string): void => {
    options.logger?.warn(message)
  }
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  /** 一个事务里写 L0 行 + INBOX 行；同一稳定身份重放幂等（MERGE ON CREATE SET）。 */
  async function persist(entry: CaptureEntry): Promise<void> {
    const connection = options.connection()
    if (!connection) throw new Error('记忆库未就绪：采集写入放弃')
    const stableKey = captureStableKey(entry.kind, entry.sessionId, entry.ref)
    await runInTransaction(connection, async () => {
      await writeL0Raw(connection, {
        id: l0RawId(stableKey),
        text: entry.text,
        recordedAt: entry.recordedAt,
        actor: entry.actor,
      })
      await writeInboxItem(connection, {
        id: l0InboxId(stableKey),
        payload: entry.text,
        sessionId: entry.sessionId,
        kind: entry.kind,
        now: entry.recordedAt,
      })
    })
  }

  /** 登记后台落库：异常只记 warn，绝不逃逸到 session/event 发射方。 */
  function background(work: Promise<unknown>, label: string): void {
    void trackInboxBackgroundTask(work.catch((error: unknown) => {
      warn('采集落库失败（' + label + '）：' + errorText(error))
    }))
  }

  function entryFor(kind: string, session: unknown, ref: string): CaptureEntry {
    const sessionId = inboxSessionKey(session)
    return {
      kind,
      sessionId,
      ref,
      text: renderTranscript(sessionMessages(session)),
      actor: sessionId,
      recordedAt: now(),
    }
  }

  return {
    recordStepEnd(session, event) {
      const data = event as { readonly turn?: unknown; readonly step?: unknown } | null | undefined
      const sessionId = inboxSessionKey(session)
      if (!steps.recordStep(sessionId)) return
      const ref = String(data?.turn ?? '?') + ':' + String(data?.step ?? '?')
      background(persist(entryFor('step', session, ref)), 'step/end')
    },

    recordCompactionStart(session, event) {
      const data = event as { readonly compactionId?: unknown; readonly turn?: unknown } | null | undefined
      const sessionId = inboxSessionKey(session)
      steps.reset(sessionId)
      const ref = typeof data?.compactionId === 'string' && data.compactionId.length > 0
        ? data.compactionId
        : 'turn-' + String(data?.turn ?? 'manual')
      const entry = entryFor('compaction', session, ref)
      try {
        // 同步路径：entryFor 已取完文本（deriveMessages 同步缓存），这里只落文件。
        const file = writeSnapshot(options.snapshotDir, {
          stableKey: captureStableKey(entry.kind, entry.sessionId, entry.ref),
          kind: entry.kind,
          sessionId: entry.sessionId,
          ref: entry.ref,
          text: entry.text,
          actor: entry.actor,
          recordedAt: entry.recordedAt.toISOString(),
        })
        background(
          persist(entry).then(() => {
            removeSnapshot(options.snapshotDir, file)
          }),
          'compaction/start',
        )
      } catch (error) {
        // AC2：写入失败只捕获放行，绝不抛给压缩事务（宿主也会兜住 observer 失败，但不依赖它）。
        warn('压缩快照写入失败（不阻塞压缩主路径）：' + errorText(error))
      }
    },

    recordTurnEnd(session, event) {
      const data = event as { readonly turn?: unknown; readonly reason?: unknown } | null | undefined
      const sessionId = inboxSessionKey(session)
      const reason = data?.reason
      const reasonKind = typeof reason === 'string'
        ? reason
        : (reason as { readonly kind?: unknown } | null | undefined)?.kind
      if (typeof reasonKind === 'string' && SYNTHETIC_TURN_END.includes(reasonKind)) return
      const turn = typeof data?.turn === 'number' && Number.isFinite(data.turn) ? data.turn : -1
      const seen = lastTurn.get(sessionId)
      if (seen !== undefined && turn <= seen) return
      lastTurn.set(sessionId, turn)
      steps.reset(sessionId)
      background((async () => {
        if (options.flush) {
          try {
            await options.flush(session)
          } catch (error) {
            // 屏障失败不丢采集：文本来自内存中的 deriveMessages，继续。
            warn('turn/end 采集前的 session flush 失败（继续采集）：' + errorText(error))
          }
        }
        await persist(entryFor('turn', session, String(turn)))
      })(), 'turn/end')
    },

    async replayOrphanSnapshots() {
      const records = listSnapshots(options.snapshotDir)
      if (records.length === 0) return 0
      if (!options.connection()) {
        // 文件不是可丢弃的垃圾：留着下次启动再试，并留下可见信号（不然孤儿会静默堆着）。
        warn('孤儿快照重放跳过：记忆库未就绪，保留 ' + records.length + ' 个快照文件下次再试')
        return 0
      }
      let replayed = 0
      for (const record of records) {
        try {
          await persist({
            kind: record.kind,
            sessionId: record.sessionId,
            ref: record.ref,
            text: record.text,
            actor: record.actor,
            recordedAt: new Date(record.recordedAt),
          })
          if (record.file) removeSnapshot(options.snapshotDir, record.file)
          replayed += 1
        } catch (error) {
          // 单个快照失败不阻塞启动：保留文件，下次启动再试。
          warn('孤儿快照重放失败（保留文件下次再试）：' + errorText(error))
        }
      }
      return replayed
    },
  }
}

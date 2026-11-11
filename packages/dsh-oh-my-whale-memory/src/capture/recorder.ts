/**
 * 三钩子采集器（Story 2.1 / FR-2、AD-4、AD-7）：把 session/event 的三个事件落成
 * L0 原始流水 + L1_INBOX 排队条目。
 *
 * 三条纪律：
 * 1. **同一事务 + 同一身份**：L0 行与 INBOX 行在同一个 runInTransaction 里写（FR-2 原子）。
 *    **两行共用 l0RawId(stableKey)**（Story 2.3 评审 T1：L1 的 source_refs 必须能命中 L0），
 *    该 id 由稳定身份经 uuid5 确定性算出，故崩溃重放不会造出第二条队列条目。
 *    注意 `l1_inbox.id` 的语义因此是「采集身份」而非纯队列序号——同一次采集在两张表里同一个 id。
 * 2. **绝不抛给宿主**：session/event 监听器返回 void，且压缩主路径不能被采集失败牵连；
 *    因此所有落库都登记进 INBOX_BACKGROUND_TASKS（防 GC、dispose 前统一 drain）并在内部
 *    捕获异常，只留下 warn。
 * 3. **压缩走同步快照**：compaction/start 的同步路径只做「取文本 + 落快照文件」，< 50ms；
 *    落库转后台，快照文件是崩溃标记，未删即孤儿，启动时重放（AC5）。
 */
import type * as lbug from '@ladybugdb/core'
import { captureStableKey, l0RawId, writeL0Raw } from '../db/l0.js'
import { runInTransaction } from '../db/transaction.js'
import { trackInboxBackgroundTask } from '../inbox/consumer.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import { writeInboxItem } from '../inbox/queue.js'
import { createStepCounter, type StepCounter } from './step-counter.js'
import { cleanStaleSnapshotTemps, listSnapshots, removeSnapshot, writeSnapshot } from './snapshot-store.js'
import { renderTranscript, sessionMessages } from './transcript.js'

/** 宿主合成、非 live 发射的 turn/end：不是真实轮末，跳过（Spec Change Log 第 1 条）。 */
const SYNTHETIC_TURN_END = ['interrupted', 'forked']

/**
 * 宿主 SessionEvent 的形状是 { type, seq, time, data }（宿主 packages/core/session/src/types.ts:501-508，
 * 官方范例读 event.data.stream 见 docs/cookbook/extension-cookbook.md:79-86）：payload 在 **data** 里，
 * 读顶层字段会静默拿到 undefined（2026-11-11 评审 T1）。这里不做顶层回退，回退会让回归钉失效。
 */
function eventPayload(event: unknown): Record<string, unknown> {
  const data = (event as { readonly data?: unknown } | null | undefined)?.data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/** 空文本不是可采集事实：不写 L0、compaction 连快照也不落（评审 P5）。 */
function hasText(text: string): boolean {
  return text.trim().length > 0
}

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
  /** 每会话**落库成功**的最大 turn：turn 号单调，故 turn <= 该值即重复（每轮至多一次，评审 P4）。 */
  const lastTurn = new Map<string, number>()
  const warn = (message: string): void => {
    options.logger?.warn(message)
  }
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  /**
   * 一个事务里写 L0 行 + INBOX 行；同一稳定身份重放幂等（MERGE ON CREATE SET）。
   *
   * **两行共用同一个 l0RawId(stableKey)**（Story 2.3 评审 T1）：证据链要求精炼产出的 L1
   * 节点 source_refs 与审计 l0Refs 指向真实的 L0 行；INBOX 行另有前缀就永远命不中。
   */
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
        id: l0RawId(stableKey),
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
      const payload = eventPayload(event)
      const sessionId = inboxSessionKey(session)
      if (!steps.recordStep(sessionId)) return
      const ref = String(payload.turn ?? '?') + ':' + String(payload.step ?? '?')
      const entry = entryFor('step', session, ref)
      if (!hasText(entry.text)) {
        warn('step/end 采集跳过：会话文本为空（' + entry.sessionId + ' @ ' + ref + '）')
        return
      }
      background(persist(entry), 'step/end')
    },

    recordCompactionStart(session, event) {
      const payload = eventPayload(event)
      const sessionId = inboxSessionKey(session)
      steps.reset(sessionId)
      const compactionId = payload.compactionId
      const ref = typeof compactionId === 'string' && compactionId.length > 0
        ? compactionId
        : 'turn-' + String(payload.turn ?? 'manual')
      const entry = entryFor('compaction', session, ref)
      if (!hasText(entry.text)) {
        // P5：空文本连快照也不落，否则会造出「重放也写不出内容」的空孤儿。
        warn('compaction/start 采集跳过：会话文本为空（' + entry.sessionId + ' @ ' + ref + '）')
        return
      }
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
      const payload = eventPayload(event)
      const sessionId = inboxSessionKey(session)
      const reason = payload.reason
      const reasonKind = typeof reason === 'string'
        ? reason
        : (reason as { readonly kind?: unknown } | null | undefined)?.kind
      if (typeof reasonKind === 'string' && SYNTHETIC_TURN_END.includes(reasonKind)) return
      const turn = typeof payload.turn === 'number' && Number.isFinite(payload.turn) ? payload.turn : -1
      const seen = lastTurn.get(sessionId)
      if (seen !== undefined && turn <= seen) return
      // P3：文本与 recorded_at 必须在 flush 之前取——flush 之后 deriveMessages 可能已被下一轮推进。
      const entry = entryFor('turn', session, String(turn))
      if (!hasText(entry.text)) {
        warn('turn/end 采集跳过：会话文本为空（' + entry.sessionId + ' @ turn ' + turn + '）')
        return
      }
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
        await persist(entry)
        // P4：只有落库成功才推进「已采集的最大 turn」——失败的内容会被下一次采集重新带上。
        lastTurn.set(sessionId, Math.max(seen ?? turn, turn))
      })(), 'turn/end')
    },

    async replayOrphanSnapshots() {
      // P10：启动扫描先清掉「写一半就崩掉」的临时文件；P8：畸形记录跳过 + warn + 保留文件。
      cleanStaleSnapshotTemps(options.snapshotDir)
      const records = listSnapshots(options.snapshotDir, (file, reason) => {
        warn('孤儿快照跳过（' + reason + '）：' + file + '（保留文件待人工排查）')
      })
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

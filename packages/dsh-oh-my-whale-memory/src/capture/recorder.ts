/**
 * 三钩子采集器（Story 2.1 / FR-2、AD-4、AD-7）：把 session/event 的三个事件落成
 * L0 原始流水 + L1_INBOX 排队条目。
 *
 * 三条纪律：
 * 1. 同一事务 + 同一身份：L0 行与 INBOX 行在同一个 runInTransaction 里写（FR-2 原子）。
 *    两行共用 l0RawId(stableKey)（Story 2.3 评审 T1：L1 的 source_refs 必须能命中 L0），
 *    该 id 由稳定身份经 uuid5 确定性算出，故崩溃重放不会造出第二条队列条目。
 *    `l1_inbox.id` 的语义因此是「采集身份」而非纯队列序号，同一次采集在两张表里同一个 id。
 * 2. 不抛给宿主：session/event 监听器返回 void，且压缩主路径不能被采集失败牵连；
 *    因此所有落库都登记进 INBOX_BACKGROUND_TASKS（防 GC、dispose 前统一 drain）并在内部
 *    捕获异常，只留下 warn。
 * 3. 压缩走同步快照：compaction/start 的同步路径只做「取文本 + 落快照文件」，< 50ms；
 *    落库转后台，快照文件是崩溃标记，未删即孤儿，启动时重放（AC5）。
 */
import type * as lbug from '@ladybugdb/core'
import { captureStableKey, l0PointerId, l0RawId, writeL0Pointer, writeL0Raw } from '../db/l0.js'
import { readMetaValue, writeMetaValue } from '../db/meta.js'
import { runInTransaction } from '../db/transaction.js'
import { trackInboxBackgroundTask } from '../inbox/consumer.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import { writeInboxItem } from '../inbox/queue.js'
import {
  EMPTY_TOKEN_LEDGER,
  formatTokenLedgerState,
  parseTokenLedgerState,
  planTrigger,
  tokenLedgerMetaKey,
  type TokenLedgerThresholds,
  type TokenNodeLike,
} from './token-ledger.js'
import { recordPurifyRun } from '../context/purify-ledger.js'
import {
  purifyMessages,
  type PurifyMessageLike,
  type PurifyOptions,
  type PurifyRule,
} from '../context/purify.js'
import { createStepCounter, type StepCounter } from './step-counter.js'
import { cleanStaleSnapshotTemps, listSnapshots, removeSnapshot, writeSnapshot } from './snapshot-store.js'
import { renderTranscript, sessionMessages } from './transcript.js'

/** 宿主合成、非 live 发射的 turn/end：不是真实轮末，跳过（Spec Change Log 第 1 条）。 */
const SYNTHETIC_TURN_END = ['interrupted', 'forked']

/**
 * 宿主 SessionEvent 的形状是 { type, seq, time, data }（宿主 packages/core/session/src/types.ts:501-508，
 * 官方范例读 event.data.stream 见 docs/cookbook/extension-cookbook.md:79-86）：payload 在 data 里，
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

/** Story 10.1：进入 L0 的三类宿主事件（非 text part 一律不进）。 */
const POINTER_EVENT_TYPES = ['user/message', 'assistant/message', 'tool/result'] as const

/**
 * Story 10.1：事件是否携带非空 text part。
 *
 * 宿主把消息放在 `data.message`（部分路径直接放 `data`）；两种形态都认，
 * 非 text 块（image / reasoning / tool-call arguments）不算。
 */
function eventHasText(event: unknown): boolean {
  const payload = eventPayload(event)
  const message = (payload.message ?? payload) as { readonly content?: unknown } | null | undefined
  const content = message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    const candidate = block as { readonly type?: unknown, readonly text?: unknown } | null | undefined
    return candidate?.type === 'text' && typeof candidate.text === 'string' && candidate.text.trim().length > 0
  })
}

/** Story 10.1：token 触发器（宿主可选服务）。 */
export interface TokenMeterLike {
  measure(session: unknown): { readonly nodes?: readonly TokenNodeLike[] } | undefined
}

/** Story 10.1：指针化采集的运行时开关与依赖（缺省 = 旧 inline 快照路径）。 */
export interface PointerCaptureOptions {
  /** `ctx.sessionPersistence` 在场 = 可写指针行（否则保留 inline 快照并 warn）。 */
  readonly available: boolean
  /** `ctx.tokenMeter`（缺失 ⇒ 回退 captureSteps 触发）。 */
  readonly tokenMeter: TokenMeterLike | null
  readonly thresholds: TokenLedgerThresholds
}

export type CaptureTriggerMode = 'tokens' | 'steps(degraded)'
export type CapturePersistenceMode = 'available' | 'unavailable'

export interface CaptureMode {
  readonly trigger: CaptureTriggerMode
  readonly persistence: CapturePersistenceMode
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
  /**
   * turn/end 落库成功后的回调（Story 7.2 / AC:1406：兴趣分与触发决策要写进账本）。
   * 只接收已落库的正文与时刻，不传 session（避免回调方持有宿主对象）。
   */
  readonly onTurnCaptured?: (input: { readonly text: string; readonly recordedAt: Date }) => void
  /**
   * Story 8.6 / T4、AC:1896：L1_INBOX 入队前的确定性净化（非 user 段；user 原话不净化）。
   * 缺省 = 模块默认（R1 + R3 开、R2 关）。L0 始终写**原文**（append-only，NFR10）。
   */
  readonly purify?: PurifyOptions
  /**
   * Story 10.1：指针化采集。缺省 = 旧 inline 快照路径（Epic 2 起的行为不变）。
   * `available=false`（sessionPersistence 缺失）时也走旧路径并 warn。
   */
  readonly pointer?: PointerCaptureOptions
}

export interface CaptureRecorder {
  recordStepEnd(session: unknown, event: unknown): void
  recordCompactionStart(session: unknown, event: unknown): void
  recordTurnEnd(session: unknown, event: unknown): void
  /** Story 10.1：三类消息事件（text part 非空）进「下一边界批量写指针行」的缓冲。 */
  recordMessage(session: unknown, event: unknown): void
  /** 会话销毁：清掉该会话的步数计数与「已采集最大 turn」（有界内存，不依赖 turn/end 配对）。 */
  resetSession(sessionId: string): void
  /** 启动扫描残留快照（有文件 = 事务未提交）并重放；返回重放条数。 */
  replayOrphanSnapshots(): Promise<number>
  /** Story 10.1：status 可见的采集模式（tokens / steps(degraded)；指针持久化是否可用）。 */
  captureMode(): CaptureMode
}

interface CaptureEntry {
  readonly kind: string
  readonly sessionId: string
  readonly ref: string
  /** L0 原文（append-only，永不被净化改写）。 */
  readonly text: string
  /** L1_INBOX 入队正文（= 净化后的非 user 段；无改动时与 `text` 相同）。 */
  readonly inboxText: string
  /** 净化账本数据（无改动时 null）。 */
  readonly purify: {
    readonly ruleHits: readonly PurifyRule[]
    readonly removedChars: number
    readonly removedTokens: number
    readonly sourceChars: number
  } | null
  readonly actor: string
  readonly recordedAt: Date
}

export function createCaptureRecorder(options: CaptureRecorderOptions): CaptureRecorder {
  const now = options.now ?? (() => new Date())
  const steps: StepCounter = createStepCounter({ limit: options.captureSteps })
  /** 每会话落库成功的最大 turn：turn 号单调，故 turn <= 该值即重复（每轮至多一次，评审 P4）。 */
  const lastTurn = new Map<string, number>()
  const warn = (message: string): void => {
    options.logger?.warn(message)
  }
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  // Story 10.1：指针化采集状态（每会话的「下一边界要写的 seq → 事件类型」）。
  const pointer = options.pointer
  const pointerActive = pointer?.available === true
  // sessionPersistence 缺失的降级告警：只在第一次边界出现（不在 apply 期刷，避免 success 路径告警）。
  let warnedNoPersistence = false
  const warnNoPersistenceOnce = (): void => {
    if (pointer === undefined || pointerActive || warnedNoPersistence) return
    warnedNoPersistence = true
    warn('sessionPersistence 不可用：L0 保留 inline 快照采集（pointer 采集降级，status 可见）')
  }
  const buffered = new Map<string, Map<number, string>>()
  const pointerBuffer = (sessionId: string): Map<number, string> => {
    const existing = buffered.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<number, string>()
    buffered.set(sessionId, created)
    return created
  }

  /** 把当前会话缓冲的指针行在一个事务里写出（同 seq 重放幂等）。 */
  async function flushPointerRows(sessionId: string, connection: lbug.Connection): Promise<readonly number[]> {
    const buffer = buffered.get(sessionId)
    if (buffer === undefined || buffer.size === 0) return []
    const entries = [...buffer.entries()].sort((a, b) => a[0] - b[0])
    const recordedAt = now()
    await runInTransaction(connection, async () => {
      for (const [seq, eventType] of entries) {
        await writeL0Pointer(connection, {
          id: l0PointerId(sessionId, seq),
          sessionId,
          seq,
          eventType,
          recordedAt,
        })
      }
    })
    buffer.clear()
    return entries.map(([seq]) => seq)
  }

  /** 指针模式下只写 INBOX（正文是 10.1 的过渡形态；L0 已由 pointer 行承载）。 */
  async function persistInboxOnly(entry: CaptureEntry, firstSeq: number | null): Promise<void> {
    const connection = options.connection()
    if (connection === null) throw new Error('记忆库未就绪：采集写入放弃')
    // INBOX id 指向本段第一条 pointer 行：EII 沿 source_refs 能命中真实 L0（且 pointer 行在新谓词下可达）。
    const id = firstSeq !== null && Number.isInteger(firstSeq) && firstSeq >= 0
      ? l0PointerId(entry.sessionId, firstSeq)
      : l0RawId(captureStableKey(entry.kind, entry.sessionId, entry.ref))
    await runInTransaction(connection, () =>
      writeInboxItem(connection, {
        id,
        payload: entry.inboxText,
        sessionId: entry.sessionId,
        kind: entry.kind,
        now: entry.recordedAt,
      }))
    if (entry.purify !== null && entry.inboxText !== entry.text) {
      await recordPurifyRun(
        {
          sessionId: entry.sessionId,
          rangeStart: 0,
          rangeEnd: entry.purify.sourceChars,
          ruleHits: entry.purify.ruleHits,
          removedChars: entry.purify.removedChars,
          removedTokens: entry.purify.removedTokens,
        },
        { logger: options.logger },
      )
    }
  }

  /**
   * 一个采集边界的指针化处理：先写指针行，再算 token 增量并决定是否触发 INBOX。
   *
   * 触发条件（AC:2026）：`seq > lastSeq` 的 tokens 累计 ≥ captureTokens；`forceFlush`（compaction/start）
   * 无视阈值强制触发；`tokenMeter` 缺失时退回 `captureSteps` 连续步数（NFR12）。
   */
  async function tokenBoundary(
    kind: string,
    session: unknown,
    sessionId: string,
    ref: string,
    forceFlush: boolean,
  ): Promise<void> {
    const connection = options.connection()
    if (connection === null) return
    const firstSeq = (() => {
      const buffer = buffered.get(sessionId)
      if (buffer === undefined || buffer.size === 0) return null
      return Math.min(...buffer.keys())
    })()
    const flushed = await flushPointerRows(sessionId, connection)
    const refOfRange = flushed.length > 0
      ? String(flushed[0]) + '-' + String(flushed[flushed.length - 1])
      : ref

    let triggered = false
    if (pointer?.tokenMeter != null) {
      const state = parseTokenLedgerState(await readMetaValue(connection, tokenLedgerMetaKey(sessionId)))
      const nodes = pointer.tokenMeter.measure(session)?.nodes ?? []
      const decision = planTrigger(state, nodes, pointer.thresholds, { forceFlush })
      triggered = decision.triggered
      if (decision.oversize) {
        warn('token 触发超过硬上限（单事件不切碎，标记 oversize）：session=' + sessionId + ' ref=' + refOfRange)
      }
      if (triggered) {
        const entry = entryFor(kind, session, refOfRange)
        if (hasText(entry.text)) await persistInboxOnly(entry, firstSeq)
      }
      // 触发成功后才推进账本；写失败时 state 不前进，下一边界会重新带上同一批 nodes。
      await writeMetaValue(connection, tokenLedgerMetaKey(sessionId), formatTokenLedgerState(decision.state))
      return
    }

    // 降级：tokenMeter 缺失时用 captureSteps 连续步数触发（与旧路径同一计数器）。
    triggered = steps.recordStep(sessionId)
    if (triggered) {
      const entry = entryFor(kind, session, refOfRange)
      if (hasText(entry.text)) await persistInboxOnly(entry, firstSeq)
    }
  }

  /**
   * 一个事务里写 L0 行 + INBOX 行；同一稳定身份重放幂等（MERGE ON CREATE SET）。
   *
   * 两行共用同一个 l0RawId(stableKey)（Story 2.3 评审 T1）：证据链要求精炼产出的 L1
   * 节点 source_refs 与审计 l0Refs 指向真实的 L0 行；INBOX 行另有前缀就永远命不中。
   */
  async function persist(entry: CaptureEntry): Promise<void> {
    const connection = options.connection()
    if (!connection) throw new Error('记忆库未就绪：采集写入放弃')
    const stableKey = captureStableKey(entry.kind, entry.sessionId, entry.ref)
    await runInTransaction(connection, async () => {
      // L0 原文：append-only，净化**不**写回这里（INV-1 / NFR10）。
      await writeL0Raw(connection, {
        id: l0RawId(stableKey),
        text: entry.text,
        recordedAt: entry.recordedAt,
        actor: entry.actor,
      })
      // L1_INBOX：入队前已净化（Story 8.6 / AC:1896）。
      await writeInboxItem(connection, {
        id: l0RawId(stableKey),
        payload: entry.inboxText,
        sessionId: entry.sessionId,
        kind: entry.kind,
        now: entry.recordedAt,
      })
    })
    // Story 8.6 / T5：落库成功后记一行净化账本（写失败只 warn，不影响采集）。
    if (entry.purify !== null && entry.inboxText !== entry.text) {
      await recordPurifyRun(
        {
          sessionId: entry.sessionId,
          rangeStart: 0,
          rangeEnd: entry.purify.sourceChars,
          ruleHits: entry.purify.ruleHits,
          removedChars: entry.purify.removedChars,
          removedTokens: entry.purify.removedTokens,
        },
        { logger: options.logger },
      )
    }
  }

  /** 登记后台落库：异常只记 warn，不逃逸到 session/event 发射方。 */
  function background(work: Promise<unknown>, label: string): void {
    void trackInboxBackgroundTask(work.catch((error: unknown) => {
      warn('采集落库失败（' + label + '）：' + errorText(error))
    }))
  }

  function entryFor(kind: string, session: unknown, ref: string): CaptureEntry {
    const sessionId = inboxSessionKey(session)
    const messages = sessionMessages(session)
    const text = renderTranscript(messages)
    // Story 8.6 / T4：只净化非 user 段（assistant.text / assistant.reasoning），
    // 且只作用于 INBOX 副本；L0 与快照仍用原文（INV-1）。
    const purified = purifyMessages(messages as readonly PurifyMessageLike[], options.purify ?? null)
    return {
      kind,
      sessionId,
      ref,
      text,
      inboxText: purified.changed ? renderTranscript(purified.messages) : text,
      purify: purified.changed
        ? {
          ruleHits: purified.ruleHits,
          removedChars: purified.removedChars,
          removedTokens: purified.removedTokens,
          sourceChars: purified.sourceChars,
        }
        : null,
      actor: sessionId,
      recordedAt: now(),
    }
  }

  return {
    recordStepEnd(session, event) {
      warnNoPersistenceOnce()
      const payload = eventPayload(event)
      const sessionId = inboxSessionKey(session)
      const ref = String(payload.turn ?? '?') + ':' + String(payload.step ?? '?')
      // Story 10.1：指针模式只在边界批量写 pointer 行 + 算 token 触发；不再写 inline 快照。
      if (pointerActive) {
        background(tokenBoundary('step', session, sessionId, ref, false), 'step/end(pointer)')
        return
      }
      if (!steps.recordStep(sessionId)) return
      const entry = entryFor('step', session, ref)
      if (!hasText(entry.text)) {
        warn('step/end 采集跳过：会话文本为空（' + entry.sessionId + ' @ ' + ref + '）')
        return
      }
      background(persist(entry), 'step/end')
    },

    recordMessage(session, event) {
      if (!pointerActive) return
      const type = (event as { readonly type?: unknown } | null | undefined)?.type
      if (typeof type !== 'string' || !(POINTER_EVENT_TYPES as readonly string[]).includes(type)) return
      const seq = (event as { readonly seq?: unknown } | null | undefined)?.seq
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return
      if (!eventHasText(event)) return
      pointerBuffer(inboxSessionKey(session)).set(seq, type)
    },

    recordCompactionStart(session, event) {
      const payload = eventPayload(event)
      const sessionId = inboxSessionKey(session)
      steps.reset(sessionId)
      const compactionId = payload.compactionId
      const ref = typeof compactionId === 'string' && compactionId.length > 0
        ? compactionId
        : 'turn-' + String(payload.turn ?? 'manual')
      // Story 10.1 / AC:2028：force flush 当前累计并重置游标；同步路径只记 seq 区间、不读正文。
      if (pointerActive) {
        background(tokenBoundary('compaction', session, sessionId, ref, true), 'compaction/start(pointer)')
        return
      }
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
          // Story 8.6：快照同时存净化后的 INBOX 正文，崩溃重放不必依赖结构化消息。
          inboxText: entry.inboxText,
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
        // AC2：写入失败只捕获放行，不抛给压缩事务（宿主也会兜住 observer 失败，但不依赖它）。
        warn('压缩快照写入失败（不阻塞压缩主路径）：' + errorText(error))
      }
    },

    recordTurnEnd(session, event) {
      warnNoPersistenceOnce()
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
      // Story 10.1：指针模式先 flush 指针行，再按 token 增量触发；turn 文本仍喂反思计分。
      if (pointerActive) {
        const turnEntry = entryFor('turn', session, String(turn))
        steps.reset(sessionId)
        background((async () => {
          if (options.flush) {
            try {
              await options.flush(session)
            } catch (error) {
              warn('turn/end 采集前的 session flush 失败（继续采集）：' + errorText(error))
            }
          }
          await tokenBoundary('turn', session, sessionId, String(turn), false)
          if (hasText(turnEntry.text)) {
            options.onTurnCaptured?.({ text: turnEntry.text, recordedAt: turnEntry.recordedAt })
          }
          lastTurn.set(sessionId, turn)
        })(), 'turn/end(pointer)')
        return
      }
      // P3：文本与 recorded_at 必须在 flush 之前取，flush 之后 deriveMessages 可能已被下一轮推进。
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
        // Story 7.2：落库成功后才喂给反思计分（失败的那一轮下次会重带，不能重复计分）。
        options.onTurnCaptured?.({ text: entry.text, recordedAt: entry.recordedAt })
        // P4：只有落库成功才推进「已采集的最大 turn」，失败的内容会被下一次采集重新带上。
        lastTurn.set(sessionId, turn)
      })(), 'turn/end')
    },

    resetSession(sessionId) {
      steps.reset(sessionId)
      lastTurn.delete(sessionId)
      buffered.delete(sessionId)
    },

    captureMode() {
      return {
        trigger: pointer?.tokenMeter != null ? 'tokens' : 'steps(degraded)',
        persistence: pointerActive ? 'available' : 'unavailable',
      }
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
            // 旧快照（净化前的版本）没有 inboxText：回落原文，重放不因缺字段失败。
            inboxText: record.inboxText ?? record.text,
            // 崩溃重放不再记净化账本（同一段已入队过，重复记账只增噪声）。
            purify: null,
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


/**
 * 三钩子采集器装配（Story 2.1 / AC①③、AC5）。
 *
 * 只读实例走不到这里（上游已 return），所以本单元必然是写者实例（AD-12）。
 * 快照目录与库同父（`<profile>/memory/capture/`）；文件是「事务未提交」的崩溃标记，
 * 启动时扫描孤儿快照重放回 INBOX。
 */
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { createCaptureRecorder, type CaptureRecorder, type TokenMeterLike } from '../capture/recorder.js'
import type { RuntimeConfig } from '../config.js'
import type { MemoryDatabase } from '../db/database.js'

export interface CaptureWiringOptions {
  /** Story 7.2：turn/end 落库成功后的回调（兴趣分与触发决策写账本）。 */
  readonly onTurnCaptured?: (input: { readonly text: string; readonly recordedAt: Date }) => void
  readonly ctx: Context
  readonly dbPath: string
  readonly getDb: () => MemoryDatabase | undefined
  readonly resolved: RuntimeConfig
}

/** 返回采集器（供 session/event 监听器共享），并在 apply 期间重放孤儿快照。 */
export async function wireCapture(options: CaptureWiringOptions): Promise<CaptureRecorder> {
  const { ctx, dbPath, getDb, resolved } = options
  // Story 10.1 / AD-36：两个宿主服务都是**可选**的（裸 ctx / 精简宿主没有）。
  // 用 ctx.get 探测而不是写进 inject：缺服务不该让插件不激活（NFR12）。
  const host = ctx as unknown as { get?: (name: string) => unknown }
  const persistence = host.get?.('sessionPersistence')
  const tokenMeter = (host.get?.('tokenMeter') ?? undefined) as TokenMeterLike | undefined
  const pointerAvailable = persistence !== undefined && persistence !== null
  const recorder = createCaptureRecorder({
    connection: () => getDb()?.connection ?? null,
    captureSteps: resolved.captureSteps,
    snapshotDir: join(dirname(dbPath), 'capture'),
    logger: ctx.logger,
    // Story 10.1：指针化 + token 触发。available=false 时 recorder 内部走旧 inline 路径。
    pointer: {
      available: pointerAvailable,
      tokenMeter: tokenMeter ?? null,
      thresholds: {
        captureTokens: resolved.captureTokens,
        captureMinTokens: resolved.captureMinTokens,
        captureMaxTokens: resolved.captureMaxTokens,
      },
    },
    // AC③：turn/end 采集前显式 await flush（宿主不在 turn 边界 flush；session.md:741）。
    // 裸 ctx（单测）没有 sessions 服务时缺省 no-op。
    flush: (session) => {
      const sessions = (ctx as unknown as {
        sessions?: { flush?: (value: unknown) => Promise<unknown> }
      }).sessions
      return typeof sessions?.flush === 'function'
        ? Promise.resolve(sessions.flush(session))
        : Promise.resolve()
    },
    // Story 7.2：把已落库的 turn 正文交给反思计分（AC:1406）。
    onTurnCaptured: options.onTurnCaptured,
    // Story 8.6 / T4：L1_INBOX 入队前净化非 user 段（L0 仍写原文）。
    purify: resolved.purify,
  })
  // AC5：启动扫描孤儿快照（有 .snap 文件 = 上一次进程在事务提交前崩溃）并重放入 INBOX。
  const replayedSnapshots = await recorder.replayOrphanSnapshots()
  if (replayedSnapshots > 0) {
    ctx.logger.info(`孤儿快照重放：${replayedSnapshots} 条已重放入 INBOX`)
  }
  return recorder
}


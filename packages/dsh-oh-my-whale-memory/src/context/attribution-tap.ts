/**
 * 归因采集器（Story 8.1 第 3 轮 / AC:1565-1569、INV-5、INV-7、INV-9）。
 *
 * 每次 `turn/end` 取一次宿主 `tokenMeter.measure(session)`，连同模块自建的
 * `seq → 来源` 索引交给纯函数 `attributeSurface`，把结果留成**进程内快照**给 `/memory status`。
 *
 * 三条边界：
 * 1. `tokenMeter` 是**可选服务**（不在 `inject` 里）：缺失时只 warn 一次，快照保持 null
 *    （status 渲染 `n/a`），不抛错、不影响采集/精炼等写侧功能；
 * 2. `measure()` 抛错只 warn，快照保持上一次成功值（不写脏值、不清空）——监听器不得把异常
 *    抛回宿主事件循环（AC:1541-1543 的 post-commit fire-and-forget 口径）；
 * 3. `seq → 来源` 只按**会话事件类型**推导，没有任何正文文本启发式（INV-9：模型在正文里
 *    自称「已折叠」不构成状态）。
 */
import type { AttributionSource, SeqSourceIndex, TokenMeasure } from './attribution.js'
import { captureAttribution, type AttributionSnapshot } from './status.js'

/** 宿主 `TokenMeter` 的最小形态：本模块只用 `measure()`（AD-26 的可选服务面）。 */
export interface TokenMeterLike {
  measure(session: unknown, requestHeader?: unknown): TokenMeasure
  /**
   * Story 8.5 / T2：注入预算需要窗口与压力（AC:1827 的 `contextWindow − pressureTokens`）。
   * 宿主契约 `contextPressure(session)` 同步返回最新记录的 `pressureTokens` / `contextWindow`
   * （`docs/subsystems/token-meter.md:58,114`）；两者都可能缺失（路由未声明容量）。
   */
  contextPressure?(session: unknown): {
    readonly pressureTokens?: number
    readonly contextWindow?: number
  }
}

export interface AttributionTapOptions {
  /** 探测可选服务；未装 token 计量（裸 ctx / 精简宿主）时返回 undefined。 */
  readonly getTokenMeter: () => TokenMeterLike | undefined
  readonly logger: { warn(message: string, ...rest: unknown[]): void }
  /** 注入时钟（快照的 `capturedAt`）；缺省用真实时钟。 */
  readonly now?: () => Date
}

export interface AttributionTap {
  /** 采集一次快照；任何失败都只 warn，不改已有快照，也绝不抛错。 */
  capture(session: unknown): void
  /** 最近一次成功快照（null = 本实例尚未采集）。 */
  snapshot(): AttributionSnapshot | null
}

/**
 * 事件类型 → 归因来源（AC:1563 的四类）。
 *
 * 键是宿主 `SessionEventType`（`dsh-session/lib/types/types.d.ts:450` 的 surface 事件表）：
 * 系统提示是 surface node 0 的 `system/message`，用户原话 `user/message`，工具结果
 * `tool/result`，助手正文与推理 `assistant/message`。不在表里的事件（`developer/message`、
 * `turn/*` 等边界标记）**不进索引** ⇒ 归因时按 `unknown` 计，不摊派。
 */
const SOURCE_BY_EVENT_TYPE: Readonly<Record<string, AttributionSource>> = {
  'system/message': 'system',
  'user/message': 'user',
  'tool/result': 'tool',
  'assistant/message': 'assistant',
}

/** 守卫式读 `session.snapshotEvents()`：非 Session / 无该方法 / 抛错一律返回 []。 */
function sessionEvents(session: unknown): readonly unknown[] {
  const read = (session as { readonly snapshotEvents?: unknown } | null | undefined)?.snapshotEvents
  if (typeof read !== 'function') return []
  try {
    const events = (read as () => unknown).call(session)
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * 从会话事件推导 `seq → 来源` 索引。
 *
 * 索引里只有四类来源的 seq：找不到的 seq（事件已被替换/裁剪、或事件类型不在表里）由
 * `attributeSurface` 计入 `unknown`。整个推导只看 `event.type` 与 `event.seq`，不看正文。
 */
export function seqSourceIndex(session: unknown): SeqSourceIndex {
  const index = new Map<number, AttributionSource>()
  for (const event of sessionEvents(session)) {
    const candidate = event as { readonly type?: unknown, readonly seq?: unknown } | null | undefined
    const seq = candidate?.seq
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    const type = candidate?.type
    if (typeof type !== 'string') continue
    const source = Object.hasOwn(SOURCE_BY_EVENT_TYPE, type) ? SOURCE_BY_EVENT_TYPE[type] : undefined
    if (source !== undefined) index.set(seq, source)
  }
  return index
}

export function createAttributionTap(options: AttributionTapOptions): AttributionTap {
  const now = options.now ?? (() => new Date())
  let snapshot: AttributionSnapshot | null = null
  let warnedMissing = false

  return {
    capture(session) {
      const meter = options.getTokenMeter()
      if (meter === undefined) {
        // 只 warn 一次：每个 turn 都喊一遍会把日志刷成噪音，而缺失是静态事实。
        if (!warnedMissing) {
          warnedMissing = true
          options.logger.warn('未获取 tokenMeter 服务，上下文归因账本降级为 n/a（不影响其它功能）')
        }
        return
      }
      try {
        const measure = meter.measure(session)
        snapshot = captureAttribution(measure, seqSourceIndex(session), now().toISOString())
      } catch (error) {
        // 失败保留上一次成功快照：宁可显示旧数值，也不显示伪造的新数值。
        options.logger.warn('上下文归因采集失败，本次不更新快照：' + String(error))
      }
    },
    snapshot: () => snapshot,
  }
}

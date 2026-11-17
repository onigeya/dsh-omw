/**
 * 压缩区间的「判据 → 执行副本」规划（Story 8.6 / T3、T6、AD-29/AD-30、INV-16）。
 *
 * 一个区间的处理分成两件互不污染的事：
 * 1. **判定**：档位（T1/T2/T3）与长度硬下界一律在**净化前原文**上算（AC:1886-1888）。
 *    填充行正是重复行的重要来源，若先净化再判档，一段本该 T2/T3 的内容会被净化「压」回
 *    T1 折叠，等于净化改变了压缩语义——这就是 INV-16 禁止的耦合；
 * 2. **执行**：T2/T3 委托 stock 摘要时送**净化后的副本**；T1 折叠的句柄正文必须是
 *    **净化前原文**（句柄还原物 = 原文，AC:1882-1884）。
 *
 * 本模块把这两件事放在一次调用里，让 provider 入口（`src/compaction.ts`）保持三行；
 * 同时它是纯函数、不 import 宿主 compaction 包（`dsh-compaction-basic` 的运行期依赖
 * `dsh-session` 在纯测试环境里不可解析，引擎入口无法在单测里 import）。
 */
import type { CompactionCriteria, RegionTierPlan } from './compaction-tier.js'
import { planRegionTier } from './compaction-tier.js'
import type { T1MessageLike } from './compaction-t1.js'
import { purifyMessages, type PurifyMessagesResult, type PurifyOptions } from './purify.js'

/** 执行期消息的最小形状（同时满足 T1 渲染与净化两边的结构要求）。 */
export interface ExecutionMessageLike {
  readonly role: string
  readonly content: string | readonly { readonly type: string; readonly text?: string }[]
  readonly source?: { readonly kind?: unknown } | null
}

/** 一次压缩区间的完整规划结果。 */
export interface SummarizeExecutionPlan<T> {
  /** 档位判定（用净化前原文算）。 */
  readonly planned: RegionTierPlan
  /** T1 折叠用：**净化前原文**（句柄正文，逐字还原）。 */
  readonly foldMessages: readonly T[]
  /** T2/T3 委托 stock 用：净化后的执行副本（INV-1：只改内存副本）。 */
  readonly stockMessages: readonly T[]
  /** 净化聚合结果（账本 T5 的输入）。 */
  readonly purify: PurifyMessagesResult<T>
}

/**
 * 规划一次压缩执行（纯函数）。
 *
 * 顺序刻意是「先净化出副本、再判定档位」：净化是 pass 不是第四个档位（AC:1864），
 * 判定读的始终是 `input.messages` 原文。
 */
export function planSummarizeExecution<T extends ExecutionMessageLike>(input: {
  readonly messages: readonly T[]
  readonly criteria: CompactionCriteria | null | undefined
  readonly purifyOptions?: Partial<PurifyOptions> | null
}): SummarizeExecutionPlan<T> {
  const purify = purifyMessages(
    input.messages as unknown as readonly ExecutionMessageLike[],
    input.purifyOptions ?? null,
  ) as PurifyMessagesResult<T>
  const planned = planRegionTier({
    messages: input.messages as unknown as readonly T1MessageLike[],
    criteria: input.criteria,
  })
  return { planned, foldMessages: input.messages, stockMessages: purify.messages, purify }
}

/**
 * 压缩引擎 provider（Story 8.3 / AC:1660、AC:1679、AC:1703、AC:1707、AC:1683、AD-27）。
 *
 * **这是子路径入口，不是 function 插件本体**：AC:1707 要求 provider 的 default export
 * 放在另一入口文件的子路径 export（`dsh-oh-my-whale-memory/compaction`），而功能插件本体
 * （`src/index.ts`）仍然只允许命名导出 `name` / `inject` / `Config` / `apply`（AD-2、PRD §14）。
 *
 * 设计（D-B′）：区间选择、`compaction/start`/`end` 配对、事务与失败处理全部留在 stock 的
 * `compactRegion`；我们只覆写 stock 文档声明为**唯一子类定制点**的 `summarize()`。
 * T1 的判定/渲染/编排在 `context/compaction-t1.ts`（纯函数，可全测）。
 *
 * 参数与返回类型用 `Parameters<>` 从基类推导（**不**显式 import `dsh-agent` / `dsh-session`）：
 * 这两个包会带来嵌套的 `dsh-llm` 副本，导致与本仓已 pin 的 `dsh-llm` 出现类型双身份。
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  getCompactionCriteria,
  registerCompactionPlan,
  type CompactionPlanRecord,
} from './context/compaction-plan-registry.js'
import { summarizeWithT1 } from './context/compaction-t1.js'
import { planSummarizeExecution } from './context/compaction-execution.js'
import { getHandleWriter, isCompactionReadonly } from './context/handle-writer.js'
import { getPurifyOptions } from './context/purify-runtime.js'
import { recordPurifyRun, PURIFY_LEDGER_KIND } from './context/purify-ledger.js'
import type { PurifyMessagesResult } from './context/purify.js'

type SummarizeArgs = Parameters<BasicCompactionEngine['summarize']>
type SummarizeResult = Awaited<ReturnType<BasicCompactionEngine['summarize']>>

/** T1 折叠结果的 provider/model 标记（进 `compaction/summary` 事件，可据此区分是否调过 LLM）。 */
export const T1_FOLD_PROVIDER = 'omw-t1-fold'
export const T1_FOLD_MODEL = 'handle'

/** 从 agent 上取会话 id（结构访问，不 import `Agent` 类型）。取不到 ⇒ ''（调用方 fail-open）。 */
function sessionIdOf(agent: unknown): string {
  const session = (agent as { readonly session?: { readonly id?: unknown } } | null)?.session
  const id = session?.id
  return typeof id === 'string' ? id : ''
}

/**
 * 我们的压缩引擎。
 *
 * 继承而不重写：`BasicCompactionEngine` 的阈值 / 保留尾部 / 溢出上限 / 失败处理与事务时序
 * 一律复用；本类只覆写 `summarize()`，把「T1 段怎么摘要」换成无损折叠。
 */
export class OmwCompactionEngine extends BasicCompactionEngine {
  /**
   * 摘要一段被压缩的会话区间（stock 的唯一公开子类定制点）。
   *
   * Story 8.4：先由**代码侧确定性判据**定档（`planRegionTier`，零 LLM），按档位路由：
   * - T1（受保护内容 / 长度不足 / 判据算不出 / 硬下界越界）⇒ 无损折叠（`summarizeWithT1`）；
   * - T2/T3 ⇒ 委托 stock 的 LLM 摘要（`super.summarize`），且**不二次派发** `compaction/start`（INV-10）。
   *
   * 档位与理由写进模块级注册表，由 `compaction/summary` 的入图侧落 `compaction_run`
   * （tier / plan_json / delegate）。只读实例 / writer 缺失 / 写失败都由 `summarizeWithT1`
   * 收敛为「委托 stock」，这里不再重复判一次（避免两份裁决漂移）。
   */
  protected override async summarize(...args: SummarizeArgs): Promise<SummarizeResult> {
    const input = args[0]
    const sessionId = sessionIdOf(args[1])
    // Story 8.6 / T3 / AC:1864：净化是 **pass 不是档位**。`planSummarizeExecution` 先产出
    // 执行副本，再用**净化前原文**定档（INV-16 / AC:1886-1888：填充不会把一段推过门槛）。
    const plan = planSummarizeExecution({
      messages: input.messages,
      criteria: getCompactionCriteria(),
      purifyOptions: getPurifyOptions(),
    })
    const planned = plan.planned
    const readonly = isCompactionReadonly()

    if (planned.tier === 'T1') {
      const outcome = await summarizeWithT1({
        // Story 8.6 / AC:1882-1884：T1 句柄存**净化前原文**（句柄还原物 = 原文，
        // 逐字还原率 100%）；净化只作用执行副本，而 T1 的执行副本就是句柄正文。
        messages: plan.foldMessages,
        sessionId,
        readonly,
        writeHandle: getHandleWriter(),
        // 长度三带已判 T1：不得再被 role 分类否掉（`< lengthMin` 的区间没有 user 原话也要折）。
        forceFold: true,
        fallback: async () => super.summarize(...args),
        logger: { warn: (message) => this.warn(message) },
      })
      this.recordPlan(sessionId, planned, outcome.route === 't1' ? 'omw-t1-fold' : 'stock')
      return outcome.result
    }

    // T2/T3：stock 摘要（LLM 只在这里出现；同步压缩路径本身零 LLM，NFR17 / AD-7）。
    // 执行副本是净化后的消息（INV-1：只改内存副本，不写回 surface、不动检查点）。
    this.recordPlan(sessionId, planned, 'stock')
    this.recordPurify(sessionId, plan.purify)
    return super.summarize({ ...input, messages: plan.stockMessages }, args[1], args[2])
  }

  /**
   * Story 8.6 / T5 / AC:1890-1892：一次净化一行账本（只在执行副本**真的被用到**时记，
   * 也就是 T2/T3 的 stock 摘要路径；T1 折叠不产生执行副本，省不下任何 token）。
   * 写入方未注册 / 缺表 / 只读 ⇒ `recordPurifyRun` 内部只 warn，绝不影响压缩结果。
   */
  private recordPurify(sessionId: string, execution: PurifyMessagesResult<unknown>): void {
    if (!execution.changed) return
    void recordPurifyRun(
      {
        sessionId,
        rangeStart: 0,
        rangeEnd: execution.sourceChars,
        ruleHits: execution.ruleHits,
        removedChars: execution.removedChars,
        removedTokens: execution.removedTokens,
      },
      { logger: { warn: (message) => this.warn(PURIFY_LEDGER_KIND + '：' + message) } },
    )
  }

  /** 档位落账（模块级注册表；空会话 id 不可归属，跳过）。 */
  private recordPlan(
    sessionId: string,
    planned: { readonly tier: CompactionPlanRecord['tier'], readonly reason: string, readonly tokens: number },
    delegate: CompactionPlanRecord['delegate'],
  ): void {
    if (sessionId === '') return
    registerCompactionPlan(sessionId, { tier: planned.tier, reason: planned.reason, tokens: planned.tokens, delegate })
  }

  /** 日志不可用（如单测的裸原型实例）不影响委托语义。 */
  private warn(message: string): void {
    try {
      this.ctx?.logger?.warn?.(message)
    } catch {
      // 日志通道异常不得改变压缩行为。
    }
  }
}

/** AC:1707：provider 的 default export 只出现在这个子路径入口里。 */
export default OmwCompactionEngine

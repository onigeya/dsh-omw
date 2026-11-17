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
import { summarizeWithT1 } from './context/compaction-t1.js'
import { getHandleWriter, isCompactionReadonly } from './context/handle-writer.js'

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
   * 只读实例 / 非 T1 / writer 缺失 / 写失败都由 `summarizeWithT1` 收敛为「委托 stock」，
   * 这里不再重复判一次（避免两份裁决漂移）。
   */
  protected override async summarize(...args: SummarizeArgs): Promise<SummarizeResult> {
    const outcome = await summarizeWithT1({
      messages: args[0].messages,
      sessionId: sessionIdOf(args[1]),
      readonly: isCompactionReadonly(),
      writeHandle: getHandleWriter(),
      fallback: async () => super.summarize(...args),
      logger: { warn: (message) => this.warn(message) },
    })
    return outcome.result
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

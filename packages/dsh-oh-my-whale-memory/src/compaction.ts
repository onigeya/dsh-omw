/**
 * 压缩引擎 provider（Story 8.3 / AC:1660、AC:1703、AC:1707、AD-27）。
 *
 * **这是子路径入口，不是 function 插件本体**：AC:1707 要求 provider 的 default export
 * 放在另一入口文件的子路径 export（`dsh-oh-my-whale-memory/compaction`），而功能插件本体
 * （`src/index.ts`）仍然只允许命名导出 `name` / `inject` / `Config` / `apply`（AD-2、PRD §14）。
 *
 * **本轮是骨架**：按 spec-8-3 §2 的 D-B′ 方案，`OmwCompactionEngine` 只**覆写公开方法**并在
 * 内部先算分档计划、再把真正的压缩委托给**继承来的** `super.compactRegion` ——
 * 这样事务时序、`compaction/start`+`end` 配对、失败处理全部留在 stock 手里。
 *
 * 参数与返回类型用 `Parameters<>` / `ReturnType<>` 从基类推导（**不**显式 import
 * `@deepseek-ai/dsh-agent` / `dsh-session`）：这两个包会带来嵌套的 `dsh-llm` 副本，
 * 导致与本仓已 pin 的 `dsh-llm` 出现「同一个类型两份身份」的编译错误。
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

type CompactRegionArgs = Parameters<BasicCompactionEngine['compactRegion']>
// 基类方法是 async ⇒ ReturnType 已是 Promise<CompactionResult>，不能再包一层 Promise。


/**
 * 我们的压缩引擎。
 *
 * 继承而不重写：`BasicCompactionEngine` 的阈值 / 保留尾部 / 溢出上限 / 失败处理与事务时序
 * 一律复用；本类只增加「压缩哪一段」的判定挂点（D-B′），并通过 `super.compactRegion`
 * 完成真正的持久化变更。
 */
export class OmwCompactionEngine extends BasicCompactionEngine {
  /**
   * 当前是否处于「只读委托」模式（Story 8.3 / AC:1683）。
   *
   * 由装配层在 `apply` 时按运行态设置；`true` 时所有覆写方法必须原样委托、零写入。
   * 缺省 `false`（写者实例）。
   */
  protected omwReadonlyDelegate = false

  /** 供装配层设置只读委托（`/memory status` 读同一个裁决，见 `context/compaction-delegate.ts`）。 */
  setReadonlyDelegate(readonly: boolean): void {
    this.omwReadonlyDelegate = readonly
  }

  /** 只读实例不参与任何分档判定，直接走 stock 行为（零折叠 / 零入图 / 零账本）。 */
  get readonlyDelegate(): boolean {
    return this.omwReadonlyDelegate
  }

  /**
   * 压缩一个闭区间（`compactRegion(start, end, agent, signal?)`）。
   *
   * 骨架阶段：判定挂点先留空、**直接委托**。这样即使分档逻辑还没接上，行为也与 stock 完全一致
   * （可安全装配）；下一轮把 `planCompaction` 接进来后，这里才可能选择「不压这一段」。
   */
  override compactRegion(...args: CompactRegionArgs): ReturnType<BasicCompactionEngine['compactRegion']> {
    // 只读委托：不做任何判定，原样交给 stock（AC:1683）。
    return super.compactRegion(...args)
  }
}

/** AC:1707：provider 的 default export 只出现在这个子路径入口里。 */
export default OmwCompactionEngine

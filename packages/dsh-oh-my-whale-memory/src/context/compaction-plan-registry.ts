/**
 * 压缩档位运行态注册表（Story 8.4 / T4、AD-26、AC:1775-1779）。
 *
 * **为什么是模块级**：档位在 provider 入口（`src/compaction.ts`，由宿主构造引擎）里决定，
 * 而落账在 function 插件 `apply` 装配的事件接线里（`compaction/summary` → `compaction_run`）。
 * 两个入口在同一进程共享同一份模块图，所以用这张按 `sessionId` 索引的小注册表把
 * 「这次压缩定成了哪一档 / 摘要实际走了哪条路」传给入图侧；**不新增表、不写库**。
 *
 * 与 `handle-writer.ts` 同一纪律：
 * - 只在内存里；只读实例也能写（不碰库，AD-12 不涉及）；
 * - `compaction/start` 时清一次（同一会话的新一轮压缩不得复用上一轮的档位），
 *   teardown 时整体复位（`resetCompactionPlans`）；
 * - 读不到 plan 时调用方必须写 NULL（矩阵行 6：不编造 tier）。
 */
import type { CompactionTier } from './compaction-plan.js'

/** 一次压缩的档位记录（进 `compaction_run.plan_json`）。 */
export interface CompactionPlanRecord {
  readonly tier: CompactionTier
  /** 判定理由（`decideTier` / 硬下界 / `planRegionTier` 给出的常量串）。 */
  readonly reason: string
  /** 区间 token 数（判定用的估算值）。 */
  readonly tokens: number
  /**
   * 摘要实际走的路径：
   * - `omw-t1-fold` = 无损折叠（零 LLM）；
   * - `stock` = stock 摘要（T2/T3，或 T1 折叠 fail-open 降级）。
   */
  readonly delegate: 'omw-t1-fold' | 'stock'
}

/** provider 侧判据（来自 Config 的两条长度阈值）。 */
export interface CompactionCriteriaSnapshot {
  readonly lengthMin: number
  readonly t3Threshold: number
}

let criteria: CompactionCriteriaSnapshot | null = null
const plans = new Map<string, CompactionPlanRecord>()

/** `apply` 注册运行期判据；`null` = 撤销（teardown / 测试清理）⇒ 引擎按「判据算不出」压 T1。 */
export function registerCompactionCriteria(next: CompactionCriteriaSnapshot | null): void {
  criteria = next === null ? null : { lengthMin: next.lengthMin, t3Threshold: next.t3Threshold }
}

/** provider 侧读取判据；没注册过 = `null`（fail-closed 到 T1，不猜默认值）。 */
export function getCompactionCriteria(): CompactionCriteriaSnapshot | null {
  return criteria
}

/** 记一次档位（按会话；同会话新一轮覆盖旧记录）。 */
export function registerCompactionPlan(sessionId: string, plan: CompactionPlanRecord): void {
  if (sessionId === '') return
  plans.set(sessionId, { ...plan })
}

/** 读当前会话的档位；没有 = `null`（调用方写 NULL，不编造）。 */
export function readCompactionPlan(sessionId: string): CompactionPlanRecord | null {
  if (sessionId === '') return null
  return plans.get(sessionId) ?? null
}

/** 清一个会话的档位（`compaction/start` 时调用）。 */
export function clearCompactionPlan(sessionId: string): void {
  plans.delete(sessionId)
}

/** 整体复位（teardown / 测试清理）。 */
export function resetCompactionPlans(): void {
  plans.clear()
  criteria = null
}

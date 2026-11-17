/**
 * 压缩引擎的运行态裁决（Story 8.3 / AC:1683、AD-12、AD-27）。
 *
 * AC:1683 的要求很具体：**只读的第二实例**上，M1 的 provider 行仍然在（安装期产物），
 * 因此引擎必须**检测 readOnly 并委托 stock 行为**（零折叠 / 零入图 / 零账本），并在
 * `/memory status` 里标 `readOnly-delegate`；**不得用「不装配」来实现委托**。
 *
 * 本模块把这条裁决抽成纯函数：装配点（不管最终是 A1 还是别的方案）只需调用它拿到模式，
 * 再按模式决定行为；status 也直接渲染这个模式。
 */

/** 引擎运行模式。 */
export type CompactionMode =
  /** 本插件接管：分区选段 + 分档执行。 */
  | 'own'
  /** 只读实例：委托 stock（零写入），但 provider 行仍在。 */
  | 'delegate-stock'
  /** 引擎没装上（覆盖缺口）：必须显式告警，不得静默退回 stock。 */
  | 'missing'

export interface CompactionModeInput {
  /** 当前实例是否是只读（第二实例 / 无写者锁）。 */
  readonly readonly: boolean
  /** 我们的引擎条目是否真的激活了（启动期探测结果）。 */
  readonly engineInstalled: boolean
}

/**
 * 裁决运行模式。
 *
 * 顺序有讲究：**先判"有没有装上"再判只读**。如果引擎压根没激活，哪怕实例是只读的，
 * 也要报 `missing`（NFR19 / AC:1675：覆盖缺口必须显式可见，不能被"只读所以委托"掩盖）。
 */
export function resolveCompactionMode(input: CompactionModeInput): CompactionMode {
  if (!input.engineInstalled) return 'missing'
  if (input.readonly) return 'delegate-stock'
  return 'own'
}

/** 该模式下是否允许写入（折叠 / 入图 / 账本）。 */
export function allowsCompactionWrites(mode: CompactionMode): boolean {
  return mode === 'own'
}

/** 该模式下是否必须告警（覆盖缺口）。 */
export function requiresOverlayWarning(mode: CompactionMode): boolean {
  return mode === 'missing'
}

/** status 行里显示的标签（`/memory status` 用）。 */
export function compactionModeLabel(mode: CompactionMode): string {
  if (mode === 'delegate-stock') return 'readOnly-delegate'
  return mode
}

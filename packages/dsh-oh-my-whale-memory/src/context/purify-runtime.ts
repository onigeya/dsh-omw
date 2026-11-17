/**
 * 净化选项的运行期注册表（Story 8.6 / T3、AC:1864）。
 *
 * **为什么是模块级**：压缩 provider（`src/compaction.ts`）由宿主构造，读不到 `apply` 里的
 * `Config`；而净化参数来自 Config 的四个 `.volatile()` 字段（INV-12：运行期可覆盖）。
 * 与 `compaction-plan-registry.ts` / `handle-writer.ts` 同一纪律：只在内存里、不写库、
 * 只读实例同样可写（不碰库，AD-12 不涉及），teardown 时复位。
 *
 * **未注册时回落到默认值**（R1 + R3 开、R2 关、minRemainder 24）：净化是 AC 的默认行为，
 * 不是需要显式开启的特性；这与「判据未注册 ⇒ fail-closed 到 T1」的方向不同，因为净化
 * 只影响执行副本、不改变档位（AD-29/AD-30）。
 */
import {
  DEFAULT_PURIFY_OPTIONS,
  normalizePurifyOptions,
  type PurifyOptions,
} from './purify.js'

let registered: PurifyOptions | null = null

/** `apply` 注册本次实例的净化选项；`null` = 撤销（teardown / 测试清理）⇒ 回落默认值。 */
export function registerPurifyOptions(next: Partial<PurifyOptions> | null): void {
  registered = next === null ? null : normalizePurifyOptions(next)
}

/** 读取当前净化选项（没注册过 ⇒ `DEFAULT_PURIFY_OPTIONS` 的副本，调用方不能改到它）。 */
export function getPurifyOptions(): PurifyOptions {
  return registered === null ? { ...DEFAULT_PURIFY_OPTIONS } : { ...registered }
}

/** 整体复位（teardown / 测试清理）。 */
export function resetPurifyOptions(): void {
  registered = null
}

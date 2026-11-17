/**
 * 压缩引擎 ↔ 插件运行态的桥（Story 8.3 第 5 轮 / T2、T3、INV-3、AD-12）。
 *
 * **为什么是模块级**：provider 入口（`src/compaction.ts`）里的引擎实例由**宿主**构造，
 * 它拿不到 function 插件 `apply` 里的库句柄；两个入口在同一进程共享同一份模块图，
 * 所以用这张小注册表把「写句柄」的能力从 `apply` 传给引擎。
 *
 * 两态：
 * - 写者实例：`apply` 注册真正的写句柄（全文入图），`readonly = false`；
 * - 只读实例：`apply` 清空写者并置 `readonly = true`，引擎据此直接委托 stock
 *   （零折叠 / 零入图 / 零账本，AD-12）——不靠「不装配」实现委托。
 *
 * 缺失/抛错一律由调用方 fail-open 委托 `super.summarize`（INV-3：宁可不折叠，不丢内容）。
 */

export interface HandleWriteInput {
  readonly sessionId: string
  readonly seq: number
  readonly text: string
  readonly tokens?: number
}

/** 写句柄的最小端口：返回句柄节点 id（实现见 `context/handles.ts` 的 `writeHandle`）。 */
export type HandleWriter = (input: HandleWriteInput) => Promise<{ readonly id: string }>

let writer: HandleWriter | null = null
let readonly = true

/** 写者实例在 `apply` 里注册；传 `null` 撤销（teardown / 测试清理）。 */
export function registerHandleWriter(next: HandleWriter | null): void {
  writer = next
}

/** provider 侧读取；没有注册过 = `null`（fail-open 到 stock）。 */
export function getHandleWriter(): HandleWriter | null {
  return writer
}

/** 只读实例在 `apply` 早期设置；缺省按 `true`（没被写者显式注册过就不写）。 */
export function setCompactionReadonly(value: boolean): void {
  readonly = value
}

export function isCompactionReadonly(): boolean {
  return readonly
}

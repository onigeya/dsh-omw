/**
 * 覆盖缺口检测（Story 8.3 / AC:1675、NFR19）。
 *
 * A1 装配的失败形态：宿主里仍解析到 **stock** 的压缩引擎，而不是我们的
 * `OmwCompactionEngine`。这时必须显式告警，不能静默退回 stock。
 *
 * 用构造器名而不是 `instanceof`：provider 在 `src/compaction.ts` 子路径入口，
 * 从功能插件 `index.ts` import 它会把两个入口的类身份拆开（且增加发布面耦合）。
 *
 * 三态：`own`（我们的）/ `foreign`（别人的 = 缺口）/ `absent`（宿主没装压缩服务，
 * 例如 web profile 把 stock 禁用了；不告警，避免误报）。
 */

export type CompactionOverlayGap = 'own' | 'foreign' | 'absent'

export interface CompactionHostLike {
  get?: (name: string) => unknown
}

export function detectCompactionOverlayGap(ctx: CompactionHostLike): CompactionOverlayGap {
  const engine = ctx.get?.('compaction')
  if (engine === undefined || engine === null) return 'absent'
  const name = (engine as { readonly constructor?: { readonly name?: string } }).constructor?.name
  return name === 'OmwCompactionEngine' ? 'own' : 'foreign'
}

/** 缺口文案（单独导出便于测试逐字断言；不含任何凭据/会话内容）。 */
export function compactionOverlayGapWarning(gap: CompactionOverlayGap): string | null {
  if (gap !== 'foreign') return null
  return '压缩引擎未被本插件接管（仍解析到 stock）：T1 无损折叠与分档不会生效；请检查 cordis.patch.yml 的 compaction-basic 覆盖是否被宿主接受'
}

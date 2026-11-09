/**
 * dsh-oh-my-whale-memory function 插件入口。
 *
 * 五件套命名导出形态由 PRD §14 / postmortem 0001 锁定：宿主 Loader 只识别
 * 命名导出 `name`/`inject`/`Config`/`apply`；default export 会让 Loader 丢弃
 * function 插件命名空间——本文件禁用 default export。
 *
 * Story 1.3：inject 加入 `'settings'`（AD-11），Config 填全字段（FR-18），
 * apply 做分级校验（硬校验抛错阻塞本插件 / 可降级项 warn）。
 *
 * 契约说明：apply 收到的 config 是宿主根据 Config schema resolve 出的 volatile
 * 节点对象——顶层每个字段都是 `.get()` 可调用的 volatile 节点。
 * resolveRuntimeConfig 用 Getter<T> 包装读取，兼容普通值与 volatile 节点两种形态
 * （便于纯单测直接传 plain object）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveRuntimeConfig } from './config.js'

export { Config, resolveRuntimeConfig } from './config.js'
export type { RuntimeConfig, ConfigShape } from './config.js'

/** cordis 模块名（AD-2，永不重命名）；与 settings namespace 一致。 */
export const name = 'dsh-oh-my-whale-memory' as const

/**
 * 本插件向宿主注入的能力清单。
 * `'settings'`：/settings 表单投影与后续 /memory status 的设置读取通道（AD-11）。
 */
export const inject = ['settings'] as const

/**
 * 插件激活函数。分级校验：硬校验失败抛错（仅阻塞本插件，宿主继续运行）；
 * 降级项（embedding token/model 缺失）走 ctx.logger.warn。
 * config 类型用结构化占位——Loader 在运行时按 Config schema resolve 后传入，
 * 这里保留宽松签名以避免与宿主解析器类型耦合。
 */
export async function apply(
  ctx: Context,
  config: Parameters<typeof resolveRuntimeConfig>[0],
): Promise<void> {
  const resolved = resolveRuntimeConfig(config)
  // warnings 只含字段名与降级说明——绝不携带凭据值（NFR9）。
  for (const message of resolved.warnings) {
    ctx.logger.warn(message)
  }
}

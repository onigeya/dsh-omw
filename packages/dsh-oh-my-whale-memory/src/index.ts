/**
 * dsh-oh-my-whale-memory function 插件骨架（Story 1.1）。
 *
 * 五件套命名导出形态由 PRD §14 / postmortem 0001 锁定：宿主 Loader 只识别
 * 命名导出 `name`/`inject`/`Config`/`apply`；default export 会让 Loader 丢弃
 * function 插件命名空间——本文件禁用 default export。
 *
 * Story 1.3 才会补全 `inject = ['settings']` 与 Config 字段；
 * 本 story 只锁形态：`inject` 暂为空数组，`Config` 暂为空 schema，`apply` 为空函数。
 */
import Schema from '@deepseek-ai/schemastery'

/** cordis 模块名（AD-2，永不重命名）；与 settings namespace 一致。 */
export const name = 'dsh-oh-my-whale-memory' as const

/**
 * 本插件向宿主注入的能力清单。
 * Story 1.1 暂为空；Story 1.3 起会加入 `'settings'`（AD-11）。
 */
export const inject = [] as const

/**
 * Config schema 占位。Story 1.3 填字段；
 * 凭据字段届时必须命名 `token` 且标 `.role('secret')`（AD-9）。
 */
export const Config = Schema.object({})

/** 插件激活函数。Story 1.1 不挂任何 hook；Story 1.4 起在此建库与注册采集钩子。 */
export async function apply(): Promise<void> {}

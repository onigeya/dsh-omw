/**
 * dsh-oh-my-whale preset 极简入口。
 *
 * preset 的激活路径是 `cordis.patch.yml` 安装期清单，而非 JS 转发（AD-1：
 * 宿主不 import memory；memory 也严禁 import preset）。本文件存在的唯一理由
 * 是给 tsdown 提供一个可构建的入口，产出 `lib/index.js` 与 `lib/types/index.d.ts`，
 * 让 bundle 包具备合法的 JS 入口形态（Code Map：spec-1-1 L55 / L66）。
 *
 * Story 1.2 会把 cordis 模块名 `dsh-oh-my-whale-memory` 写进 patch 清单；
 * 本 story 只锁定 bundle 包的安装期身份（AD-2），不实现任何运行时逻辑。
 */

/** bundle 入口包的发布名（AD-2，永不重命名）。 */
export const BUNDLE_NAME = 'dsh-oh-my-whale'

/** bundle 入口包的当前版本，与 package.json 保持一致。 */
export const BUNDLE_VERSION = '0.1.0'

/** 本 bundle 引用的 function 插件 cordis 模块名（Story 1.2 起由 patch 清单消费）。 */
export const MEMORY_PLUGIN_MODULE = 'dsh-oh-my-whale-memory'

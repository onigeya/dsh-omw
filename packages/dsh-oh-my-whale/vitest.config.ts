import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * bundle 入口包 vitest 配置。
 *
 * 与 memory 包同一摆放方案（方案 a，根统一）：根 `vitest.config.ts` 以
 * `test.projects` 发现已配置的 vitest 子包；没有本文件，
 * `packages/dsh-oh-my-whale/test/` 下的 `.test.ts` 不会被任何 project 收录，
 * 于是本包的安装期契约测试会静默不跑——用例数与文件数都变少，而且没有任何
 * 报错提示。本文件的存在就是让它们被收集。
 *
 * 本包测试是纯静态契约断言（读 package.json / cordis.patch.yml / src 文本），
 * 不连数据库，因此不需要 memory 包那样的 30s 超时。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

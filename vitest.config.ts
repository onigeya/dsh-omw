import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 根 vitest 配置（方案 a：根统一）。
 *
 * 以 `test.projects` 指向 memory 包配置；新增包时在这里追加一行即可。
 * `pnpm test` 等价于 `vitest run`，会按 projects 递归执行各包测试。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
})

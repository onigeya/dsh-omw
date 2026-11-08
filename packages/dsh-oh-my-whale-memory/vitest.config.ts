import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * memory 包 vitest 配置。
 *
 * 摆放选择（spec Design Notes "vitest 放哪"）：采用方案 (a) 根统一——
 * vitest 装在根 `devDependencies`，根 `package.json#scripts.test = "vitest run"`，
 * 根 `vitest.config.ts` 以 `test.projects` 指向本包，本包只声明自己的
 * include 范围与测试环境；`pnpm -r test` 也能通过本包 `scripts.test` 触发同一配置。
 *
 * 与宿主仓库惯例一致：单一 vitest 入口，避免每包重复安装 vitest。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

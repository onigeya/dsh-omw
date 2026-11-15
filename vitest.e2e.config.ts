/**
 * E2E 专用配置：只收 `e2e/**\/*.e2e.ts`，串行执行（一套独立 profile + 一个 web 进程），
 * 超时按「建 profile → 装插件 → 起宿主」的真实耗时放宽。
 * 单元测试仍由根 `vitest run` 负责，互不干扰。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
})

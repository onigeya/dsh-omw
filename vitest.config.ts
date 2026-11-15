import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 根 vitest 配置（方案 a：根统一）。
 *
 * 以 `test.projects` 指向各包配置；新增包时在这里追加一行即可。
 * `pnpm test` 等价于 `vitest run`，会按 projects 递归执行各包测试。
 *
 * 覆盖率（Story 5.2 / AC:1227-1229）：`pnpm test:coverage` = `vitest run --coverage`，
 * 只统计两包的 `src/**`（测试与脚本不计），产出 json-summary 供
 * `scripts/coverage-gate.mjs` 做**逐文件** ratchet 判定。coverage 刻意不塞进
 * `pnpm verify`（那会把本地门禁从 ~16s 拉到 ~40s），由 CI 与 `pnpm test:coverage` 承担。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.d.ts', 'packages/*/lib/**'],
      reporter: ['json-summary', 'text-summary'],
      reportsDirectory: 'coverage',
      all: true,
    },
  },
})

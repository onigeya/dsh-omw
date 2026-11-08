# dsh-oh-my-whale-memory

DSH 记忆插件 function 插件（Story 1.1 脚手架）。五件套命名导出骨架：
`name` / `inject` / `Config` / `apply`；禁 default export（PRD §14）。

## 构建与测试

- `pnpm -r build`：产出 `lib/index.js`（ESM）+ `lib/types/index.d.ts`。
- `pnpm test`（根执行）：根 vitest 以 `test.projects` 指向本包 `vitest.config.ts`，
  运行 `test/abi-smoke.test.ts`（Windows ABI 冒烟五步）。

### vitest 摆放（方案 a，根统一）

- `vitest` 装在根 `devDependencies`；根 `scripts.test = "vitest run"`。
- 根 `vitest.config.ts` 用 `test.projects` 引用本包 `vitest.config.ts`。
- 本包 `scripts.test` 也保留 `vitest run --root ../..`，便于 `pnpm -r test` 复用同一入口。
- 理由：与宿主 deepseek-harness 惯例一致（单一 vitest 入口），避免每包重复安装 vitest。

## 存储底座（Story 1.4 落地）

- LadybugDB `~0.22.x`（当前 0.22.3）；`vector` 扩展 HNSW cosine 磁盘索引 + `fts` 扩展 Okapi BM25。
- HNSW 实测通过参数：mu=30, ml=60, pu=0.05, efc=200；BM25：K=1.2, B=0.75。
  锁定源：`test/abi-smoke.test.ts` 顶部注释（含实测日期 2026-11-08）。

## 安装期注意

- `pnpm-workspace.yaml#allowBuilds` 除 spec 锁定的 `@ladybugdb/core: true` 外，还需要
  `esbuild: true`——`vitest@3` → `vite@7` → `esbuild` 链路会让 pnpm 报
  `ERR_PNPM_IGNORED_BUILDS` 阻断 install。`nodeLinker: hoisted` / `autoInstallPeers: false`
  两个 spec 锁定项未动。

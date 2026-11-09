# dsh-oh-my-whale-memory

DSH 记忆插件 function 插件（cordis 模块名 `dsh-oh-my-whale-memory`，AD-2）。
五件套命名导出：`name` / `inject` / `Config` / `apply`（+ `resolveRuntimeConfig`）；
禁 default export（PRD §14 / postmortem 0001）。

## 构建与测试

- `pnpm -r build`：产出 `lib/index.js`（ESM）+ `lib/types/index.d.ts`。
- `pnpm test`（根执行）：根 vitest 以 `test.projects` 指向本包 `vitest.config.ts`，
  运行 `abi-smoke`、`config-schema`、`entry-exports` 三组测试。

### vitest 摆放（方案 a，根统一）

- `vitest` 装在根 `devDependencies`；根 `scripts.test = "vitest run"`。
- 根 `vitest.config.ts` 用 `test.projects` 引用本包 `vitest.config.ts`。
- 本包 `scripts.test` 保留 `vitest run --root ../..`，便于 `pnpm -r test` 复用同一入口。
- 理由：与宿主 deepseek-harness 惯例一致（单一 vitest 入口），避免每包重复安装 vitest。

## Config（Story 1.3 / FR-18）

Config 定义在 `src/config.ts`（`@deepseek-ai/schemastery`）。
**每个进 /settings 表单的字段都标 `.volatile()`**（AD-11：宿主 `volatileForm()` 只递归 volatile 节点）；
**凭据字段命名为 `token` 且标 `.role('secret')`**（AD-9：宿主 `redact.ts` 按 `node.meta.role === 'secret'`
判定脱敏，字段名不参与判定）。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `embedding.endpoint` | string | — | Embedding 服务地址，填了就必须是 http(s) URL |
| `embedding.token` | string（secret） | — | 凭据；缺失即降级为 disabled |
| `embedding.model` | string | — | 模型名；缺失即降级为 disabled |
| `rerank.endpoint` | string | — | **v2 预留**：v1 不消费、不校验 |
| `rerank.token` | string（secret） | — | **v2 预留** |
| `rerank.model` | string | — | **v2 预留** |
| `captureSteps` | number | 50 | 采集步数 N，硬校验 ≥ 1 |
| `inboxRefineConcurrency` | number | 4 | INBOX 精炼并发上限，硬校验 ≥ 1 |
| `injectOnNewSession` | boolean | true | 是否开启新会话注入 |
| `rrfK` | number | 60 | RRF 融合参数 k，硬校验 > 0 |
| `retrievalTopK` | number | 50 | 两路检索 top-k；v1 仅透传，无硬校验（消费在 1.7 检索落地） |
| `layerWeights.l2` | number | 0.7 | L2 层权重，硬校验 ∈ (0, 1] |
| `layerWeights.l1` | number | 0.4 | L1 层权重，硬校验 ∈ (0, 1] |
| `llmProvider` | string | — | 可选；LLM 显式 provider（AD-5） |
| `llmModel` | string | — | 可选；LLM 显式 model（AD-5） |
| `systemOne.enabled` | boolean | true | System One 判定开关 |

嵌套对象（`embedding` / `rerank` / `layerWeights` / `systemOne`）**整体**标 `.volatile()`，子字段保持 plain——
schemastery 的 `validateVolatileSchema` 硬约束禁止 volatile 嵌套 volatile，违反即启动抛
`volatile fields require a fixed object path without an enclosing volatile field`。

### 分级校验（`resolveRuntimeConfig`）

**硬校验失败 → apply 抛错，仅阻塞本插件，宿主继续运行**；错误消息含字段名 + 期望格式 + 当前值：

- `embedding.endpoint` 非 http(s) URL
- `captureSteps` < 1、`inboxRefineConcurrency` < 1
- `rrfK` ≤ 0
- `layerWeights.l2` / `layerWeights.l1` 不在 (0, 1]

**可降级（不抛错，`ctx.logger.warn` + `embeddingMode: 'disabled'`）**——FR-18：

- `embedding.token` 缺失 → 降级为关键词单路检索
- `embedding.model` 缺失 → 同上

凭据值绝不进入日志 / 错误消息 / warnings（NFR9）：降级警告只含字段名。

## 存储底座（Story 1.4 落地）

- LadybugDB `~0.22.x`（当前 0.22.3）；`vector` 扩展 HNSW cosine 磁盘索引 + `fts` 扩展 Okapi BM25。
- HNSW 实测通过参数：mu=30, ml=60, pu=0.05, efc=200；BM25：K=1.2, B=0.75。
  锁定源：`test/abi-smoke.test.ts` 顶部注释（含实测日期 2026-11-08）。

## 安装期注意

- `pnpm-workspace.yaml#allowBuilds` 除 spec 锁定的 `@ladybugdb/core: true` 外，还需要
  `esbuild: true`——`vitest@3` → `vite@7` → `esbuild` 链路会让 pnpm 报
  `ERR_PNPM_IGNORED_BUILDS` 阻断 install。`nodeLinker: hoisted` / `autoInstallPeers: false`
  两个 spec 锁定项未动。

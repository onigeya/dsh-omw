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
| `embedding.dim` | number | — | 建库 pin 的向量维度（整数 1..65536，越界或非整数即硬校验抛错）；留空按已知模型表（baai/bge-m3 = 1024，大小写不敏感）或默认 1024 |
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

代码在 `src/db/`：`paths.ts`（库路径）、`id.ts`（指纹 id）、`schema.ts`（DDL 与参数）、
`errors.ts`（`MemoryDbError`）、`embedding-profile.ts`（维度解析）、`database.ts`（建库/打开）、
`memory.ts`（写入与合并）。

- **库路径**：`<profile>/memory/lbug.db`。唯一来源是宿主注入的 `profileContext.dir`
  （= `$DSH_HOME/profiles/<name>`），不自行拼 `DSH_HOME`；目录不存在则 `mkdir -p`。
  没有 `profileContext` 时**跳过建库**并 warn，不猜路径。
- **表结构**：`memory` 节点表 13 列——`id`/`layer`/`kind`/`priority`/`text`/
  `embedding FLOAT[DIM]`/`valid_at`/`recorded_at`/`invalid_at`/`expired_at`/
  `source_refs STRING[]`/`embedding_model_id`/`embedding_dim`；`l0_raw`（append-only）
  `id`/`raw_text`/`recorded_at`/`actor`；库级元数据表 `omw_meta` 记
  `schema_version`/`embedding_dim`/`embedding_model_id`/`created_at`。
- **索引建库即建**：`memory_embedding_hnsw`（HNSW cosine）与 `memory_text_fts`（Okapi BM25），
  不做暴力扫描。`CREATE_VECTOR_INDEX`/`CREATE_FTS_INDEX` 不幂等（重复调用抛
  `Binder exception: Index ... already exists`），启动时先 `CALL show_indexes()` 判断、缺才建。
  HNSW 参数：mu=30, ml=60, pu=0.05, efc=200；BM25 查询期 K=1.2, B=0.75；
  锁定源：`test/abi-smoke.test.ts` 顶部注释（含实测日期 2026-11-08）。
- **维度 pin 与 fail-loud（AD-14）**：`FLOAT[DIM]` 的维度在建库时固化为 `numElements`，
  来源是 `embedding.dim` > 已知模型表（键是完整 id `baai/bge-m3` = 1024，查找大小写不敏感）> 默认 1024。
  之后启动时从 `table_info('memory')` 读实际维度与 `omw_meta.embedding_dim` 比对；不符即抛
  `MemoryDbError(code='embedding_dim_mismatch')` 阻塞启动，提示全量重嵌入或迁移新库——
  不静默降级、不自动重建、不修改库文件。只有**维度变化**才 fail-loud；同维度换模型
  （例如把库换到另一个同为 1024 维的模型）不报错，但需你自行对该库做全量重嵌入，
  因为 `embedding_model_id` 只作记录、不会替你重算向量。
- **指纹 id（AD-4）**：`uuid5(layer + ':' + 归一化 text)`，归一化 = NFKC + 小写 + 去标点
  （`\p{P}`）+ 空白折叠。指纹含 layer、不含 `source_refs` 与时间戳；同一 `(layer, 归一化 text)`
  重复写入 `MERGE ... ON MATCH` 合并 `source_refs`（`list_distinct(list_concat(...))`）、
  保留最早 `recorded_at`、不改 `text`。归一化后为空抛 `empty_fingerprint_text`。
- **扩展是每进程装载**：索引持久化在库里，但 `QUERY_VECTOR_INDEX`/`QUERY_FTS_INDEX` 前必须先
  `INSTALL vector; LOAD vector; INSTALL fts; LOAD fts;`。Windows 上依赖 OpenSSL 3
  （见 `test/openssl.ts` 的 `injectOpenSslPath()`）。
- **句柄生命周期**：`openMemoryDatabase` 在模块级 Map 中按绝对路径复用句柄；
  `close()`（facade.close）只回收门面对象、**不释放底层 OS 文件句柄**——Windows 上
  同进程 close 后立即重开同一库会拿不到文件锁（"Could not set lock ... Error: 33"），
  因此库文件在进程存活期间只在进程内复用、只能靠**跨进程**重开才拿到文件锁；
  同路径不同 dim 直接抛 `embedding_dim_mismatch`。

## 安装期注意

- `pnpm-workspace.yaml#allowBuilds` 除 spec 锁定的 `@ladybugdb/core: true` 外，还需要
  `esbuild: true`——`vitest@3` → `vite@7` → `esbuild` 链路会让 pnpm 报
  `ERR_PNPM_IGNORED_BUILDS` 阻断 install。`nodeLinker: hoisted` / `autoInstallPeers: false`
  两个 spec 锁定项未动。

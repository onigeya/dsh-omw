# dsh-oh-my-whale-memory

DSH 记忆插件的 function 插件（cordis 模块名 `dsh-oh-my-whale-memory`，AD-2）。
命名导出：`name` / `inject` / `Config` / `apply`，另有 `resolveRuntimeConfig`。
不允许 default export（PRD §14 / postmortem 0001）：Loader 遇到它会把 function 插件的命名空间丢掉。

## 构建与测试

- `pnpm -r build`：产出 `lib/index.js`（ESM）+ `lib/types/index.d.ts`。
- `pnpm test`（根执行）：根 vitest 以 `test.projects` 指向本包 `vitest.config.ts`，
  运行 `test/**/*.test.ts` 全部测试（abi-smoke / config-schema / db-* / entry-exports /
  tool-memory-remember 等）。

### vitest 安装位置（方案 a：根统一）

- `vitest` 装在根 `devDependencies`，根 `scripts.test = "vitest run"`。
- 根 `vitest.config.ts` 用 `test.projects` 引用本包 `vitest.config.ts`。
- 本包 `scripts.test` 保留 `vitest run --root ../..`，让 `pnpm -r test` 复用同一入口。
- 这样做的原因：与宿主 deepseek-harness 的单一 vitest 入口一致，不必每包装一份。

### Windows 前置条件：OpenSSL 3 必须在 PATH 里

LadybugDB 的 `vector`/`fts` 扩展动态链接 `libssl-3-x64.dll` 和 `libcrypto-3-x64.dll`。
`pnpm` 不随 `@ladybugdb/core` 分发这两个 DLL，代码也不探测固定目录，所以只能由 PATH 环境变量提供。
缺了它，`INSTALL vector` 报 `Failed to load library: ... libvector.lbug_extension`。
Git for Windows 的 `C:\Program Files\Git\mingw64\bin` 带这两个 DLL，任何 OpenSSL 3 安装的 `bin` 也行。

- PowerShell / 直接启动 DSH 时（会话级）：`$env:Path = 'C:\Program Files\Git\mingw64\bin;' + $env:Path`，再 `pnpm test`
- 永久生效（用户级；「系统属性 → 环境变量」GUI 亦可）：
  `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';C:\Program Files\Git\mingw64\bin', 'User')`
- 本仓库的 MSYS bash **不把 `/c/...` 形式转成 Windows 形式**，所以要写 Windows 形式：
  `export PATH='C:\Program Files\Git\mingw64\bin;'"$PATH"`，再 `pnpm test`

DSH 宿主进程也必须继承这个 PATH——插件运行期 `INSTALL/LOAD vector|fts` 同样依赖它。

## Config（Story 1.3 / FR-18）

Config 定义在 `src/config.ts`（`@deepseek-ai/schemastery`）。

- 要进 `/settings` 表单的字段必须标 `.volatile()`。宿主 `volatileForm()` 只递归 volatile 节点（AD-11）。
- 凭据字段命名为 `token`，同时标 `.role('secret')`。宿主 `redact.ts` 只看
  `node.meta.role === 'secret'`，不看字段名（AD-9）；漏标 role 就等于把凭据明文广播。

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
| `retrievalTopK` | number | 50 | 两路检索 top-k；v1 仅透传，无硬校验（消费在 Epic 2 检索落地） |
| `layerWeights.l2` | number | 0.7 | L2 层权重，硬校验 ∈ (0, 1] |
| `layerWeights.l1` | number | 0.4 | L1 层权重，硬校验 ∈ (0, 1] |
| `llmProvider` | string | — | 可选；LLM 显式 provider（AD-5） |
| `llmModel` | string | — | 可选；LLM 显式 model（AD-5） |
| `systemOne.enabled` | boolean | true | System One 判定开关 |

### 推荐服务配置（Q-5，2026-11-14 关闭，AD-14）

`embedding.endpoint` 填 OpenAI 兼容的 base URL。客户端在它后面拼 `/embeddings`，所以**地址必须带 `/v1`**。
下面三份配置可以直接复制：

```yaml
# 主选：硅基流动（bge-m3 免费；1024 维 / 8192 输入 token）
embedding:
  endpoint: https://api.siliconflow.com/v1
  token: <SILICONFLOW_API_KEY>
  model: BAAI/bge-m3
  dim: 1024

# 本地备选：Ollama（先 `ollama pull bge-m3`；8K context）
embedding:
  endpoint: http://localhost:11434/v1
  token: ollama            # 本地默认不校验鉴权，占位即可
  model: bge-m3
  dim: 1024

# 付费备选：OpenAI（1536 维；换模型必须重建库，AD-14）
embedding:
  endpoint: https://api.openai.com/v1
  token: <OPENAI_API_KEY>
  model: text-embedding-3-small
  dim: 1536
```

- `dim` 必须与建库时 pin 的维度一致；不一致会 **fail-loud 拒绝启动**并提示全量重嵌入（AD-14）。
- `rerank.*` 仍是 **v2 预留**（v1 不消费）；v1.1 启用时形状为硅基流动 `https://api.siliconflow.com/v1` + `BAAI/bge-reranker-v2-m3`，`documents` 必须是 `string[]`（对象数组报 20015）。
- 经验上中文语料的 token 数约为字符数的 1–1.5 倍（以 `ctx.tokenMeter.measure()` 实测为准）；预算一律实测，不做字符换算。

嵌套对象（`embedding` / `rerank` / `layerWeights` / `systemOne`）整体标 `.volatile()`，子字段保持 plain。
schemastery 的 `validateVolatileSchema` 不允许 volatile 嵌套 volatile，违反时启动直接抛
`volatile fields require a fixed object path without an enclosing volatile field`。

### 分级校验（`resolveRuntimeConfig`）

硬校验失败会让 `apply` 抛错。只有本插件加载失败，宿主继续运行。错误消息带字段名、期望格式和当前值：

- `embedding.endpoint` 非 http(s) URL
- `captureSteps` < 1、`inboxRefineConcurrency` < 1
- `rrfK` ≤ 0
- `layerWeights.l2` / `layerWeights.l1` 不在 (0, 1]

下面这些缺失不抛错，只记 `ctx.logger.warn` 并把 `embeddingMode` 设为 `'disabled'`（FR-18）：

- `embedding.token` 缺失，降级为关键词单路检索
- `embedding.model` 缺失，同上

凭据值不进入日志、错误消息或 warnings（NFR9）；降级警告只带字段名。

## 存储底座（Story 1.4 落地）

代码在 `src/db/`：`paths.ts`（库路径）、`id.ts`（指纹 id）、`schema.ts`（DDL 与参数）、
`errors.ts`（`MemoryDbError`）、`embedding-profile.ts`（维度解析）、`database.ts`（建库/打开）、
`memory.ts`（写入与合并）。

- 库路径是 `<profile>/memory/lbug.db`。它只来自宿主注入的 `profileContext.dir`
  （即 `$DSH_HOME/profiles/<name>`），代码不自己拼 `DSH_HOME`。目录不存在就 `mkdir -p`。
  没有 `profileContext` 时跳过建库并 warn，不猜路径。
- 表结构共 6 张。`memory` 节点表 13 列：`id`/`layer`/`kind`/`priority`/`text`/
  `embedding FLOAT[DIM]`/`valid_at`/`recorded_at`/`invalid_at`/`expired_at`/
  `source_refs STRING[]`/`embedding_model_id`/`embedding_dim`。`l0_raw` 是 append-only，
  4 列 `id`/`raw_text`/`recorded_at`/`actor`。审计两表 `generation_log`（15 列）与
  `keyed_decision`（10 列，Story 1.10）。库级元数据表 `omw_meta` 记
  `schema_version`/`embedding_dim`/`embedding_model_id`/`created_at`。第 6 张是 INBOX
  队列表 `l1_inbox`（Story 2.2），见下条。
- INBOX 队列表 `l1_inbox`（Story 2.2）有 11 列：`id`/`session_id`/`kind`/`payload`/
  `status`/`attempts INT64`/`lease_owner`/`lease_until`/`enqueued_at`/`updated_at`/
  `last_error`，`PRIMARY KEY (id)`。状态机是 `pending → processing(lease) → done | failed`。
  取队头时在同一个事务里写 `status='processing'`、`lease_owner`（进程 id）和 `lease_until`
  （= now + 60s，AD-6）。FIFO 顺序按 `(enqueued_at ASC, id ASC)`。失败时 `attempts` 累加，
  第 4 次失败（`attempts > 3`）进 `failed` 死信并记 `last_error`。写者启动时把全部
  `processing` 回收为 `pending`（AD-12 单写者，启动时任何 `processing` 行必属已死进程）。
  建表和回收都只在写者实例执行：建表在 `src/db/database.ts` 的唯一迁移点、紧跟审计表之后。
  只读实例不建表、不回收、不启动消费者（AD-12）。消费只在 turn 窗口之外进行（AD-6）。
- 索引在建库时创建：`memory_embedding_hnsw`（HNSW cosine）和 `memory_text_fts`（Okapi BM25），
  不做暴力扫描。`CREATE_VECTOR_INDEX`/`CREATE_FTS_INDEX` 不幂等，重复调用抛
  `Binder exception: Index ... already exists`；启动时先 `CALL show_indexes()` 判断，缺了才建。
  HNSW 参数 mu=30、ml=60、pu=0.05、efc=200；BM25 查询期 K=1.2、B=0.75。
  参数出处：`test/abi-smoke.test.ts` 顶部注释（实测日期 2026-11-08）。
- 维度 pin 与 fail-loud（AD-14）：`FLOAT[DIM]` 的维度在建库时固化为 `numElements`。
  取值顺序是 `embedding.dim` > 已知模型表（键为完整 id `baai/bge-m3` = 1024，大小写不敏感）
  > 默认 1024。启动时从 `table_info('memory')` 读实际维度，与 `omw_meta.embedding_dim` 比对。
  不符即抛 `MemoryDbError(code='embedding_dim_mismatch')` 阻塞启动，提示全量重嵌入或迁移新库：
  不静默降级、不自动重建、不改库文件。只有维度变化才 fail-loud；同维度换模型（比如换到
  另一个 1024 维模型）不报错，但需要你自己对该库做全量重嵌入，因为 `embedding_model_id`
  只作记录，不会替你重算向量。
- 指纹 id（AD-4）是 `uuid5(layer + ':' + 归一化 text)`。归一化 = NFKC + 小写 + 去标点
  （`\p{P}`）+ 空白折叠。指纹含 layer，不含 `source_refs` 与时间戳。同一 `(layer, 归一化 text)`
  重复写入时走 `MERGE ... ON MATCH`：合并 `source_refs`（`list_distinct(list_concat(...))`）、
  保留最早 `recorded_at`、不改 `text`。归一化后为空抛 `empty_fingerprint_text`。
- 扩展按进程装载：索引存在库里，但 `QUERY_VECTOR_INDEX`/`QUERY_FTS_INDEX` 之前必须先跑
  `INSTALL vector; LOAD vector; INSTALL fts; LOAD fts;`。Windows 上这两个扩展依赖 OpenSSL 3
  （`libssl-3-x64.dll` / `libcrypto-3-x64.dll`），要由 PATH 提供，见上文 Windows 前置条件。
- 句柄生命周期：`openMemoryDatabase` 在模块级 Map 里按绝对路径复用句柄。`close()`
  （facade.close）只回收门面对象，不释放底层 OS 文件句柄。Windows 上同进程 close 后立刻
  重开同一库拿不到文件锁，报 `Could not set lock ... Error: 33`。所以库文件在进程存活期间
  只在进程内复用，要拿文件锁只能跨进程重开。同一路径不同 dim 直接抛 `embedding_dim_mismatch`。

## 模型工具 `memory_remember`（Story 1.6 / FR-1）

apply 阶段经 `ctx.tools.register` 注册模型可见工具（`inject` 因此含 `'tools'`），
定义在 `src/tools/memory-remember.ts`（`defineTool`，`@deepseek-ai/dsh-tools`）。

- 签名是 `memory_remember(content: string, context?: string, kind?: string, priority?: number)`。
  `content` 必填。`context` 可选（来源消息或卡片 id）：缺省时 `source_refs = []`，提供时
  `source_refs = [context]`。`kind` 与 `priority` 是 Story 1.11 新增的分类入参（FR-15，七类：
  persona|episodic|instruction|work_fact|work_task|work_method|work_artifact；priority 取
  -1..100，-1 表示全局强规则、恒置顶），直接透传到写路径；缺省时 kind 为空串、priority 为 0。
- 写入形态：固定 `layer = 'L1'`，复用 `src/db/memory.ts` 的指纹与 MERGE 逻辑，不复制第二份
  id/归一化实现。同一 `(layer, 归一化 text)` 重复写入命中同一 id：`source_refs` 并集去重、
  `recorded_at` 保留最早、`text` 不被改写。kind 与 priority 不进指纹，以最新一次写入为准
  （Story 1.11 AC4：同文本换分类仍是同一条记忆）。
- 写入不产 embedding（Epic 2 补齐）：`embedding` / `embedding_model_id` / `embedding_dim`
  三列保持 `NULL`。不写零向量冒充向量。维度校验只在显式带向量时生效，所以本工具不受库 pin
  的 dim 影响。向量化与 INBOX 精炼属于 Epic 2。
- 返回值只有两种形态（`output.schema` 用 `oneOf` 钉死）：
  `{ action: 'stored', id }` 或 `{ action: 'failed', error: { code, message, retryable } }`。
  execute 不会 throw，因为宿主把 throw 渲染成 isError。空文本或归一化后为空 →
  `empty_fingerprint_text`；无 profile 归属或库句柄缺失 → `db_unavailable`；
  `MemoryDbError` 透传其 code；其余驱动异常兜底 `db_write_failed`。`retryable` 恒为 `false`，
  写入失败是语义错误，重试不会变好。error.message 只带诊断信息，不带凭据。
- 库未就绪不影响插件加载：工具在 `apply` 里先于建库注册，经闭包 getter 取库句柄。
  此时调用得到 `db_unavailable`，而不是让插件启动失败。
- 描述护栏（FR-1）：工具 description 要求只记长期事实，并显式排除 ephemeral / transient
  content（当前任务进度、一次性中间结果、闲聊等）。

## /memory 命令（Story 1.7 / 1.8 / 1.9）

代码分两处：`src/command.ts` 是纯工厂加解析，不碰 ctx 和库；`src/index.ts` 在 `apply` 里接线。

- `/memory remember [--kind=<分类>] [--priority=<整数>] <内容>` 把一条文本写入 L1
  （`layer = 'L1'`；Story 1.11 层收敛后 `L1_INBOX` 只是 INBOX 队列标识，不再是 memory 表的
  layer 取值）。解析从 `trimStart` 开始，首个 token 必须是 `remember`，之后先解析可选的前导
  旗标 `--kind=` 与 `--priority=`（顺序任意、可缺省），到首个非旗标 token 为止，整体 `trim`
  后就是正文。旗标值非法（如 `--priority=abc`）或没有正文时返回 usage 错误
  `{ kind: 'error', text }`，正文见 `MEMORY_REMEMBER_USAGE`。
- `/memory list [关键词]` 按 `recorded_at` 倒序列出记忆，每行 `- <id> [<layer>] <摘要>`。
  摘要把空白折叠为单空格，超过 60 字符截断并加 `…`，默认上限 20 条
  （`MEMORY_LIST_DEFAULT_LIMIT`）。带关键词时按字面包含匹配 `text`（两侧小写、大小写不敏感，
  不做语义检索），仍然倒序并受上限约束。默认只列有效记忆（`invalid_at` 与 `expired_at`
  都为空），`layer` 不做白名单。
- `/memory show <id>` 按 AC 的字段顺序逐行输出完整字段（layer / kind / priority / text /
  valid_at / recorded_at / invalid_at / expired_at / source_refs / embedding_model_id）。
  NULL 与空值渲染成 `(空)`，空数组渲染成 `[]`，不回显 embedding 向量。这里有意非对称：
  已失效的墓碑记忆不出现在 `list` 里，但 `show <id>` 仍会返回并展示 `invalid_at` /
  `expired_at`。id 不存在时返回 `{ kind: 'error', text: '未找到 id 为 … 的记忆。' }`。
- `/memory status` 只读打印记忆库基础状态，全部本地完成，不调 LLM、不发网络请求。
  正文逐行固定，顺序就是代码顺序，与 `src/command.ts` 的 `renderMemoryStatus` 一一对应：
  首行 `记忆状态`，随后 `L1: <n>` / `L2: <n>` / `L1_INBOX: <n>` / `L2_INBOX: <n>`；
  `failed: <n>`（Story 2.2 起是 `l1_inbox` 表 `status = 'failed'` 的真实计数，不再恒为 0）；
  `audit_gap: <n> | 未知（审计表缺失）`；
  `embedding: enabled | enabled（未嵌入 <n> 条）| disabled（降级检索）`（非降级也显式打印，
  有未嵌入节点时带条数，Story 2.4 起）；
  `systemOne: enabled | disabled-by-config | degraded`（Story 2.5 起恒打印，后两者带
  `（已降级回 ctx.llm）`，非降级也显式打印，免得把字段缺失读成健康）；
  `readonly: false | true, reason: '<原因>'`（只读实例标注 `another instance owns the writer lock`）。
  `L1_INBOX` 与 `L2_INBOX` 的口径不同，这是有意的。`L1_INBOX` 仍是 `memory` 表 `layer` 列的
  历史计数位（Story 1.11 收敛后写路径只写 `L1`，只有存量行会命中）。`L2_INBOX` 自 Story 2.5
  起是 `l2_inbox` 队列表的深度（`pending + processing`），不再是 `memory` 层的计数，
  两条消费链因此各报各的真实积压。
  下面四行只在条件满足时追加，条件不满足时输出逐字不变，位置都在 `readonly` 行之后：
  `evidence_gap: <n>（EII <n> / 漂移 <n>）`（Story 2.6，`total > 0` 时；边表缺失渲染
  `evidence_gap: 未知（边表缺失）`）、`related_skipped: <n>`（`> 0` 时；审计表缺失渲染
  `related_skipped: 未知（审计表缺失）`）、`l2_failed: <n>` 与 `uncertain: <n>`（Story 2.5，
  各自 `> 0` 时；`uncertain` 算不出来时渲染 `uncertain: 未知（审计表缺失）`）。
  `l2_failed > 0` 时先追加 `l2_failed 最近条目:`，随后才是 `failed 最近条目:`。两条明细块
  上限都是 5 条，按 `updated_at` 倒序，进入死信超过 24h 的标 `stale`。每条形如
  `- <id> kind=<kind> attempts=<n>[ stale] updated_at=<ISO> error=<单行摘要>`。
  `status` 带多余参数时返回 usage 错误且不查库。库未就绪时明确报错，不静默返回 0。
  队列表缺失照抛可见错误，不静默报 `failed: 0`。只读实例打开旧库时 `l2_inbox` 可能不存在，
  此时整条 `status` 会明确报错（有意不静默，见 Known Limitations）。
- 无子命令或未知子命令（如 `/memory foo`）返回 usage 错误，正文见 `MEMORY_COMMAND_USAGE`，
  其中给出 remember / list / show / status 四条用法。
- NULL 三列：Epic 1 还没有 embedding 客户端，节点的 `embedding` / `embedding_model_id` /
  `embedding_dim` 三列同落 NULL。不写零向量，零向量会污染 HNSW，留待 Story 2.3 回填。
  这条无向量路径与工具直写共用。维度校验因此只在显式带向量时生效，非空且长度与库 pin 不符
  仍 fail-loud 抛 `embedding_dim_mismatch`。
- 命令不会抛错：handler 内 `try/catch` 把所有异常（含写库失败，如归一化后为空
  `empty_fingerprint_text`）收敛成 `{ kind: 'error', text }`，命令失败不打断会话。
- 无条件注册：命令在 `apply` 开头、profileContext 早退之前注册
  （`ctx.effect(..., 'omw-memory-command')`），所以没有 profile 归属时命令也存在，只是写库
  会抛「记忆库未就绪」的明确错误。未注入 `commands` 时注册降级为 no-op；`inject` 因此为
  `['commands', 'settings', 'tools']`。
- 同一 `(layer, 归一化 text)` 重复 remember 由指纹 id 合并，节点数不变（AD-4）。

## 安装期注意

- `pnpm-workspace.yaml#allowBuilds` 除了 spec 锁定的 `@ladybugdb/core: true`，还要 `esbuild: true`。
  否则 `vitest@3` → `vite@7` → `esbuild` 这条链会让 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，
  install 直接中断。`nodeLinker: hoisted` 与 `autoInstallPeers: false` 两项按 spec 保留未动。
- `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-scope` 放在 devDependencies，是因为 `dsh-tools`
  的 `lib/` 在模块加载期就 import 这两个包和若干 peer。本仓关了 `autoInstallPeers`、用
  `nodeLinker: hoisted`，不会自动补装传递 peer，测试链路必须自己声明。它们只用于测试，
  不属于发布契约：插件运行期只 import `dsh-tools` 本身，由宿主的 profile 依赖解析提供。
- 钉 `dsh-tools@0.2.2-rc.1` 而不跟宿主自带的 `0.2.1-rc.3`，原因是 0.2.1-rc.3 的 `lib`
  在加载期还会 import `@deepseek-ai/dsh-sandbox` 等本工作区解析不到的 peer，直接 import
  就报 `Cannot find package '@deepseek-ai/dsh-sandbox'`（已实测）。0.2.2-rc.1 没有这个引用，
  peer 面与工作区 cordis ~4.1.0 一致。宿主实际加载哪个版本由 `engines.dsh` 与 profile 解析
  决定，插件不重复锁定。

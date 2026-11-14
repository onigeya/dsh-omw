# dsh-oh-my-whale-memory

DSH 记忆插件 function 插件（cordis 模块名 `dsh-oh-my-whale-memory`，AD-2）。
五件套命名导出：`name` / `inject` / `Config` / `apply`（+ `resolveRuntimeConfig`）；
禁 default export（PRD §14 / postmortem 0001）。

## 构建与测试

- `pnpm -r build`：产出 `lib/index.js`（ESM）+ `lib/types/index.d.ts`。
- `pnpm test`（根执行）：根 vitest 以 `test.projects` 指向本包 `vitest.config.ts`，
  运行 `test/**/*.test.ts` 全部测试（abi-smoke / config-schema / db-* / entry-exports /
  tool-memory-remember 等）。

### vitest 摆放（方案 a，根统一）

- `vitest` 装在根 `devDependencies`；根 `scripts.test = "vitest run"`。
- 根 `vitest.config.ts` 用 `test.projects` 引用本包 `vitest.config.ts`。
- 本包 `scripts.test` 保留 `vitest run --root ../..`，便于 `pnpm -r test` 复用同一入口。
- 理由：与宿主 deepseek-harness 惯例一致（单一 vitest 入口），避免每包重复安装 vitest。

### Windows 前置条件：OpenSSL 3 必须在 PATH 里

LadybugDB 的 `vector`/`fts` 扩展动态链接 `libssl-3-x64.dll` / `libcrypto-3-x64.dll`，
`pnpm` 不随 `@ladybugdb/core` 分发这两个 DLL；代码不做目录探测，**必须由 PATH 环境变量提供**
（否则 `INSTALL vector` 报 `Failed to load library: ... libvector.lbug_extension`）。
Git for Windows 的 `C:\Program Files\Git\mingw64\bin` 就带这两个 DLL，任何 OpenSSL 3 安装的 `bin` 亦可。

- PowerShell / 直接启动 DSH 时（会话级）：`$env:Path = 'C:\Program Files\Git\mingw64\bin;' + $env:Path`，再 `pnpm test`
- 永久生效（用户级；「系统属性 → 环境变量」GUI 亦可）：
  `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';C:\Program Files\Git\mingw64\bin', 'User')`
- 本仓库的 MSYS bash **不把 `/c/...` 形式转成 Windows 形式**，所以要写 Windows 形式：
  `export PATH='C:\Program Files\Git\mingw64\bin;'"$PATH"`，再 `pnpm test`

DSH 宿主进程也必须继承这个 PATH——插件运行期 `INSTALL/LOAD vector|fts` 同样依赖它。

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
| `retrievalTopK` | number | 50 | 两路检索 top-k；v1 仅透传，无硬校验（消费在 Epic 2 检索落地） |
| `layerWeights.l2` | number | 0.7 | L2 层权重，硬校验 ∈ (0, 1] |
| `layerWeights.l1` | number | 0.4 | L1 层权重，硬校验 ∈ (0, 1] |
| `llmProvider` | string | — | 可选；LLM 显式 provider（AD-5） |
| `llmModel` | string | — | 可选；LLM 显式 model（AD-5） |
| `systemOne.enabled` | boolean | true | System One 判定开关 |

### 推荐服务配置（Q-5，2026-11-14 关闭，AD-14）

`embedding.endpoint` 填 OpenAI 兼容 base URL（客户端在其后拼 `/embeddings`，**必须带 `/v1`**）。三种可直接复制：

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
- **表结构**（共 6 张）：`memory` 节点表 13 列——`id`/`layer`/`kind`/`priority`/`text`/
  `embedding FLOAT[DIM]`/`valid_at`/`recorded_at`/`invalid_at`/`expired_at`/
  `source_refs STRING[]`/`embedding_model_id`/`embedding_dim`；`l0_raw`（append-only）
  `id`/`raw_text`/`recorded_at`/`actor`；审计两表 `generation_log`（15 列）与
  `keyed_decision`（10 列，Story 1.10）；库级元数据表 `omw_meta` 记
  `schema_version`/`embedding_dim`/`embedding_model_id`/`created_at`；
  INBOX 队列表 `l1_inbox`（第 6 张，Story 2.2）见下条。
- **INBOX 队列表 `l1_inbox`（Story 2.2）**：11 列——`id`/`session_id`/`kind`/`payload`/
  `status`/`attempts INT64`/`lease_owner`/`lease_until`/`enqueued_at`/`updated_at`/
  `last_error`，`PRIMARY KEY (id)`。状态机 `pending → processing(lease) → done | failed`：
  取队头在**同一事务**内写 `status='processing'` + `lease_owner`（进程 id）+ `lease_until`
  （= now + **60s**，AD-6）；FIFO 顺序 = `(enqueued_at ASC, id ASC)`；失败 `attempts` 累加，
  第 4 次失败（`attempts > 3`）进 `failed` 死信并记 `last_error`；写者启动时把**全部**
  `processing` 回收为 `pending`（AD-12 单写者 ⇒ 启动时任何 `processing` 行必属已死进程）。
  建表与回收都只在写者实例：建表在 `src/db/database.ts` 的唯一迁移点、紧跟审计表之后；
  只读实例不建、不回收、不启动消费者（AD-12）。消费只在 turn 窗口之外进行（AD-6）。
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
  （`libssl-3-x64.dll` / `libcrypto-3-x64.dll`），必须由环境变量 PATH 提供，见下节。
- **句柄生命周期**：`openMemoryDatabase` 在模块级 Map 中按绝对路径复用句柄；
  `close()`（facade.close）只回收门面对象、**不释放底层 OS 文件句柄**——Windows 上
  同进程 close 后立即重开同一库会拿不到文件锁（"Could not set lock ... Error: 33"），
  因此库文件在进程存活期间只在进程内复用、只能靠**跨进程**重开才拿到文件锁；
  同路径不同 dim 直接抛 `embedding_dim_mismatch`。

## 模型工具 `memory_remember`（Story 1.6 / FR-1）

apply 阶段经 `ctx.tools.register` 注册模型可见工具（`inject` 因此含 `'tools'`），
定义在 `src/tools/memory-remember.ts`（`defineTool`，`@deepseek-ai/dsh-tools`）。

- **签名**：`memory_remember(content: string, context?: string, kind?: string, priority?: number)`。
  `content` 必填，`context` 可选（来源消息/卡片 id），缺省时 `source_refs = []`；提供时
  `source_refs = [context]`。`kind` / `priority` 为 Story 1.11 新增的分类入参（FR-15：七类
  persona|episodic|instruction|work_fact|work_task|work_method|work_artifact；priority 取
  -1..100，-1 = 全局强规则/恒置顶），透传到写路径；缺省时 kind 为空串、priority 为 0。
- **写入形态**：固定 `layer = 'L1'`，走 `src/db/memory.ts` 的同一套指纹与 MERGE 逻辑
  （不复制第二份 id/归一化实现）。同 `(layer, 归一化 text)` 重复写入命中同一 id：
  `source_refs` 并集去重、`recorded_at` 保留最早、`text` 不被改写；kind / priority 不进指纹，
  **以最新一次写入为准**（Story 1.11 AC4——同文本换分类仍是同一条记忆）。
- **写入不产 embedding（Epic 2 补齐）**：`embedding` / `embedding_model_id` / `embedding_dim`
  三列保持 `NULL`——绝不写零向量冒充向量；维度校验只在显式带向量时生效，因此本工具
  不受库 pin 的 dim 影响。向量化与 INBOX 精炼是 Epic 2 的范围。
- **返回值只可能是两个 canonical 形态**（`output.schema` 用 `oneOf` 钉死）：
  `{ action: 'stored', id }` 或 `{ action: 'failed', error: { code, message, retryable } }`。
  **execute 绝不 throw**（宿主把 throw 渲染成 isError）：空文本 / 归一化后为空 →
  `empty_fingerprint_text`；无 profile 归属或库句柄缺失 → `db_unavailable`；
  `MemoryDbError` 透传其 code；其余驱动异常兜底 `db_write_failed`。`retryable` 恒 `false`
  （写入失败是语义错误，重试不会变好）。error.message 只含诊断信息，绝不携带凭据。
- **库未就绪不影响插件加载**：工具在 `apply` 里**先于建库**注册，经闭包 getter 取库句柄；
  此时调用得到 `db_unavailable`，而不是让插件启动失败。
- **描述护栏（FR-1）**：工具 description 明确要求只记长期事实、并显式排除
  ephemeral / transient content（当前任务进度、一次性中间结果、闲聊等）。

## /memory 命令（Story 1.7 / 1.8 / 1.9）

代码在 `src/command.ts`（纯工厂 + 解析，不碰 ctx / 库）与 `src/index.ts`（`apply` 中接线）。

- `/memory remember [--kind=<分类>] [--priority=<整数>] <内容>`：把一条文本写入 L1
  （`layer = 'L1'`，Story 1.11 层收敛——`L1_INBOX` 从此只是 INBOX 队列标识，不是
  memory 表的 layer 取值）。参数解析先 `trimStart`，首 token 必须是 `remember`，其余先
  解析可选前导分类旗标 `--kind=` / `--priority=`（可任意顺序、可缺省），到首个非旗标
  token 为止的整体 `trim` 后即正文；旗标值非法（如 `--priority=abc`）或无正文返回 usage
  错误的 `{ kind: 'error', text }`（正文见 `MEMORY_REMEMBER_USAGE`）。
- `/memory list [关键词]`：按 `recorded_at` 倒序列出记忆，每行 `- <id> [<layer>] <摘要>`
  （摘要把空白折叠为单空格、超 60 字符截断加 `…`），默认上限 20 条
  （`MEMORY_LIST_DEFAULT_LIMIT`）。带关键词时按**字面包含**匹配 `text`（两侧小写化、
  大小写不敏感；不做语义检索），仍倒序 + 上限。默认只列「有效」记忆
  （`invalid_at` 与 `expired_at` 均为空），`layer` 不做白名单。
- `/memory show <id>`：按 AC 字段顺序逐行输出该记忆的完整字段（layer / kind / priority /
  text / valid_at / recorded_at / invalid_at / expired_at / source_refs /
  embedding_model_id），NULL 与空值渲染 `(空)`、空数组渲染 `[]`，不回显 embedding 向量。
  **有意非对称**：已失效（墓碑）记忆不在 `list` 里出现，但 `show <id>` 仍返回并展示
  `invalid_at` / `expired_at`。id 不存在时返回 `{ kind: 'error', text: '未找到 id 为 … 的记忆。' }`。
- `/memory status`：只读打印记忆库基础状态，全部本地（不调 LLM、不发网络请求）。
  正文逐行钉死（顺序即代码顺序，与 `src/command.ts` 的 `renderMemoryStatus` 一一对应）：
  首行 `记忆状态`，随后 `L1: <n>` / `L2: <n>` / `L1_INBOX: <n>` / `L2_INBOX: <n>`、
  `failed: <n>`（Story 2.2 起是 `l1_inbox` 表 `status = 'failed'` 的**真实计数**，不再恒 0）、
  `audit_gap: <n> | 未知（审计表缺失）`、
  `embedding: enabled | enabled（未嵌入 <n> 条）| disabled（降级检索）`（非降级也显式打印；
  有未嵌入节点时带条数——Story 2.4 起）、
  `systemOne: enabled | disabled-by-config | degraded`（Story 2.5 起**恒打印**；后两者带
  `（已降级回 ctx.llm）`，非降级也显式打印，避免把字段缺失误读成健康）、
  `readonly: false | true, reason: '<原因>'`（只读实例标注 `another instance owns the writer lock`）。
  **口径差异（有意）**：`L1_INBOX` 与 `L2_INBOX` 含义不同。`L1_INBOX` 仍是 `memory` 表
  `layer` 列的历史计数位（Story 1.11 收敛后写路径只写 `L1`，仅存量行会命中）；
  `L2_INBOX` 自 Story 2.5 起是 `l2_inbox` **队列表的深度**（`pending + processing`），
  不再是 `memory` 层的计数——两条消费链因此各报各的真实积压。
  以下四行**仅按需追加**（条件不满足时输出逐字不变，且都排在 `readonly` 行之后）：
  `evidence_gap: <n>（EII <n> / 漂移 <n>）`（Story 2.6，`total > 0` 时；边表缺失渲染
  `evidence_gap: 未知（边表缺失）`）、`related_skipped: <n>`（`> 0` 时；审计表缺失渲染
  `related_skipped: 未知（审计表缺失）`）、`l2_failed: <n>` 与 `uncertain: <n>`（Story 2.5，
  各自 `> 0` 时；`uncertain` 算不出来时渲染 `uncertain: 未知（审计表缺失）`）。
  `l2_failed > 0` 时先追加 `l2_failed 最近条目:`（Story 2.5），随后才是 `failed 最近条目:`（两条明细块
  上限都是 **5** 条，均 `updated_at` 倒序、进入死信起超过 **24h** 的标 `stale`）；
  每条形如 `- <id> kind=<kind> attempts=<n>[ stale] updated_at=<ISO> error=<单行摘要>`。
  `status` 带多余参数 → usage 错误且不查库；库未就绪 → 明确报错，绝不静默返回 0；
  **队列表缺失照抛**（可见错误，不静默报 `failed: 0`）；只读实例开旧库时 `l2_inbox` 可能
  不存在，此时整条 `status` 会明确报错（有意不静默，见 Known Limitations）。
- 无子命令 / 未知子命令（如 `/memory foo`）→ usage 错误，正文见 `MEMORY_COMMAND_USAGE`
  （同时给出 remember / list / show / status 四条用法）。
- **NULL 三列**：Epic 1 尚无 embedding 客户端，节点 `embedding` / `embedding_model_id` /
  `embedding_dim` 三列同落 NULL（不写零向量——零向量会污染 HNSW，留待 Story 2.3 回填）。
  与工具直写共用同一条无向量路径；维度校验因此只在显式带向量时生效，非空且长度与库 pin
  不符仍 fail-loud 抛 `embedding_dim_mismatch`。
- **永不抛错**：handler 内 `try/catch` 把所有异常（含写库失败，如归一化后为空
  `empty_fingerprint_text`）收敛为 `{ kind: 'error', text }`——命令失败不打断会话。
- **无条件注册**：命令在 `apply` 开头、profileContext 早退**之前**注册
  （`ctx.effect(..., 'omw-memory-command')`），因此没有 profile 归属时命令也存在，
  只是写库抛「记忆库未就绪」的明确错误。未注入 `commands` 时注册降级为 no-op；
  `inject` 因此为 `['commands', 'settings', 'tools']`。
- 同一 `(layer, 归一化 text)` 重复 remember 由指纹 id 合并，节点数不变（AD-4）。

## 安装期注意

- `pnpm-workspace.yaml#allowBuilds` 除 spec 锁定的 `@ladybugdb/core: true` 外，还需要
  `esbuild: true`——`vitest@3` → `vite@7` → `esbuild` 链路会让 pnpm 报
  `ERR_PNPM_IGNORED_BUILDS` 阻断 install。`nodeLinker: hoisted` / `autoInstallPeers: false`
  两个 spec 锁定项未动。
- **为什么 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-scope` 是 devDependencies**：
  `dsh-tools` 的 `lib/` 在模块加载期 import 这两个包（以及若干 peer），而本仓
  `autoInstallPeers: false` + `nodeLinker: hoisted` 不会自动补装传递 peer，所以测试链路
  必须显式声明它们；它们是**仅测试用**的，不是发布契约——插件运行期只 import
  `dsh-tools` 本身，由宿主的 profile 依赖解析提供。
- **为什么钉 `dsh-tools@0.2.2-rc.1` 而不是宿主自带的 `0.2.1-rc.3`**：0.2.1-rc.3 的 `lib`
  在模块加载期还会 import `@deepseek-ai/dsh-sandbox` 等本工作区解析不到的 peer，
  直接 import 即以 `Cannot find package '@deepseek-ai/dsh-sandbox'` 失败（已实测）；
  0.2.2-rc.1 无此引用且 peer 面与工作区 cordis ~4.1.0 一致。宿主侧实际加载哪个版本
  由 `engines.dsh` 与 profile 解析决定，插件不重复锁定。

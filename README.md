# dsh-oh-my-whale

一句话定位：**给 DeepSeek Harness 装一条会自己长记性的记忆管线** —— Zettelkasten 原子记忆 + LLM Wiki 关系网 + SCD-2 双时态图存储，采集、精炼、召回、治理全在本地库里完成。

> 中文 | [English](README.en.md)

## 它是什么

`dsh-oh-my-whale` 把一个记忆插件装进 DSH 宿主，三层结构：

| 层 | 内容 | 谁写 |
|---|---|---|
| **L0** | 原始流水（对话片段、观测原文），只追加、永不改写 | 采集钩子：`step/end`（每步结算）、`compaction/start`（压缩窗口）、`turn/end`（轮次结束） |
| **L1** | 原子事实（一条偏好、一个决策、一条约束） | LLM 精炼 INBOX 队列 / `memory_remember` / `/memory remember` |
| **L2** | 综合陈述（跨多条 L1 的归纳） | L1→L2 提升（质量门 + 忠实性判定） |

- **Zettelkasten 原子记忆**：一条事实一个节点，节点 id 由内容指纹决定（同内容重复写入不产生重复节点）。
- **LLM Wiki**：节点之间用类型化边连成图 —— `EVIDENCE`（下层证据 → 上层结论）与 `RELATED`（同层语义关联）。
- **SCD-2 双时态**：每条记忆同时带「事实何时成立」（`valid_at` / `invalid_at`）与「何时被记录」（`recorded_at`），删除是软删除（`expired_at`），历史可回溯。

## 安装

### 已发布到 npm 之后

```bash
dsh plugin --profile <name> add dsh-oh-my-whale
```

`dsh-oh-my-whale` 是宿主的 **bundle 包**，它通过 `cordis.patch.yml` 把真正的插件 `dsh-oh-my-whale-memory` 注册进 profile。安装完用下面的命令确认配置层落地（不启动宿主）：

```bash
dsh --profile <name> --dump-config
```

### 本地 tarball（当前仓库未发布时）

```bash
pnpm -r build
pnpm --dir packages/dsh-oh-my-whale-memory pack --pack-destination ./packs
pnpm --dir packages/dsh-oh-my-whale pack --pack-destination ./packs
```

然后在目标 profile 的 `pnpm-workspace.yaml` 里把 memory 依赖指到本地 tarball（bundle 里的 `workspace:*` 打包后会变成 registry 上不存在的版本号）：

```yaml
overrides:
  dsh-oh-my-whale-memory: "file:<绝对路径>/dsh-oh-my-whale-memory-0.1.0.tgz"
allowBuilds:
  "@ladybugdb/core": true
```

再执行 `dsh plugin --profile <name> add <绝对路径>/dsh-oh-my-whale-0.1.0.tgz`。仓库自带 `node scripts/publish-smoke.mjs` 会把这条路径跑一遍并留日志。

## 配置

配置走宿主的 settings 命名空间 **`dsh-oh-my-whale-memory`**（`/settings` 里可视化，或用 profile 的 patch 层写）。凭据字段一律叫 `token`，在下述表格里用占位符表示，请填自己的值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `embedding.endpoint` | — | 嵌入服务地址（OpenAI 兼容 `/embeddings`） |
| `embedding.token` | — | 嵌入服务凭据；与 `model` 任一缺失即**降级为关键词单路** |
| `embedding.model` | — | 嵌入模型名；换模型必须同步维度，否则启动 fail-loud |
| `embedding.dim` | — | 向量维度，建库时 pin 在库里，之后不可改（需迁移或重建库） |
| `rerank.endpoint` / `rerank.token` / `rerank.model` | — | 精排配置（v1 预留：schema 已落，运行时**不消费**） |
| `captureSteps` | `50` | 每收集多少步对话就切一个 L0 快照 |
| `inboxRefineConcurrency` | `4` | 精炼队列的并发消费者数 |
| `injectOnNewSession` | `true` | 新会话开局是否自动注入记忆摘要 |
| `rrfK` | `60` | 混合检索 RRF 融合的 k 值 |
| `retrievalTopK` | `50` | 每路检索的候选条数 |
| `layerWeights.l2` / `layerWeights.l1` | `0.7` / `0.4` | 层权重（L2 结论优先于 L1 证据） |
| `priorityWeight` | `0.5` | 优先级二次加权系数（`priority: -1` 为全局强规则，恒置顶） |
| `llmProvider` / `llmModel` | — | 精炼与判定的模型通道（`ctx.llm`，插件不自带 key） |
| `systemOne.enabled` / `.endpoint` / `.model` / `.token` | `true` | 忠实性判定通道；不可用时整体降级回 `ctx.llm` |

示例（占位符不是真实凭据）：

```yaml
embedding:
  endpoint: https://api.example.com/v1
  token: sk-****
  model: bge-m3
  dim: 1024
```

## 斜杠命令

单一真源是 PRD §11.2，共 9 条；下表逐条列出并标注当前实现状态。命令名是 `memory`（小写、无前导斜杠），在会话里写作 `/memory <子命令>`。

| 命令 | 作用 | 状态 |
|---|---|---|
| `/memory status` | 记忆库健康视图：层计数、两路 INBOX 深度、死信、`audit_gap`、`evidence_gap`、`evidence_degraded`、embedding / System One 降级、只读原因、积压时长与最近精炼时刻、存储后端 | 已实现 |
| `/memory recall <query>` | 混合检索（语义向量 + 关键词，RRF 融合排序） | 已实现 |
| `/memory related <id> [depth]` | 沿证据链与语义关系网遍历邻居（1–3 跳，最多 20 条） | 已实现 |
| `/memory show <id>` | 看一条记忆的全部字段（含已失效墓碑） | 已实现 |
| `/memory list [query]` | 列最近的记忆（字面包含匹配，默认 20 条） | 已实现 |
| `/memory remember [--kind=..] [--priority=..] <内容>` | 手动写一条 L1 记忆 | 已实现 |
| `/memory forget <id> [--redact]` | 软删除一条记忆并级联作废其上层；`--redact` 额外把证据链上的 L0 原文替换为墓碑并标 `evidence_degraded` | 已实现 |
| `/memory resolve <id>` | 处理 `await-confirmation` 待裁决冲突（接受新值 / 保留并存） | 计划中（未实现，属 Epic 7） |
| `/memory strategy` | 列策略候选区与采纳门结果 | 计划中（未实现，属 Epic 7） |

## 模型工具

单一真源是 PRD §11.1，共 6 个；Agent 可调用。

| 工具 | 作用 | 状态 |
|---|---|---|
| `memory_remember` | 写一条值得长期记住的 L1 事实（同内容幂等，不产生重复节点） | 已实现 |
| `memory_recall` | 按语义 + 关键词混合召回，返回带层/分类/优先级的条目 | 已实现 |
| `memory_related` | 从一条记忆出发按图遍历相邻记忆 | 已实现 |
| `memory_forget` | 返回 `confirmation_required` 与待删摘要（库不可用/只读/查不到时返回 canonical `failed` 信封）；**Agent 侧没有执行通道**，确认必须由用户的 `/memory forget` 完成 | 已实现 |
| `memory_status` | 状态的结构化形态（计数而非文案） | 计划中（未实现） |
| `memory_expand` | 把折叠句柄 `[omw:handle=<id> ~<n> tokens]` 逐字还原为完整内容 | 计划中（未实现，属 Epic 8） |

召回类工具（`memory_recall` + `memory_related`，将来加 `memory_expand`）共享**每回合最多 3 次**的配额。

## 只读模式与降级行为

设计原则：**降级必须可见，不静默 no-op**。

- **单写者**：一个 profile 同一时刻只有一个窗口持写者锁。第二个窗口自动降级为**只读**：不采集、不精炼、拒绝写入；`/memory status` 显示 `readonly: true, reason: '...'`，`/memory remember` 与 `/memory forget` 返回明确的只读错误。
- **embedding 不可用**（`endpoint` / `token` / `model` 任一缺失）：召回降级为**关键词单路**，结果标 `degraded`，`/memory status` 显示 `embedding: disabled（降级检索）`；精炼仍会写入 L1，只是不产向量（这些节点计入 `未嵌入 N 条` 可见）。
- **System One 不可用**：忠实性判定整体降级回 `ctx.llm`，`/memory status` 显示 `systemOne: degraded` 或 `disabled-by-config`。
- **库未就绪 / profile 缺失**：命令返回可读错误，工具返回 `db_unavailable` 信封（不抛异常、不静默返回空结果）。
- **维度不符**（换了 embedding 模型）：启动时 fail-loud 拒绝，不自动重建库、不静默降级。
- **凭据纪律**：凭据只出现在 embedding / systemOne 的 `token` 字段（schema 标 `role: secret`），不写入日志、事件与审计账本。

## 开发与验证

```bash
pnpm install
pnpm verify            # constraints → typecheck → check:deps → check:migrations → test
pnpm test:coverage     # 覆盖率摘要（coverage/coverage-summary.json）
pnpm check:coverage    # 逐文件覆盖率 ratchet（不得低于 scripts/coverage-baseline.json）
pnpm pack:smoke        # 发布形态：tarball 精确内容断言
node scripts/publish-smoke.mjs   # 端到端发布冒烟（建临时 profile → 安装 → dump-config → remove）
pnpm test:e2e          # Playwright + 真实 dsh web（需要本机 dsh 与 chromium）
```

需求：Node ≥ 24.9.0、pnpm 12.18.0。Windows 上跑测试需要 PATH 里有 OpenSSL 3（例如 `C:\Program Files\Git\mingw64\bin`），否则 LadybugDB 的 vector/fts 扩展加载失败。

各包细节见 [`packages/dsh-oh-my-whale/README.md`](packages/dsh-oh-my-whale/README.md) 与 [`packages/dsh-oh-my-whale-memory/README.md`](packages/dsh-oh-my-whale-memory/README.md)。

## License

[MIT](LICENSE) © 2026 DSH Oh My Whale contributors

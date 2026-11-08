<!-- bmad:context -->
<!-- Verified 2026-11-08 against uncommitted initial state. Managed by bmad-project-context; edits inside this block are replaced on refresh. -->

## dsh-oh-my-whale 记忆插件

DSH 记忆插件 v1——Zettelkasten 原子记忆 + LLM Wiki + SCD-2 双时态图存储。pnpm workspace 两包，发布名锁定（AD-2/Q-6，永不重命名）。规划文档：PRD `_bmad-output/planning-artifacts/prds/prd-DSH-Oh-My-Whale-2026-11-07/prd.md`；架构 `_bmad-output/planning-artifacts/architecture/architecture-DSH-Oh-My-Whale-2026-11-08/ARCHITECTURE-SPINE.md`。宿主规范 `D:\workspace\deepseek-harness\docs\`（cordis-tutorial/、subsystems/、cookbook/、user/develop/basic/publish.md）。

## Policy

- **两包拓扑单向**：preset → memory 单向；memory 严禁 import preset；宿主不直接 import memory（AD-1）。
- **发布包名**：`dsh-oh-my-whale`（bundle 入口）/ `dsh-oh-my-whale-memory`（function 插件）；cordis 模块名与 settings namespace 均为 `dsh-oh-my-whale-memory`；systemPrompt section 名 `omw-memory`（AD-2）。目录简写 `dsh-omw-*` 不出现在发布名与文档示例中。
- **禁 default export**：function 插件只允许命名导出 `name`/`inject`/`Config`/`apply`；default export 让 Loader 丢弃 function 插件命名空间（PRD §14，postmortem 0001）。
- **LadybugDB 锁 `~0.22.x`**——不追 0.x 最新；升级需四条件全满足（v0.23 发布 + breaking 审阅 + Windows ABI 冒烟 + RRF/FTS/vector 回归），单独 PR（AD-3/§12）。
- **L0 append-only，永不改写**；事实变化写新节点 + 旧节点置 `invalid_at`/`expired_at`（AD-4）。
- **凭据字段命名 `token`，schema 必须标 `.role('secret')`**——字段名不参与脱敏判定，不标 role 则明文广播（AD-9）。凭据绝不写日志/事件/generation log。
- **单写者文件锁**：`apply` 阶段用 `withFileLock`；第二实例 `readOnly:true` 并禁用采集钩子与精炼消费者（AD-12）。
- **LLM 单通道**：所有 LLM 调用走宿主 `ctx.llm`，显式 provider+model；插件不自带 key（AD-5/§14）。
- **无 `ctx.settings.register` API**——SettingsForms 自动扫描 `inject` 含 `settings` 的插件；需要进 `/settings` 表单的字段必须标 `.volatile()`（AD-11）。
- **Windows ABI 冒烟测试是 v1 Week-1 阻塞项**（AD-13）。
- **不重议已关闭决策**：包名（Q-6）、compaction/start 同步快照（Q-1）、注入形式（Q-2）、SCD-2 全双时态（Q-7）、单模型通道（Q-8/m00548）。

## Where things are

- LadybugDB 库文件：`$DSH_HOME/profiles/<name>/memory/lbug.db`（跟随 profile）
- Harness 宿主规范：`D:\workspace\deepseek-harness\docs\cordis-tutorial\`（插件入门）、`docs/subsystems/`（子系统契约）、`docs/cookbook/`（加工具/设置卡片）、`docs/user/develop/basic/publish.md`（外部插件发布指南）
- `.temp/` 与 `.obsidian/` 不属于仓库内容，不读取、不提交

## Running and verifying

- `pnpm install`（Node ≥ 24.9.0，pnpm 12.18.0；`allowBuilds: {"@ladybugdb/core": true, "esbuild": true}` 已配——esbuild 为 vitest 链路所需）
- `dsh plugin --profile <name> add <pkg|path|git|tarball>` 安装进 profile
- `dsh --profile <name> --dump-config` 验证 patch 层落地（不启动宿主）
- `pnpm pack` 装进干净 profile 冒烟（PRD §14 工程纪律）
- 测试脚本已配 `vitest run`（根统一；各包 `scripts.test = "vitest run --root ../.."` 复用同一入口），含 Windows ABI 冒烟 `packages/dsh-oh-my-whale-memory/test/abi-smoke.test.ts`
- `engines.dsh` 声明兼容范围（如 `">=0.2.0 <0.3.0"`），否则宿主可能拒绝加载

## Package shape

- Bundle 包 `package.json` 必须含 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；无此字段则宿主只当普通依赖安装，`dsh plugin add` 打警告不激活（publish.md:64）。
- `@deepseek-ai/cordis` 在 `peerDependencies` 和 `devDependencies` **同时声明**（同 SemVer 范围）；`@deepseek-ai/schemastery` 放 `dependencies`（publish.md:105）。
- `cordis.patch.yml` 是顶层 YAML 数组，每项 `insert:` 或 `override:`（按行 `id` 替换整个 `config`，非深度合并）。`override` 必须重述每个要保留的字段。
- `engines.dsh` 存在时，`peerDependencies` 里 DSH 范围被忽略；无 `engines.dsh` 时每个 `@deepseek-ai/dsh-*` peer 必须匹配运行时。
- **不假设 hoisting**：每个 import 必须显式声明；发布给外部 profile 时 pnpm 用严格符号链接。

## Conventions that differ from defaults

- 节点 id = `uuid5(layer + ':' + normalized_text)`；含 layer，不含 source_refs 与时间戳（AD-4）
- 时间列 UTC ISO-8601 字符串（`valid_at`/`recorded_at`/`invalid_at`/`expired_at`）
- 错误 envelope：`{ code, message, retryable }`
- 结构化输出统一加 sentinel preamble："Field descriptions are never valid values; set them to null"（§14）
- prompt 与输出 schema 同文件保存，改 prompt 必须同步改 schema（§14）
- `cordis.patch.yml` 是安装期清单，不是构建产物——不被 tsdown 打进 `lib/`（§14）
- LLM 瞬时重试仅 5xx/限流/空响应/JSON 解析失败；上限 4 次，指数退避 5–120s；4xx 语义错直接降级不重试。两层重试（调用层/任务层）不叠加，禁止 4×N 同步链（§14）
- 后台任务用模块级 `Set<Promise>` 持强引用防 GC；完成/失败后自我移除（§14）

## Known pitfalls

- 凭据 `.role('secret')` 不标则明文广播，字段名叫 `token` 也不行（AD-9）
- Config 字段不标 `.volatile()` 则不进 `/settings` 表单（AD-11）
- System One 请求体字段名是 `state`（非 `content`）；`noul` 返回 `[0,1]` 浮点概率，不是布尔（AD-15）
- System One API 失败 ≠ 判定失败——网络/5xx/超时回滚 INBOX 重试，绝不丢弃候选（AD-15）
- bge-reranker API `documents` 必须是 `string[]`，不能是 `{ text }` 对象数组（错误 20015，AD-16）
- embedding 模型切换时 dim 与建库 pin 不符必须 fail-loud 拒绝启动，不静默降级（AD-14）
- Agent loop 不在 turn 边界 await flush；`turn/end` 钩子若需持久化，须显式 `await ctx.sessions.flush(session)`（harness `subsystems/session.md:741`）
- 命令 `name` 小写无斜杠（`memory` 非 `/memory`）；systemPrompt section `name` 层内唯一，重复即抛错（harness `subsystems/commands.md:38`、`subsystems/system-prompt.md`）
- 工具 `args` 经 `parameters` 校验后传入，视为只读；UI presenter 函数必须纯——无 I/O、无 session-state 读取、无时钟/随机（harness `cookbook/adding-a-tool.md`）
- `compaction/start` payload `{ turn: number | null }`，`null` 表示独立手动触发；未配对的 `compaction/start` 阻塞新条目（harness `subsystems/compaction.md`）
- 注册都是 effect：`ctx.on`/`ctx.effect`/`ctx.tools.register` 自动挂 disposer；自己创建的 timers/sockets/watchers 必须用 `ctx.effect(fn)` 手动释放（harness `cordis-tutorial/02-lifecycle-and-effects.md`）
- `.codegraph/` 目录存在但索引为空——建好索引后可用 `codegraph explore "<query>"` 替代 grep 定位代码

## Engineering discipline

- 最小完整变更：能不写的代码就不写；用现有 helper/依赖/平台能力；删优于加；保持仓库现有分层与约定。
- 动手前列出变更波及的每个 caller/test/fixture/config/export；检查是否会破坏用户数据或停止工作的调用方。
- 不留投机性抽象/包装/选项/占位代码；保持平台原生值形态。
- Bug 修复：先 grep 所有调用方，在共享代码里一次性修根因。
- 新增非平凡逻辑（分支/循环/解析器/金额/安全/新脚本）留一个最小测试或 assert 自检。
- 不可妥协：信任边界的校验、防数据丢失的错误处理、安全、无障碍、真实硬件校准、用户明确要求的一切。
- 回复末尾用 1–2 行写明：跳过了什么/未检查什么，以及用户需要知道的风险。
<!-- /bmad:context -->

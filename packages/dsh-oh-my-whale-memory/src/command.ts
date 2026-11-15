/**
 * `/memory` 宿主命令（Story 1.7 `remember` / 1.8 `list` + `show` / 1.9 `status` / 3.1
 * `recall` / 3.2 `related`）。
 *
 * 命令定义是可脱离宿主单测的纯工厂：解析与错误收敛不依赖 ctx。handler 只读
 * `invocation.rawInput`，把读/写库异常收敛为 `{ kind: 'error', text }`；命令不抛异常，
 * 宿主对 thrown handler 以 `kind: 'error'` 收尾（commands.md:172）。
 *
 * 七个子命令共用一个 definition（`ctx.commands.register` 仍只有一处），代码看不出的约束：
 * - `remember [--kind=..] [--priority=..] <内容>` 写 L1（Story 1.7 + 1.11）；FR-20 / AC2：
 *   手动写路径也产出非空 kind / 非 0 priority（含 -1）；
 * - `list [关键词]`：文本包含匹配、`recorded_at` 倒序、默认 20 条；
 * - `show <id>` 含已失效墓碑，「列表隐藏、详情可见」是有意的；
 * - `status` 无参、纯读、无 LLM/网络（Story 1.9）；
 * - `forget <id>` 软删除（Story 4.1）：目标写 expired_at、上层引用者同事务写 invalid_at；
 * - `list` 是字面包含匹配（两侧小写化），不是语义检索 / 向量 / FTS / RRF；语义检索走
 *   `recall`（db 侧 src/recall/core.ts）。过滤、排序、截断在 db 层完成，命令层只做渲染；
 * - 手动 `recall` / `related` 不计入 turn 配额，配额只作用于对应的工具面。
 *
 * `@deepseek-ai/dsh-commands` 在本工作区不可解析，故只用本地结构化类型描述命令定义 /
 * 调用 / 结果，运行时形态与宿主 `CommandDefinition` / `CommandInvocation` /
 * `CommandResult` 一致（D:\workspace\deepseek-harness\docs\subsystems\commands.md）。
 */
import {
  MEMORY_KINDS,
  MEMORY_PRIORITY_MAX,
  MEMORY_PRIORITY_MIN,
  isMemoryKind,
  isMemoryPriority,
} from './shared/memory-vocab.js'
import { summarizeMemoryText } from './shared/summarize.js'
import type { LastInjectionSummary } from './injection/state.js'
import { RECALL_DEFAULT_LIMIT } from './recall/core.js'

/** 宿主命令名（小写、无前导斜杠）。 */
export const MEMORY_COMMAND_NAME = 'memory'
/** `remember` 子命令：`rawInput` 的首个 token。 */
export const MEMORY_REMEMBER_SUBCOMMAND = 'remember'
/** `list` 子命令：浏览最近的记忆。 */
export const MEMORY_LIST_SUBCOMMAND = 'list'
/** `show` 子命令：按 id 取一条记忆的完整字段。 */
export const MEMORY_SHOW_SUBCOMMAND = 'show'
/** `status` 子命令：记忆规模与运行态（Story 1.9）。 */
export const MEMORY_STATUS_SUBCOMMAND = 'status'
/** `recall` 子命令：混合检索（Story 3.1）。 */
export const MEMORY_RECALL_SUBCOMMAND = 'recall'
/** `related` 子命令：沿证据链/语义关系遍历邻居（Story 3.2）。 */
export const MEMORY_RELATED_SUBCOMMAND = 'related'
/** `forget` 子命令：软删除一条记忆并级联作废其上层引用者（Story 4.1）。 */
export const MEMORY_FORGET_SUBCOMMAND = 'forget'

/**
 * `list` 默认返回条数。
 *
 * 无既有常量可复用（`src/config.ts` 无列表条数字段，PRD FR-14 / FR-11 也没给数字）。取 20
 * 与 FR-12 的「结果上限 20 条」同量级，避免同一产品里 20/50 两种口径并存。这是本 story 的
 * 取舍，不是 PRD 要求（见 spec Design Notes）。
 */
export const MEMORY_LIST_DEFAULT_LIMIT = 20

/** `remember` 子命令 payload 缺失或旗标非法时的 usage 提示。 */
export const MEMORY_REMEMBER_USAGE = [
  '用法：/memory remember <内容>',
  '',
  '可选分类旗标：/memory remember [--kind=<分类>] [--priority=<整数>] <内容>',
  '分类（kind）取 ' + MEMORY_KINDS.join(' / ') + ' 之一；priority 取 ' +
  MEMORY_PRIORITY_MIN + '..' + MEMORY_PRIORITY_MAX + '，-1 = 全局强规则（恒置顶）。',
  '省略旗标时 kind 为空、priority 为 0。示例：/memory remember 我偏好 ESM 不要 CJS',
].join('\n')

/** `list` 子命令用法（关键词可选）。 */
export const MEMORY_LIST_USAGE = [
  '用法：/memory list [关键词]',
  '',
  '列出最近的记忆（关键词为字面包含匹配，最近优先，默认 20 条）。示例：/memory list RRF',
].join('\n')

/** `show` 子命令缺少 id 时的 usage 提示。 */
export const MEMORY_SHOW_USAGE = [
  '用法：/memory show <id>',
  '',
  '查看一条记忆的完整字段（含已失效记忆）。id 取自 /memory list 的输出。',
].join('\n')

/** `status` 子命令的 usage（spec 钉死值：`/memory status`）。
 *
 * `status` 无参数：解析到多余 payload 时返回本常量作为错误正文（不静默忽略输入），
 * 但不回显用户输入的 payload，错误正文恒为命令形态本身。
 */
export const MEMORY_STATUS_USAGE = '/memory status'

/**
 * `recall` 子命令的缺省条数（F-10）：直接复用内核的 `RECALL_DEFAULT_LIMIT`，不再自己写
 * 字面量，命令面与工具面的缺省条数只有一个来源（此前两份 5 只能靠测试的 drift-guard 兜住）。
 */
export const MEMORY_RECALL_DEFAULT_LIMIT = RECALL_DEFAULT_LIMIT

/** `recall` 子命令缺少 query 时的 usage 提示。 */
export const MEMORY_RECALL_USAGE = [
  '用法：/memory recall <query>',
  '',
  '混合检索记忆（语义向量路 + 关键词路，RRF 融合排序，最多 ' + MEMORY_RECALL_DEFAULT_LIMIT + ' 条）。',
  '示例：/memory recall RRF 融合',
].join('\n')

/** `related` 子命令缺少 id / depth 非法时的 usage 提示（Story 3.2）。 */
export const MEMORY_RELATED_USAGE = [
  '用法：/memory related <id> [depth]',
  '',
  '沿证据链与语义关系网遍历一条记忆的邻居（EVIDENCE + RELATED 无向，按跳数升序，最多 20 条）。',
  'depth 可选 1..3，缺省 2。',
  '示例：/memory related <记忆 id> 2',
].join('\n')

/** `forget` 子命令缺少 id 时的 usage 提示（Story 4.1）。 */
export const MEMORY_FORGET_USAGE = [
  '用法：/memory forget <id>',
  '',
  '把一条记忆从当前快照里移除：目标写 expired_at（此后同文本重写不复活），',
  '其上层引用者按跳数自顶向下写 invalid_at（EII 定序级联），同事务生效。',
  'id 取自 /memory list 或 /memory recall 的输出。示例：/memory forget <记忆 id>',
].join('\n')

/** 未知 / 缺失子命令时的总用法（必须含 remember / list / show / status / recall / related / forget 七条）。 */
export const MEMORY_COMMAND_USAGE = [
  '用法：/memory <子命令>',
  '',
  MEMORY_REMEMBER_USAGE,
  '',
  MEMORY_LIST_USAGE,
  '',
  MEMORY_SHOW_USAGE,
  '',
  MEMORY_STATUS_USAGE,
  '',
  MEMORY_RECALL_USAGE,
  '',
  MEMORY_RELATED_USAGE,
  '',
  MEMORY_FORGET_USAGE,
].join('\n')

/** 命令调用（宿主实际传入完整对象，本命令只消费 `rawInput`）。 */
export interface MemoryCommandInvocation {
  /** 命令名之后的原文，含分隔空白。 */
  readonly rawInput: string
}

/** 命令结果（宿主直接渲染给 UI，永不抛出）。 */
export interface MemoryCommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** 本插件消费的宿主命令运行时切片（结构化，避免依赖不可解析的 dsh-commands）。 */
export interface MemoryCommandsRuntime {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
    readonly handler: (invocation: MemoryCommandInvocation) => Promise<MemoryCommandResult>
  }): () => void
}

/** 命令定义（交给 `ctx.commands.register` 的对象）。 */
export type MemoryCommandDefinition = Parameters<MemoryCommandsRuntime['register']>[0]

/** 列表项（db 层 `listMemories` 的返回形状；命令层不 import db 模块）。 */
export interface MemoryCommandListEntry {
  readonly id: string
  readonly layer: string
  readonly text: string
}

/** 召回命中项（命令层镜像 src/recall/core.ts 的 `RecallResultItem`；不 import db 模块）。 */
export interface MemoryCommandRecallEntry {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  readonly truncated?: boolean
  readonly evidence?: readonly string[]
}

/** 召回结果（与 memory_recall 工具成功值同形：results + degraded + hint；total = limit 截断前命中数）。 */
export interface MemoryCommandRecallResult {
  readonly total: number
  readonly results: readonly MemoryCommandRecallEntry[]
  readonly degraded: boolean
  readonly hint: string
}

/** 关联遍历命中项（命令层镜像 `tools/related-shared.ts` 的共享视图；不 import db 模块）。 */
export interface MemoryCommandRelatedEntry {
  readonly id: string
  readonly layer: string
  readonly hops: number
  readonly edgeType: 'EVIDENCE' | 'RELATED'
  readonly reason?: string
  readonly text: string
  readonly truncated?: boolean
  readonly invalid?: boolean
  readonly invalidAt?: string
  readonly expiredAt?: string
}

/** 关联遍历结果（与 memory_related 工具成功值同形：results + hint + partial）。 */
export interface MemoryCommandRelatedResult {
  readonly id: string
  readonly depth: number
  readonly total: number
  readonly results: readonly MemoryCommandRelatedEntry[]
  readonly hint?: string
  readonly partial?: boolean
}

/** 被遗忘的一个节点（命令层镜像 `db/forget.ts` 的 `ForgottenNode`；不 import db 模块）。 */
export interface MemoryCommandForgetEntry {
  readonly id: string
  readonly layer: string
  /** 与目标的证据跳数：目标 0，级联受害者 1..4。 */
  readonly hops: number
  readonly text: string
}

/** 遗忘结果（与 `db/forget.ts` 的 `ForgetResult` 同形）。 */
export interface MemoryCommandForgetResult {
  readonly id: string
  /** true = 此前已遗忘（幂等重放），本次没有写任何行。 */
  readonly alreadyExpired: boolean
  /** 跳数降序、目标在最后；幂等重放时只有目标一行。 */
  readonly affected: readonly MemoryCommandForgetEntry[]
}

/** 单条记忆详情（db 层 `getMemoryById` 的返回形状；字段与 show 渲染顺序一致）。 */
export interface MemoryCommandDetail {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  readonly validAt: string | null
  readonly recordedAt: string
  readonly invalidAt: string | null
  readonly expiredAt: string | null
  readonly sourceRefs: readonly string[]
  readonly embeddingModelId: string | null
}

/**
 * `/memory status` 的运行态快照（Story 1.9）。命令层不 import db 模块，形状在此镜像，
 * 计数事实源是 `memory` 表的 `layer` 列（db 层 `countMemoriesByLayer`）。
 *
 * `failed` 在 Epic 1 恒为 0：库内没有任何失败存储（`schema.ts` 只有 memory / l0_raw /
 * omw_meta），PRD 的条目状态机属 Epic 2 Story 2.2。本 story 只放占位，2.2 建队列后由
 * 真实计数替换，别把这个字段读成「系统健康」。
 */
export interface MemoryStatusSnapshot {
  /** L1 / L2 计数（按全部行聚合，不套失效过滤）。 */
  readonly layers: { readonly L1: number; readonly L2: number }
  /** 两路 INBOX 的排队量。 */
  readonly inboxes: { readonly L1: number; readonly L2: number }
  /** 失败条目计数（Story 2.2 起读 `l1_inbox` 的 failed 计数；表缺失照抛，不静默报 0）。 */
  readonly failed: number
  /**
   * 最近失败条目明细（最近 5 条，Story 2.2 / AC4）。空或缺省时不追加任何行，
   * 既有 status 逐行输出保持不变。
   */
  readonly failedEntries?: readonly MemoryFailedEntry[]
  /** embedding 可用性：endpoint / token / model 任一缺失即 'disabled'（降级检索）。 */
  readonly embeddingMode: 'enabled' | 'disabled'
  /**
   * System One 忠实性通道的状态（Story 2.5 / AC:674、U6）：
   * - `enabled`：配置开启且未运行态降级，核实走 System One；
   * - `disabled-by-config`：`systemOne.enabled=false`，整体回落 ctx.llm 单次检查；
   * - `degraded`：端点持续不可达（连续失败达阈值），整体回落 ctx.llm 单次检查。
   */
  readonly systemOne: SystemOneStatusMode
  /**
   * 仍有效但没有向量的节点数（Story 2.4 / U5）：这些节点进不了 HNSW，对语义去重与
   * 语义检索隐形。仅在 embedding enabled 且该值 > 0 时追加渲染，0 时输出逐字不变。
   */
  readonly unembedded: number
  /** 本窗口是否降级只读（写者锁被另一实例持有）。 */
  readonly readonly: boolean
  /** 只读原因，逐字取 `READONLY_REASON`；非只读时缺省。 */
  readonly readonlyReason?: string
  /** audit_gap 计数；null = 审计表缺失、算不出来（不静默报 0）。 */
  readonly auditGap: number | null
  /**
   * 边侧差额（Story 2.6 / EII + 漂移合计）：null = 边表缺失、算不出来（渲染成未知，
   * 不静默报 0，与 auditGap 同一约定）。仅 total > 0 或为 null 时追加渲染。
   */
  readonly evidenceGap: EvidenceGapCounts | null
  /**
   * 被跳过/拒绝的关系写入条数（Story 2.6 / AD-21：降级必须可见）。null = 审计表缺失、
   * 算不出来（渲染成未知，不静默报 0，与 auditGap 同一约定）。0 时不追加渲染。
   */
  readonly relatedSkipped: number | null
  /**
   * L2 提升的死信条数（Story 2.5 / 评审 P8-T8）：l2_inbox 里 status='failed' 的数量。
   * 缺省/0 ⇒ 不追加渲染（既有逐行输出逐字不变）。
   */
  readonly l2Failed?: number
  /** L2 死信最近条目明细（与 L1 的 failedEntries 同形，仅 > 0 时追加）。 */
  readonly l2FailedEntries?: readonly MemoryFailedEntry[]
  /**
   * 疑似失效账目计数（Story 2.5 / 评审 P8-T27）：generation_log 里 outcome='uncertain' 的行数。
   * null = 审计表缺失、算不出来（渲染成未知）；0/缺省 ⇒ 不追加渲染。
   */
  readonly uncertain?: number | null
  /**
   * 最近一次开局注入的观测摘要（Story 3.3 / B4）：`null` = 本实例从未触发过开局注入
   * （渲染成未知，不静默报 0）；缺省按 null 处理。
   */
  readonly injection?: LastInjectionSummary | null
  /**
   * Config `injectOnNewSession`（Story 3.3）：false ⇒ 渲染「已关闭注入」而不是「未知」。
   * 缺省按 true 处理（既有夹具无需改动即向后兼容）。
   */
  readonly injectionEnabled?: boolean
}

/**
 * System One 通道的状态枚举（Story 2.5 / U6）。命令层不 import db/distill 模块，
 * 故在此重复声明形状，与 `distill/system-one.ts` 的运行态槽语义必须一致。
 */
export type SystemOneStatusMode = 'enabled' | 'disabled-by-config' | 'degraded'

/**
 * 边侧差额计数（命令层镜像 `db/eii.ts` 的 `EvidenceGapSummary`）。命令层不 import db 模块，
 * 形状在此重复声明，两个字段名与语义必须与 db 侧一致（`eii.ts` 的 `EvidenceGapSummary`）。
 */
export interface EvidenceGapCounts {
  /** EII 违例（有效节点但无有效路径到 L0）。 */
  readonly eiiViolations: number
  /** 边 ↔ source_refs 漂移（双向合计）。 */
  readonly drift: number
  readonly total: number
}

/**
 * 死信明细（Story 2.2 / AC4）：只给计数不够定位，`/memory status` 追加最近的失败摘要。
 * `stale` 由读侧（src/index.ts 的 getStatus，24h 基准）判定，渲染层保持纯函数。
 */
export interface MemoryFailedEntry {
  readonly id: string
  readonly kind: string
  readonly attempts: number
  readonly lastError: string | null
  readonly updatedAt: string
  /** true = 进入 failed 起已超过 24h 仍未被处理。 */
  readonly stale: boolean
}

/** remember 的可选分类入参（FR-20，AC2：手动写路径也能产出非空 kind / 非 0 priority）。 */
export interface MemoryInboxWriteOptions {
  /** 七类分类之一（缺省不传 → 落库空串）。 */
  readonly kind?: string
  /** 优先级 -1..100（缺省不传 → 落库 0）。 */
  readonly priority?: number
}

/** 命令依赖（由 `src/index.ts` 惰性绑定到库句柄；读路径不得在库未就绪时静默返回空）。 */
export interface MemoryCommandDependencies {
  /** 把一条文本写入 L1；可选分类旗标经 options 透传；抛错由 handler 收敛为 error 结果。 */
  writeInbox(text: string, options?: MemoryInboxWriteOptions): Promise<void>
  /** 取最近未失效的记忆（库侧已过滤/倒序/截断）；抛错由 handler 收敛。 */
  listMemories(input: { readonly query?: string; readonly limit: number }): Promise<readonly MemoryCommandListEntry[]>
  /** 按 id 取详情；不存在返回 null（不是抛错）。 */
  getMemoryById(id: string): Promise<MemoryCommandDetail | null>
  /** 读层计数与运行态（Story 1.9）；抛错由 handler 收敛为 error 结果。 */
  getStatus(): Promise<MemoryStatusSnapshot>
  /**
   * 混合检索（Story 3.1；渲染层只消费结果）。手动 `recall` 不计入 turn 配额，
   * 配额在 memory_recall 工具面消耗；抛错由 handler 收敛为 error 结果。
   */
  recallMemories(input: { readonly query: string; readonly limit: number }): Promise<MemoryCommandRecallResult>
  /**
   * 关联遍历（Story 3.2；渲染层只消费结果）。手动 `related` 同样不计入 turn 配额；
   * 抛错由 handler 收敛为 error 结果。
   */
  relatedMemories(input: { readonly id: string; readonly depth?: number }): Promise<MemoryCommandRelatedResult>
  /**
   * 遗忘一条记忆并级联作废其上层引用者（Story 4.1）。抛错由 handler 收敛为 error 结果
   *（不存在时是 `memory_not_found`，文案「未找到 id 为 <id> 的记忆。」）。手动 forget 不计入
   * turn 配额（配额只作用于召回族工具）。
   */
  forgetMemory(id: string): Promise<MemoryCommandForgetResult>
}

/** 解析结果：七个子命令分支，或「缺参 / 未知子命令」并给出对应 usage。 */
export type MemoryCommandParseResult =
  | { kind: 'remember', text: string, classification?: MemoryInboxWriteOptions }
  | { kind: 'list', query?: string }
  | { kind: 'show', id: string }
  | { kind: 'status' }
  | { kind: 'recall', query: string }
  | { kind: 'related', id: string, depth?: number }
  | { kind: 'forget', id: string }
  | { kind: 'invalid', usage: string }

/** `--kind=` 旗标名（AC2：手动写路径产出非空分类）。 */
const MEMORY_REMEMBER_KIND_FLAG = '--kind='
/** `--priority=` 旗标名（AC2：手动写路径产出非零 priority，含 -1）。 */
const MEMORY_REMEMBER_PRIORITY_FLAG = '--priority='

/**
 * 旗标值的结束偏移：`flag` 之后首个空白字符（空格与制表符同等对待，与子命令切分
 * 用的 `\s+` 保持一致）；-1 表示旗标一直延伸到串尾（如 `--kind=persona` 无正文）。
 */
function flagValueEnd(rest: string, flag: string): number {
  const whitespace = rest.slice(flag.length).search(/\s/)
  return whitespace === -1 ? -1 : whitespace + flag.length
}

/**
 * 解析 `remember` 的 payload：前导 `--kind=<分类>` / `--priority=<整数>` 旗标
 * 可任意顺序、可缺省，解析到首个非旗标 token 为止，其余（保留内部空白）为正文。
 * 缺参 → `{ kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }`；非法旗标值同样拒绝
 * （不回显、不静默忽略），保证「可写路径」不会悄悄吞掉错误输入。
 */
function parseRememberPayload(payload: string): MemoryCommandParseResult {
  let rest = payload.trim()
  let kind: string | undefined
  let priority: number | undefined
  for (;;) {
    if (rest.startsWith(MEMORY_REMEMBER_KIND_FLAG)) {
      const end = flagValueEnd(rest, MEMORY_REMEMBER_KIND_FLAG)
      const value = (end === -1 ? rest.slice(MEMORY_REMEMBER_KIND_FLAG.length) : rest.slice(MEMORY_REMEMBER_KIND_FLAG.length, end)).trim()
      // 非法分类值拒绝：usage 明说 kind 取七类之一，不能把任意串静默写进库。
      if (!isMemoryKind(value)) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
      kind = value
      rest = end === -1 ? '' : rest.slice(end).trim()
      continue
    }
    if (rest.startsWith(MEMORY_REMEMBER_PRIORITY_FLAG)) {
      const end = flagValueEnd(rest, MEMORY_REMEMBER_PRIORITY_FLAG)
      const raw = (end === -1 ? rest.slice(MEMORY_REMEMBER_PRIORITY_FLAG.length) : rest.slice(MEMORY_REMEMBER_PRIORITY_FLAG.length, end)).trim()
      if (!/^-?\d+$/.test(raw)) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
      const parsed = Number(raw)
      // usage 明说 priority 取 -1..100；越界与非安全整数（DB 侧 INT64 会溢出）同样拒绝。
      if (!isMemoryPriority(parsed)) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
      priority = parsed
      rest = end === -1 ? '' : rest.slice(end).trim()
      continue
    }
    break
  }
  if (!rest) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
  const classification: MemoryInboxWriteOptions = {
    ...(kind === undefined ? {} : { kind }),
    ...(priority === undefined ? {} : { priority }),
  }
  return { kind: 'remember', text: rest, classification }
}

/**
 * 解析 `rawInput`：trim 起始空白取首 token（子命令大小写敏感）。
 * - `remember` → 其余 trim 后为 payload；payload 为空给 `MEMORY_REMEMBER_USAGE`；
 * - `list` → 其余 trim 后为可选关键词（可为空，表示不过滤）；
 * - `show` → 其余 trim 后为 id；为空给 `MEMORY_SHOW_USAGE`；
 * - `status` → 不接受 payload；有 payload 给 `MEMORY_STATUS_USAGE`（不静默忽略输入）；
 * - `recall` → 其余 trim 后为检索 query；为空给 `MEMORY_RECALL_USAGE`（Story 3.1）；
 * - `related` → 其余 trim 后为 `<id> [depth]`（Story 3.2，depth 非正整数 → usage）；
 * - `forget` → 其余 trim 后为 id；为空给 `MEMORY_FORGET_USAGE`（Story 4.1）；
 * - 其它 token / 空 `rawInput` → `MEMORY_COMMAND_USAGE`。
 * 保留 payload 的内部空白（只 trim 首尾）。
 */
export function parseMemoryCommand(rawInput: string): MemoryCommandParseResult {
  const trimmedStart = rawInput.trimStart()
  if (!trimmedStart) return { kind: 'invalid', usage: MEMORY_COMMAND_USAGE }
  const firstWhitespace = trimmedStart.search(/\s+/)
  const subcommand = firstWhitespace === -1 ? trimmedStart : trimmedStart.slice(0, firstWhitespace)
  const payload = firstWhitespace === -1 ? '' : trimmedStart.slice(firstWhitespace).trim()
  switch (subcommand) {
    case MEMORY_REMEMBER_SUBCOMMAND:
      return parseRememberPayload(payload)
    case MEMORY_LIST_SUBCOMMAND:
      return payload ? { kind: 'list', query: payload } : { kind: 'list' }
    case MEMORY_SHOW_SUBCOMMAND:
      return payload ? { kind: 'show', id: payload } : { kind: 'invalid', usage: MEMORY_SHOW_USAGE }
    case MEMORY_STATUS_SUBCOMMAND:
      return payload ? { kind: 'invalid', usage: MEMORY_STATUS_USAGE } : { kind: 'status' }
    case MEMORY_RECALL_SUBCOMMAND:
      return payload ? { kind: 'recall', query: payload } : { kind: 'invalid', usage: MEMORY_RECALL_USAGE }
    case MEMORY_RELATED_SUBCOMMAND:
      return parseRelatedPayload(payload)
    case MEMORY_FORGET_SUBCOMMAND:
      return payload ? { kind: 'forget', id: payload } : { kind: 'invalid', usage: MEMORY_FORGET_USAGE }
    default:
      return { kind: 'invalid', usage: MEMORY_COMMAND_USAGE }
  }
}

/**
 * 异常转可读文本：Error 取 message，其它取字符串。不携带凭据（只含用法/字段名）。
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 列表/召回共用的文本摘要（60 code point 截断）在 ./summarize.ts（Story 3.1：memory_recall
// 工具的 presenter 也要同一规则，命令层不 import db 模块故单独成模块）。

/**
 * 解析 `related` 的 payload：`<id> [depth]`（Story 3.2）。
 * - 缺 id → usage；超过两个 token → usage（不静默忽略多余输入）；
 * - depth 必须是正整数（非整数/0/负数 → usage；>3 由遍历层夹紧到 3，与工具面同口径）。
 */
function parseRelatedPayload(payload: string): MemoryCommandParseResult {
  if (!payload) return { kind: 'invalid', usage: MEMORY_RELATED_USAGE }
  const tokens = payload.split(/\s+/)
  if (tokens.length > 2) return { kind: 'invalid', usage: MEMORY_RELATED_USAGE }
  const id = tokens[0]!
  if (tokens.length === 1) return { kind: 'related', id }
  const depthToken = tokens[1]!
  if (!/^\d+$/.test(depthToken)) return { kind: 'invalid', usage: MEMORY_RELATED_USAGE }
  const depth = Number(depthToken)
  if (!Number.isSafeInteger(depth) || depth < 1) return { kind: 'invalid', usage: MEMORY_RELATED_USAGE }
  return { kind: 'related', id, depth }
}

/** 详情值占位：NULL / undefined / 空字符串统一渲染 `(空)`，不出现 `undefined`。 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '(空)'
  const text = String(value)
  return text === '' ? '(空)' : text
}

/** 详情里的 `text`：内容照旧，但把换行转义，避免破坏「每行一个字段」的钉死格式。 */
function renderSingleLine(value: unknown): string {
  return renderValue(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

/** 详情里的字符串数组：NULL → `(空)`；空数组 → `[]`；否则 `[a, b]`。 */
function renderRefs(refs: readonly string[] | null | undefined): string {
  if (refs === null || refs === undefined) return '(空)'
  return refs.length === 0 ? '[]' : `[${refs.join(', ')}]`
}

/**
 * 列表渲染（spec 钉死格式）：
 * - 空库（无关键词）→ `暂无记忆。`；有关键词但无命中 → `没有匹配「<关键词>」的记忆。`；
 * - 有命中的首行恒为 `记忆列表（共 N 条，最近优先）：`，不回显关键词：spec 的「输出格式
 *   钉死（可断言）」枚举的列表首行形态里，不带关键词的变体就是这一种；命中行本身都含该
 *   关键词（大小写不敏感匹配的后果），「成功文案含该关键词」由命中内容满足。
 *   其后每行 `- <id> [<layer>] <text摘要>`。
 */
function renderMemoryList(entries: readonly MemoryCommandListEntry[], query: string | undefined): string {
  if (entries.length === 0) {
    return query === undefined ? '暂无记忆。' : `没有匹配「${query}」的记忆。`
  }
  return [
    `记忆列表（共 ${entries.length} 条，最近优先）：`,
    ...entries.map((entry) => `- ${entry.id} [${entry.layer}] ${summarizeMemoryText(entry.text)}`),
  ].join('\n')
}

/**
 * 关联渲染（Story 3.2）：首行 `记忆关联（共 total 条，显示 N 条）：`（total = 20 条截断前），
 * 其后每行 `- <id> <hops>跳 [<edge_type>] <text摘要>`，失效邻居追加「（已失效）」；
 * 末行展示 hint（evidence expired / partial / 起点已失效）。无命中是成功值。
 */
function renderMemoryRelated(result: MemoryCommandRelatedResult): string {
  if (result.results.length === 0) return result.hint ?? '无匹配记忆。'
  const lines = [
    `记忆关联（共 ${result.total} 条，显示 ${result.results.length} 条）：`,
    ...result.results.map((entry) => {
      const mark = entry.invalid === true ? '（已失效）' : ''
      return `- ${entry.id} ${entry.hops}跳 [${entry.edgeType}] ${summarizeMemoryText(entry.text)}${mark}`
    }),
  ]
  if (result.hint !== undefined && result.hint !== '') lines.push(result.hint)
  return lines.join('\n')
}

/**
 * 召回渲染（Story 3.1）：与 memory_recall 工具的 presenter 同形摘要。
 * 首行 `记忆召回（共 <total> 条，显示 <N> 条，按 RRF 排序）：`，total 是 limit 截断前的
 * 融合命中数（D6：用户据此看到「还有多少没显示」），其后每行 `- <id> [<layer>] <text摘要>`；
 * 末行展示内核 `hint`（降级/无命中的说明只有 hint 一个来源，两个渲染面不再各拼文案）。
 * 无命中是正常成功值，直接返回 hint（`无匹配记忆。` / 降级版），不是错误。
 */
function renderMemoryRecall(result: MemoryCommandRecallResult): string {
  if (result.results.length === 0) return result.hint
  const lines = [
    `记忆召回（共 ${result.total} 条，显示 ${result.results.length} 条，按 RRF 排序）：`,
    ...result.results.map((entry) => `- ${entry.id} [${entry.layer}] ${summarizeMemoryText(entry.text)}`),
  ]
  if (result.hint !== '') lines.push(result.hint)
  return lines.join('\n')
}

/**
 * 遗忘渲染（Story 4.1，spec「钉死的输出文案」逐字）：
 * - 首次成功：`已遗忘 <id>：共作废 <n> 条（其中级联 <n-1> 条）`，其后每行
 *   `- <id> [<layer>] 深度 <d> <text摘要>`（行按跳数降序，目标在最后）；
 * - 幂等重放：`已遗忘 <id>：本次未重复写入（此前已遗忘）`，只有目标一行、深度 0。
 * 摘要走 `summarizeMemoryText`（折叠换行 + 60 code point 截断），保证「每行一个条目」。
 */
function renderMemoryForget(result: MemoryCommandForgetResult): string {
  const entries = result.affected.map(
    (entry) => `- ${entry.id} [${entry.layer}] 深度 ${entry.hops} ${summarizeMemoryText(entry.text)}`,
  )
  if (result.alreadyExpired) {
    return [`已遗忘 ${result.id}：本次未重复写入（此前已遗忘）`, ...entries].join('\n')
  }
  return [
    `已遗忘 ${result.id}：共作废 ${result.affected.length} 条（其中级联 ${result.affected.length - 1} 条）`,
    ...entries,
  ].join('\n')
}

/**
 * 详情渲染（spec 钉死格式）：首行 `记忆 <id>：`，其后按 AC 字段顺序每行 `<字段>: <值>`。
 * 不回显 `embedding` 向量列（体积与可读性）。
 */
function renderMemoryDetail(detail: MemoryCommandDetail): string {
  return [
    `记忆 ${detail.id}：`,
    `layer: ${renderValue(detail.layer)}`,
    `kind: ${renderValue(detail.kind)}`,
    `priority: ${renderValue(detail.priority)}`,
    `text: ${renderSingleLine(detail.text)}`,
    `valid_at: ${renderValue(detail.validAt)}`,
    `recorded_at: ${renderValue(detail.recordedAt)}`,
    `invalid_at: ${renderValue(detail.invalidAt)}`,
    `expired_at: ${renderValue(detail.expiredAt)}`,
    `source_refs: ${renderRefs(detail.sourceRefs)}`,
    `embedding_model_id: ${renderValue(detail.embeddingModelId)}`,
  ].join('\n')
}

/**
 * 追加一块死信明细（标题 + 每条一行）。L1 的 `failed` 与 L2 的 `l2_failed` 逐字段同形，
 * 故共用同一段渲染，两处都必须让 id/kind 过 `renderSingleLine`（值内换行会伪造出额外行，
 * 破坏「逐行钉死」的输出格式，P5）。entries 为空时不追加任何行。
 */
function appendFailedEntryLines(
  lines: string[],
  label: string,
  entries: readonly MemoryFailedEntry[],
): void {
  if (entries.length === 0) return
  lines.push(label)
  for (const entry of entries) {
    lines.push(
      `- ${renderSingleLine(entry.id)} kind=${renderSingleLine(entry.kind)} attempts=${entry.attempts}` +
      `${entry.stale ? ' stale' : ''} updated_at=${entry.updatedAt} error=${renderSingleLine(entry.lastError ?? '')}`,
    )
  }
}

/**
 * audit_gap 行的值（Story 4.1 / D-B：按 AD-21 合并成三集合计）。
 *
 * AD-21 把 audit_gap 定义为三集合并集：缺裁决记录（keyed 口径）+ EII 违例 + 边/refs 漂移。
 * 此前实现只把第一集渲染在 `audit_gap` 行，另两集另起 `evidence_gap` 行才是偏差；现在
 * `audit_gap` 给合计，`evidence_gap` 保留为分项明细（EII / 漂移），两张表都算不出来时
 * 同一句「未知」，绝不静默报 0。
 */
function renderAuditGapValue(snapshot: MemoryStatusSnapshot): string {
  if (snapshot.auditGap === null || snapshot.evidenceGap === null) {
    return '未知（审计表或边表缺失）'
  }
  return String(snapshot.auditGap + snapshot.evidenceGap.total)
}

/**
 * 状态渲染（spec「输出格式钉死（可断言）」逐行照抄）：
 * 首行 `记忆状态`，其后固定顺序的 `键: 值` 行，计数为十进制。
 *
 * 非降级也显式打印 `embedding: enabled` 与 `readonly: false`，「不静默 no-op」要求降级
 * 可见，显式打印非降级态让两种模式都可断言，也避免把「字段缺失」误读成健康。
 */
export function renderMemoryStatus(snapshot: MemoryStatusSnapshot): string {
  const lines = [
    '记忆状态',
    `L1: ${snapshot.layers.L1}`,
    `L2: ${snapshot.layers.L2}`,
    `L1_INBOX: ${snapshot.inboxes.L1}`,
    `L2_INBOX: ${snapshot.inboxes.L2}`,
    `failed: ${snapshot.failed}`,
    `audit_gap: ${renderAuditGapValue(snapshot)}`,
    snapshot.embeddingMode === 'disabled'
      ? 'embedding: disabled（降级检索）'
      : snapshot.unembedded > 0
        ? `embedding: enabled（未嵌入 ${snapshot.unembedded} 条）`
        : 'embedding: enabled',
    // Story 2.5 / U6：恒打印一行（与 embedding 行同一取向），非降级也显式打印，
    // 让「配置关闭」与「运行态降级」两种降级都可断言，且不与 enabled 混淆。
    snapshot.systemOne === 'disabled-by-config'
      ? 'systemOne: disabled-by-config（已降级回 ctx.llm）'
      : snapshot.systemOne === 'degraded'
        ? 'systemOne: degraded（已降级回 ctx.llm）'
        : 'systemOne: enabled',
    snapshot.readonly ? `readonly: true, reason: '${snapshot.readonlyReason ?? ''}'` : 'readonly: false',
  ]
  // Story 2.6 / D7：边侧差额（EII + 漂移）与关系降级都只在需要时追加，gap=0 时既有
  // 逐行输出逐字不变。边表缺失（null）与审计表缺失一样渲染成未知，不静默报 0。
  if (snapshot.evidenceGap === null) {
    lines.push('evidence_gap: 未知（边表缺失）')
  } else if (snapshot.evidenceGap.total > 0) {
    lines.push(
      `evidence_gap: ${snapshot.evidenceGap.total}` +
      `（EII ${snapshot.evidenceGap.eiiViolations} / 漂移 ${snapshot.evidenceGap.drift}）`,
    )
  }
  if (snapshot.relatedSkipped === null) {
    lines.push('related_skipped: 未知（审计表缺失）')
  } else if (snapshot.relatedSkipped > 0) {
    lines.push(`related_skipped: ${snapshot.relatedSkipped}`)
  }
  // Story 2.5 / 评审 P8：L2 死信与疑似失效账目都只在需要时追加，0/缺省时既有
  // 逐行输出逐字不变；算不出来（null）照 2.6 的范式渲染「未知」，不静默报 0。
  if (snapshot.l2Failed !== undefined && snapshot.l2Failed > 0) {
    lines.push(`l2_failed: ${snapshot.l2Failed}`)
  }
  if (snapshot.uncertain === null) {
    lines.push('uncertain: 未知（审计表缺失）')
  } else if (snapshot.uncertain !== undefined && snapshot.uncertain > 0) {
    lines.push(`uncertain: ${snapshot.uncertain}`)
  }
  appendFailedEntryLines(lines, 'l2_failed 最近条目:', snapshot.l2FailedEntries ?? [])
  // AC4：仅当真有失败条目时追加死信明细，没有失败时既有逐行输出逐字不变。
  appendFailedEntryLines(lines, 'failed 最近条目:', snapshot.failedEntries ?? [])
  // Story 3.3 / B4：开局注入的可见性（末尾追加，既有行逐字不动）。恒打印一行，
  // 让「Config 关闭」「从未注入」「已注入」三态都可断言；预算超限再追加一行（INV-2 提示）。
  lines.push(...renderInjectionStatusLines(snapshot))
  return lines.join('\n')
}

/** 注入状态行（Story 3.3 / B4；单位标注=字符，AC:935）。 */
function renderInjectionStatusLines(snapshot: MemoryStatusSnapshot): string[] {
  if (snapshot.injectionEnabled === false) {
    return ['injection: disabled（Config injectOnNewSession=false）']
  }
  const injection = snapshot.injection
  if (injection === null || injection === undefined) {
    return ['injection: 未知（本实例尚未触发开局注入）']
  }
  // 单位显式标注为字符（AC:935：tokens 化归 Story 8.5，不在本 story 内转换）。
  const marks = [
    injection.degraded ? '，降级' : '',
    injection.truncated ? '，已截断' : '',
  ].join('')
  const lines = [
    `injection: enabled（预算单位=字符；上次注入 ${injection.items} 条 / ${injection.chars} 字符${marks}）`,
  ]
  if (injection.overBudget) {
    lines.push('injection: 预算超限（不可删集合先保留）')
  }
  return lines
}

/** 构造 `/memory` 命令定义。纯工厂：不读 ctx、不持有 db。 */
export function createMemoryCommandDefinition(deps: MemoryCommandDependencies): MemoryCommandDefinition {
  return {
    name: MEMORY_COMMAND_NAME,
    description: '记录与浏览长期记忆（remember / list / show / status / recall / related / forget）',
    input: {
      hint: '/memory remember [--kind=..] [--priority=..] <内容> | list [关键词] | show <id> | status | recall <query> | related <id> [depth] | forget <id>',
    },
    handler: async (invocation): Promise<MemoryCommandResult> => {
      try {
        const parsed = parseMemoryCommand(invocation.rawInput)
        if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.usage }
        switch (parsed.kind) {
          case 'remember':
            await deps.writeInbox(parsed.text, parsed.classification)
            return { kind: 'success', text: `已记住：${parsed.text}` }
          case 'list': {
            const input = parsed.query === undefined
              ? { limit: MEMORY_LIST_DEFAULT_LIMIT }
              : { query: parsed.query, limit: MEMORY_LIST_DEFAULT_LIMIT }
            const entries = await deps.listMemories(input)
            return { kind: 'success', text: renderMemoryList(entries, parsed.query) }
          }
          case 'show': {
            const detail = await deps.getMemoryById(parsed.id)
            if (!detail) return { kind: 'error', text: `未找到 id 为 ${parsed.id} 的记忆。` }
            return { kind: 'success', text: renderMemoryDetail(detail) }
          }
          case 'status': {
            const snapshot = await deps.getStatus()
            return { kind: 'success', text: renderMemoryStatus(snapshot) }
          }
          case 'recall': {
            // 手动召回不计入 turn 配额（配额只作用于 memory_recall 工具面）；
            // 库未就绪/查询失败由 deps 抛错，下面的 catch 收敛为 error 结果。
            const result = await deps.recallMemories({ query: parsed.query, limit: MEMORY_RECALL_DEFAULT_LIMIT })
            return { kind: 'success', text: renderMemoryRecall(result) }
          }
          case 'related': {
            // 手动遍历同样不计入 turn 配额（与 recall 同口径）；depth 缺省由遍历层夹紧。
            const input = parsed.depth === undefined
              ? { id: parsed.id }
              : { id: parsed.id, depth: parsed.depth }
            const result = await deps.relatedMemories(input)
            return { kind: 'success', text: renderMemoryRelated(result) }
          }
          case 'forget': {
            // 手动遗忘不计入 turn 配额；库未就绪/只读/不存在由 deps 抛错，下面的 catch
            // 收敛为 error 结果（`memory_not_found` 的文案与 `show` 逐字一致）。
            const result = await deps.forgetMemory(parsed.id)
            return { kind: 'success', text: renderMemoryForget(result) }
          }
        }
      } catch (error) {
        return { kind: 'error', text: errorText(error) }
      }
    },
  }
}

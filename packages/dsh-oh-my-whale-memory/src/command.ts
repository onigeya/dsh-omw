/**
 * `/memory` 宿主命令（Story 1.7 `remember` / Story 1.8 `list` + `show` / Story 1.9 `status`）。
 *
 * 命令定义是可脱离宿主单测的纯工厂：解析与错误收敛不依赖 ctx。handler 只读
 * `invocation.rawInput`，把任何读/写库异常收敛为 `{ kind: 'error', text }`——命令
 * 永不抛出（宿主契约：thrown handler 会以 `kind: 'error'` 收尾，见 commands.md:172）。
 *
 * 四个子命令共用一个 definition（`ctx.commands.register` 仍只有一处）：
 * - `remember [--kind=..] [--priority=..] <内容>`：写入 L1（Story 1.7 + 1.11 层收敛）；
 * - `list [关键词]`：最近的记忆（文本包含匹配、`recorded_at` 倒序、默认 20 条）；
 * - `show <id>`：一条记忆的完整字段（含已失效墓碑——「列表隐藏、详情可见」是有意的）；
 * - `status`：层计数 + failed + embedding 降级 + 只读降级（Story 1.9，无参、纯读、无 LLM/网络）。
 *
 * `list [关键词]` 是**字面包含匹配**（两侧小写化），不是语义检索 / 向量 / FTS / RRF；
 * 过滤、排序、截断都由 db 层在库侧完成，命令层只做渲染。
 *
 * `@deepseek-ai/dsh-commands` 在本工作区不可解析，故这里只用本地结构化类型描述
 * 命令定义 / 调用 / 结果——运行时形态与宿主 `CommandDefinition` / `CommandInvocation` /
 * `CommandResult` 一致（D:\workspace\deepseek-harness\docs\subsystems\commands.md）。
 *
 * Story 1.11：`remember` 新增可选分类旗标 `--kind=<分类>` / `--priority=<整数>`
 * （FR-20 分类写路径，AC2——手动写路径也能产出非空 kind / 非 0 priority，含 -1）。
 */
import { MEMORY_KINDS } from './tools/memory-remember.js'

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

/**
 * `list` 默认返回条数。
 *
 * 无既有常量可复用（`src/config.ts` 无列表条数字段，PRD FR-14 / FR-11 也没给数字）；
 * 取 20 是与 FR-12 已存在的「结果上限 20 条」同量级，避免同一产品里 20/50 两种口径
 * 并存。**这是本 story 的取舍，不是 PRD 要求**（见 spec Design Notes）。
 */
export const MEMORY_LIST_DEFAULT_LIMIT = 20

/** `remember` 子命令 payload 缺失或旗标非法时的 usage 提示。 */
export const MEMORY_REMEMBER_USAGE = [
  '用法：/memory remember <内容>',
  '',
  '可选分类旗标：/memory remember [--kind=<分类>] [--priority=<整数>] <内容>',
  '分类（kind）取 ' + MEMORY_KINDS.join(' / ') + ' 之一；priority 取 -1..100，-1 = 全局强规则（恒置顶）。',
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

/**
 * `status` 子命令的 usage（spec 钉死值：`/memory status`）。
 *
 * `status` 无参数：解析到多余 payload 时返回本常量作为错误正文（不静默忽略输入），
 * 但**不回显**用户输入的 payload——错误正文恒为命令形态本身。
 */
export const MEMORY_STATUS_USAGE = '/memory status'

/** 未知 / 缺失子命令时的总用法（必须含 remember / list / show / status 四条）。 */
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
 * `/memory status` 的运行态快照（Story 1.9）。命令层不 import db 模块，形状在此镜像——
 * 计数事实源是 `memory` 表的 `layer` 列（db 层 `countMemoriesByLayer`）。
 *
 * `failed` 在 Epic 1 恒为 0：库内没有任何失败存储（`schema.ts` 只有 memory / l0_raw /
 * omw_meta），PRD 的条目状态机属 Epic 2 Story 2.2。本 story 只放占位，2.2 建队列后由
 * 真实计数替换——别把这个字段读成「系统健康」。
 */
export interface MemoryStatusSnapshot {
  /** L1 / L2 计数（按全部行聚合，不套失效过滤）。 */
  readonly layers: { readonly L1: number; readonly L2: number }
  /** 两路 INBOX 的排队量。 */
  readonly inboxes: { readonly L1: number; readonly L2: number }
  /** 失败条目计数（Story 2.2 起读 `l1_inbox` 的 failed 计数；表缺失照抛，不静默报 0）。 */
  readonly failed: number
  /**
   * 最近失败条目明细（最近 5 条，Story 2.2 / AC4）。空或缺省时**不追加任何行**，
   * 既有 status 逐行输出保持不变。
   */
  readonly failedEntries?: readonly MemoryFailedEntry[]
  /** embedding 可用性：endpoint / token / model 任一缺失即 'disabled'（降级检索）。 */
  readonly embeddingMode: 'enabled' | 'disabled'
  /**
   * System One 忠实性通道的状态（Story 2.5 / AC:674、U6）：
   * - `enabled`：配置开启且未运行态降级（核实走 System One）；
   * - `disabled-by-config`：`systemOne.enabled=false`，整体回落 ctx.llm 单次检查；
   * - `degraded`：端点持续不可达（连续失败达阈值），整体回落 ctx.llm 单次检查。
   */
  readonly systemOne: SystemOneStatusMode
  /**
   * 仍有效但**没有向量**的节点数（Story 2.4 / U5）：这些节点进不了 HNSW，对语义去重与
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
   * 绝不静默报 0，与 auditGap 同一约定）。仅 total > 0 或为 null 时追加渲染。
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
}

/**
 * System One 通道的状态枚举（Story 2.5 / U6）。命令层不 import db/distill 模块，
 * 故在此重复声明形状——与 `distill/system-one.ts` 的运行态槽语义必须一致。
 */
export type SystemOneStatusMode = 'enabled' | 'disabled-by-config' | 'degraded'

/**
 * 边侧差额计数（命令层镜像 `db/eii.ts` 的 `EvidenceGapSummary`）。命令层不 import db 模块，
 * 形状在此重复声明——两个字段名与语义必须与 db 侧一致（`eii.ts` 的 `EvidenceGapSummary`）。
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
 * `stale` 由读侧（src/index.ts 的 getStatus，24h 基准）判定——渲染层保持纯函数。
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
}

/** 解析结果：四个子命令分支，或「缺参 / 未知子命令」并给出对应 usage。 */
export type MemoryCommandParseResult =
  | { kind: 'remember', text: string, classification?: MemoryInboxWriteOptions }
  | { kind: 'list', query?: string }
  | { kind: 'show', id: string }
  | { kind: 'status' }
  | { kind: 'invalid', usage: string }

/** `--kind=` 旗标名（AC2：手动写路径产出非空分类）。 */
const MEMORY_REMEMBER_KIND_FLAG = '--kind='
/** `--priority=` 旗标名（AC2：手动写路径产出非零 priority，含 -1）。 */
const MEMORY_REMEMBER_PRIORITY_FLAG = '--priority='

/**
 * 旗标值的结束偏移：`flag` 之后首个**空白字符**（空格与制表符同等对待，与子命令切分
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
      if (!value) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
      kind = value
      rest = end === -1 ? '' : rest.slice(end).trim()
      continue
    }
    if (rest.startsWith(MEMORY_REMEMBER_PRIORITY_FLAG)) {
      const end = flagValueEnd(rest, MEMORY_REMEMBER_PRIORITY_FLAG)
      const raw = (end === -1 ? rest.slice(MEMORY_REMEMBER_PRIORITY_FLAG.length) : rest.slice(MEMORY_REMEMBER_PRIORITY_FLAG.length, end)).trim()
      if (!/^-?\d+$/.test(raw)) return { kind: 'invalid', usage: MEMORY_REMEMBER_USAGE }
      priority = Number(raw)
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
    default:
      return { kind: 'invalid', usage: MEMORY_COMMAND_USAGE }
  }
}

/** 异常转可读文本：Error 取 message，其它取字符串。绝不携带凭据（只含用法/字段名）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 列表摘要长度上限：超过则截断并加省略号（spec 钉死的输出格式）。 */
const MEMORY_LIST_SUMMARY_LIMIT = 60

/** 列表摘要：空白折叠为单空格并 trim，超 60 个 code point 截断加 `…`。 */
function summarizeMemoryText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const codePoints = [...collapsed]
  return codePoints.length > MEMORY_LIST_SUMMARY_LIMIT
    ? `${codePoints.slice(0, MEMORY_LIST_SUMMARY_LIMIT).join('')}…`
    : collapsed
}

/** 详情值占位：NULL / undefined / 空字符串统一渲染 `(空)`，绝不出现 `undefined`。 */
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
 * - 有命中的首行恒为 `记忆列表（共 N 条，最近优先）：`——spec 的「输出格式钉死（可断言）」
 *   枚举了列表首行的三种形态，其中不带关键词的变体，故不回显关键词；
 *   命中行本身都含该关键词（大小写不敏感匹配的后果），「成功文案含该关键词」由命中内容满足。
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
 * 故共用同一段渲染——两处都必须让 id/kind 过 `renderSingleLine`（值内换行会伪造出额外行，
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
 * 状态渲染（spec「输出格式钉死（可断言）」逐行照抄）：
 * 首行 `记忆状态`，其后固定顺序的 `键: 值` 行，计数为十进制。
 *
 * 非降级也显式打印 `embedding: enabled` 与 `readonly: false`——「不静默 no-op」要求降级
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
    `audit_gap: ${snapshot.auditGap ?? '未知（审计表缺失）'}`,
    snapshot.embeddingMode === 'disabled'
      ? 'embedding: disabled（降级检索）'
      : snapshot.unembedded > 0
        ? `embedding: enabled（未嵌入 ${snapshot.unembedded} 条）`
        : 'embedding: enabled',
    // Story 2.5 / U6：恒打印一行（与 embedding 行同一取向）——非降级也显式打印，
    // 让「配置关闭」与「运行态降级」两种降级都可断言，且不与 enabled 混淆。
    snapshot.systemOne === 'disabled-by-config'
      ? 'systemOne: disabled-by-config（已降级回 ctx.llm）'
      : snapshot.systemOne === 'degraded'
        ? 'systemOne: degraded（已降级回 ctx.llm）'
        : 'systemOne: enabled',
    snapshot.readonly ? `readonly: true, reason: '${snapshot.readonlyReason ?? ''}'` : 'readonly: false',
  ]
  // Story 2.6 / D7：边侧差额（EII + 漂移）与关系降级——都只在需要时追加，gap=0 时既有
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
  // Story 2.5 / 评审 P8：L2 死信与疑似失效账目——都只在**需要时**追加，0/缺省时既有
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
  // AC4：仅当真有失败条目时追加死信明细——没有失败时既有逐行输出逐字不变。
  appendFailedEntryLines(lines, 'failed 最近条目:', snapshot.failedEntries ?? [])
  return lines.join('\n')
}

/** 构造 `/memory` 命令定义。纯工厂：不读 ctx、不持有 db。 */
export function createMemoryCommandDefinition(deps: MemoryCommandDependencies): MemoryCommandDefinition {
  return {
    name: MEMORY_COMMAND_NAME,
    description: '记录与浏览长期记忆（remember / list / show / status）',
    input: { hint: '/memory remember [--kind=..] [--priority=..] <内容> | list [关键词] | show <id> | status' },
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
        }
      } catch (error) {
        return { kind: 'error', text: errorText(error) }
      }
    },
  }
}

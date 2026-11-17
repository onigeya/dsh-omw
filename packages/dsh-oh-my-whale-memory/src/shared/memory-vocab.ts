/**
 * 记忆词汇表：FR-15 七类分类（PRD prd.md:72 / prd.md:298，SPINE:274-275 的同名列枚举）
 * 与直写层。
 *
 * 放在 shared/ 而不是 tools/：这些取值是跨层的领域词汇，distill（精炼 prompt / 输出
 * schema 的 kind 值域、写库 layer）和 tools（工具参数 enum）都要用。由 tools 定义会让
 * distill import tools，与 tools → recall → distill 一起构成目录级环（AD-33）。
 * 本模块是纯常量叶子，不依赖包内任何其它目录。
 */

/**
 * User Portrait 分类的规范值（AD-38 / Story 11.4）。
 *
 * 语义是「用户画像」，与 Agent Persona Spec（`src/persona/contract.ts` 的
 * `omw-persona` section）不是同一件事：后者是 Agent 的自我身份，前者是用户是谁。
 * 分类值必须能一眼区分这两者，故规范值取 `user_portrait`。
 */
export const USER_PORTRAIT_KIND = 'user_portrait'

/**
 * 旧持久化值 / 旧输入别名（AD-38 legacy alias，Story 11.4）。
 *
 * 只允许出现在两个位置：
 * - **输入边界**：旧 CLI `--kind=persona`、旧工具/API 调用、旧模型输出，经
 *   {@link normalizeMemoryKind} 归一化为 {@link USER_PORTRAIT_KIND} 后才落库；
 * - **旧库只读**：未迁移的库（只读实例不迁移，AD-12）里的 `persona` 经
 *   {@link canonicalizeMemoryKind} 当作 `user_portrait` 读取。
 *
 * 不得作为新的分类值写回库。弃用截止版本与 semver 策略见
 * `_bmad-output/implementation-artifacts/adr-11-4-legacy-alias.md`（v2.0 移除）。
 */
export const LEGACY_USER_PORTRAIT_KIND = 'persona'

/**
 * 七类记忆分类。写路径（工具参数 / 命令旗标 / 精炼输出）的合法 kind 取值就是这个集合；
 * 缺省为空串（见 db/memory.ts 的 DEFAULT_MEMORY_KIND）。
 */
export const MEMORY_KINDS = [
  USER_PORTRAIT_KIND,
  'episodic',
  'instruction',
  'work_fact',
  'work_task',
  'work_method',
  'work_artifact',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * 是否是七类**规范值**之一（写路径参数 / 命令旗标的单一判据）。
 *
 * legacy 别名 `persona` 不算：输入边界必须先经 {@link normalizeMemoryKind}，
 * 否则「旧值也能通过校验」会让旧值重新变成合法分类（AD-38）。
 */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
}

/**
 * 输入边界的分类归一化（Story 11.4 / T1）：
 * - legacy `persona` → `user_portrait`（兼容期旧 CLI/API/模型输出）；
 * - 规范值原样返回；
 * - 其它（含缺省 / 空串 / 未知串）→ 空串，表示「未分类」，与既有缺省语义一致。
 *
 * 调用方拿空串时按各自语义处理：写路径落库空串（未分类），CLI/tool 视为参数错误。
 */
export function normalizeMemoryKind(value: unknown): MemoryKind | '' {
  if (value === LEGACY_USER_PORTRAIT_KIND) return USER_PORTRAIT_KIND
  return isMemoryKind(value) ? value : ''
}

/**
 * 存量值的归一：只把 legacy `persona` 改写成 `user_portrait`，其它字符串原样返回。
 *
 * 与 {@link normalizeMemoryKind} 的分工：本函数用于**写库前最后一道**与**读路径**。
 * `memory.kind` 还承载 `handle` 等非七类值（摘要句柄，见 context/handles.ts），
 * 那些值必须原样保留，不能像输入边界那样把未知值抹成空串。
 */
export function canonicalizeMemoryKind(value: string): string {
  return value === LEGACY_USER_PORTRAIT_KIND ? USER_PORTRAIT_KIND : value
}

/**
 * 逻辑身份判定：是否是 User Portrait 分类（规范值或 legacy 别名）。
 *
 * 用途是**读路径与冲突守卫**（旧库只读时持久化值仍是 `persona`），
 * 不能用于校验新输入——新输入用 {@link isMemoryKind}。
 */
export function isUserPortraitKind(value: unknown): boolean {
  return value === USER_PORTRAIT_KIND || value === LEGACY_USER_PORTRAIT_KIND
}

/**
 * priority 值域（-1 = 全局强规则/恒置顶，100 = 最高普通优先级）。
 *
 * 放在 shared/ 而不是 distill/llm-refine.ts：工具、命令与精炼三个写入口都要用同一组
 * 边界，由精炼侧导出会让命令层 import distill（AD-33 目录级环）。
 */
export const MEMORY_PRIORITY_MIN = -1
export const MEMORY_PRIORITY_MAX = 100

/** 是否是合法 priority（-1..100 的整数；非整数/越界/非有限一律 false）。 */
export function isMemoryPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= MEMORY_PRIORITY_MIN && value <= MEMORY_PRIORITY_MAX
}

/** 直写层：L1（写入即 L1 原子记忆；INBOX 分拣是另一条流水线，layer 取值仍收敛为 'L1'）。 */
export const MEMORY_REMEMBER_LAYER = 'L1'

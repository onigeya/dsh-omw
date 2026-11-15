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
 * 七类记忆分类。写路径（工具参数 / 命令旗标 / 精炼输出）的合法 kind 取值就是这个集合；
 * 缺省为空串（见 db/memory.ts 的 DEFAULT_MEMORY_KIND）。
 */
export const MEMORY_KINDS = [
  'persona',
  'episodic',
  'instruction',
  'work_fact',
  'work_task',
  'work_method',
  'work_artifact',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 是否是七类分类之一（写路径参数 / 命令旗标的单一判据）。 */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
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

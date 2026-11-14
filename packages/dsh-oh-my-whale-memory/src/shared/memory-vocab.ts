/**
 * 记忆词汇表：FR-15 七类分类（PRD prd.md:72 / prd.md:298，SPINE:274-275 的同名列枚举）
 * 与直写层。
 *
 * 放在 shared/ 而不是 tools/：这些取值是跨层的**领域词汇**，distill（精炼 prompt / 输出
 * schema 的 kind 值域、写库 layer）和 tools（工具参数 enum）都要用；由 tools 定义会让
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

/** 直写层：L1（写入即 L1 原子记忆；INBOX 分拣是另一条流水线，layer 取值仍收敛为 'L1'）。 */
export const MEMORY_REMEMBER_LAYER = 'L1'

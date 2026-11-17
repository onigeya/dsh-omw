/**
 * 注入面的跨层词表（Story 8.5 / T3-T4、AD-2、INV-1）。
 *
 * 两个模块要用同一个字符串：
 * - `injection/skeleton.ts` 注册 `ctx.systemPrompt.context()` 的动态骨架；
 * - `context/compaction-t1.ts` 在压缩判据里把「骨架消息」当受保护内容。
 *
 * 放 `shared/`（与 `memory-vocab.ts` 同一思路）：让 `context`（domain）不必 import
 * `injection`（装配层），也避免两边各写一份字面量后悄悄漂移。
 */

/**
 * 动态骨架的 context 名。
 * **必须与静态 section `omw-memory` 不同**（AD-2/AD-23：静态 section 的 text 只能是常量）。
 */
export const SKELETON_CONTEXT_NAME = 'omw-memory-dynamic'

/**
 * 骨架消息的来源标签：宿主若把该 context 物化成消息，`source.kind` 取本值。
 * 与实际物化机制无关地先钉住判据——这样「骨架被折掉」在任何装配形态下都是 T1（受保护）。
 */
export const SKELETON_SOURCE_KIND = SKELETON_CONTEXT_NAME

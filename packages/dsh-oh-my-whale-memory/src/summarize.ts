/**
 * 记忆文本摘要（列表 `/memory list` 与召回 `memory_recall` / `/memory recall` 共用）。
 *
 * 纯函数、无依赖：既给命令层（不 import db 模块）用，也给工具 presenter 用，
 * 避免两处各写一份截断规则（历史：Story 1.8 的列表摘要与 Story 3.1 的召回摘要同形）。
 */

/** 摘要长度上限（code point 计）：超过则截断并加 `…`。 */
export const MEMORY_SUMMARY_LIMIT = 60

/** 摘要：空白折叠为单空格并 trim，超上限按 code point 截断加 `…`（不劈代理对）。 */
export function summarizeMemoryText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const codePoints = [...collapsed]
  return codePoints.length > MEMORY_SUMMARY_LIMIT
    ? `${codePoints.slice(0, MEMORY_SUMMARY_LIMIT).join('')}…`
    : collapsed
}

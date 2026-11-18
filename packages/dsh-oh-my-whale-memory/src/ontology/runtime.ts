/**
 * 词表 prompt 块的进程内交接（Story 9.2 / AD-40、AD-23）。
 *
 * 为什么需要它：本体在 `apply` 时加载一次，而精炼 prompt 在 `distill/llm-refine.ts` 的
 * 纯函数里组装；把 block 一路穿参会污染多个签名。这里用模块级单值（与 handle-writer /
 * compaction-plan 注册表同一纪律）：
 * - `apply` 成功后 `setOntologyPromptBlock(block)`；未配置/off ⇒ `null`（不插入任何文本）；
 * - teardown `setOntologyPromptBlock(null)`（下一实例重新登记，不继承）；
 * - 只读实例也会加载（只读、无写），但不会触发精炼。
 */
let promptBlock: string | null = null

export function setOntologyPromptBlock(block: string | null): void {
  promptBlock = block
}

export function getOntologyPromptBlock(): string | null {
  return promptBlock
}

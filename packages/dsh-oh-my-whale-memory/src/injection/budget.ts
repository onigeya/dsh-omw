/**
 * 开局注入的**预算裁剪**（Story 3.3 / B3 / AC:932-935 · FR-9）：全仓唯一的注入裁剪点。
 *
 * 裁剪顺序（AC:932-935，优先级从高到低）：
 * 1. **单条正文 ≤1200 字符**先裁（摘要句与引用证据同口径，截断标 `…`）；
 * 2. **条数 ≤20**（按分数序逐条累加；不可删集合不占这 20 个名额）；
 * 3. **总长 ≤8000 字符**（摘要 + 引用证据合计；命中即停止追加）；
 * 4. 截断后**剩余正文 <40 字符**的条目不注入（不产生碎片行）。
 *
 * **不可删集合（INV-2）**：`priority === -1` 或 `kind === 'instruction'` 先全部保留，
 * 不受单条/条数/总长裁剪；若因此超预算 ⇒ `overBudget: true`（由 status/观测标注）。
 *
 * 纯函数：无 I/O、无时钟、无随机；provider 只读最终文本（不裁剪）。
 */
import type { RecallResultItem } from '../recall/core.js'

/** 单条正文上限（AC:934：单条 ≤1200 字符）。 */
export const INJECTION_MAX_ITEM_CHARS = 1200
/** 可删条目数上限（AC:934：条数 ≤20；不可删集合不占名额）。 */
export const INJECTION_MAX_ITEMS = 20
/** 总长上限（AC:934：摘要 + 引用证据合计 ≤8000 字符）。 */
export const INJECTION_MAX_TOTAL_CHARS = 8000
/** 截断后剩余正文低于此值则整条不注入（AC:934：<40 字符不产生碎片行）。 */
export const INJECTION_MIN_ITEM_CHARS = 40
/** 截断标记（AC:934：截断项标 `…`）。 */
export const INJECTION_ELLIPSIS = '…'

/** 结构化注入草稿（生成期产出；预算裁剪的唯一输入）。 */
export interface InjectionDraft {
  /** 摘要句（原则段）；L1-only 降级时缺省。 */
  readonly summary?: string
  /** 引用的 L2/L1 证据（不含不可删集合成员）。 */
  readonly evidence: readonly RecallResultItem[]
  /** 仅 L1 降级时注入的 L1 原文（不含不可删集合成员）。 */
  readonly l1: readonly RecallResultItem[]
  /** 不可删集合（INV-2）：`priority === -1` 或 `kind === 'instruction'`。 */
  readonly inviolable: readonly RecallResultItem[]
}

/** 预算结果里的单条记录（供观测/测试；text 为最终渲染正文）。 */
export interface InjectionBudgetItem {
  readonly id: string
  readonly layer: string
  readonly text: string
  readonly truncated: boolean
  readonly inviolable: boolean
}

export interface InjectionBudgetResult {
  /** 最终注入文本（空串 = 零注入）。 */
  readonly text: string
  readonly items: readonly InjectionBudgetItem[]
  /** 计入预算的正文总字符数（摘要 + 引用证据；标题/前缀不计）。 */
  readonly chars: number
  /** 是否发生过任何截断/丢弃。 */
  readonly truncated: boolean
  /** 不可删集合导致（或最终文本）超预算。 */
  readonly overBudget: boolean
  /** 实际保留的不可删集合成员数。 */
  readonly keptInviolable: number
}

/** INV-2 判据：全局强规则或指令类记忆不可删。 */
export function isInviolableItem(item: RecallResultItem): boolean {
  return item.priority === -1 || item.kind === 'instruction'
}

/** 按 code point 截断正文（最多 maxChars；超限加 `…`，总长含省略号 ≤ maxChars）。 */
function truncateBody(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const body = [...text].slice(0, Math.max(0, maxChars - 1)).join('')
  return { text: body + INJECTION_ELLIPSIS, truncated: true }
}

/** 去重（同 id 只留第一次出现，保持给定顺序）。 */
function dedupeById(items: readonly RecallResultItem[]): RecallResultItem[] {
  const seen = new Set<string>()
  const out: RecallResultItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * 应用三限制并渲染最终注入文本。顺序：不可删集合（先，保证永远在场）→ 摘要 →
 * evidence → l1；同一 id 只出现一次（不可删集合优先占位）。
 */
export function applyInjectionBudget(draft: InjectionDraft): InjectionBudgetResult {
  const renderLine = (item: { layer: string; id: string; text: string }): string => `- [${item.layer}] ${item.id}: ${item.text}`
  let truncated = false
  let chars = 0

  // ---- 1) 不可删集合：不裁剪、不占名额；单独统计字符用于 overBudget ----
  const inviolable = dedupeById(draft.inviolable)
  const keptInviolableItems: InjectionBudgetItem[] = inviolable.map((item) => ({
    id: item.id,
    layer: item.layer,
    text: item.text,
    truncated: false,
    inviolable: true,
  }))
  const inviolableChars = keptInviolableItems.reduce((sum, item) => sum + item.text.length, 0)
  const inviolableIds = new Set(inviolable.map((item) => item.id))

  // ---- 2) 可删候选：摘要 → evidence → l1（去重、去掉已在不可删集合里的 id） ----
  const candidates: Array<{ id: string; layer: string; text: string }> = []
  const summary = draft.summary?.trim()
  if (summary !== undefined && summary !== '') candidates.push({ id: 'summary', layer: 'summary', text: summary })
  for (const item of dedupeById([...draft.evidence, ...draft.l1])) {
    if (inviolableIds.has(item.id)) continue
    candidates.push({ id: item.id, layer: item.layer, text: item.text })
  }

  // 可用总字符：不可删集合先占额度；已被占满则剩余 0（仍有条目则 overBudget）。
  const availableChars = Math.max(0, INJECTION_MAX_TOTAL_CHARS - inviolableChars)
  const keptDeletable: InjectionBudgetItem[] = []
  for (const candidate of candidates) {
    if (keptDeletable.length >= INJECTION_MAX_ITEMS) {
      truncated = true
      break
    }
    // ① 单条 ≤1200 字符先裁
    const perItem = truncateBody(candidate.text, INJECTION_MAX_ITEM_CHARS)
    if (perItem.truncated) truncated = true
    // ③ 总长：剩余额度内再裁；剩余 <40 字符时不产生碎片行（停止追加未入列条目）
    const remaining = availableChars - chars
    if (perItem.text.length > remaining) {
      if (remaining < INJECTION_MIN_ITEM_CHARS) {
        truncated = true
        break
      }
      const fitted = truncateBody(perItem.text, remaining)
      truncated = true
      keptDeletable.push({
        id: candidate.id,
        layer: candidate.layer,
        text: fitted.text,
        truncated: true,
        inviolable: false,
      })
      chars += fitted.text.length
      continue
    }
    keptDeletable.push({
      id: candidate.id,
      layer: candidate.layer,
      text: perItem.text,
      truncated: perItem.truncated,
      inviolable: false,
    })
    chars += perItem.text.length
  }

  const finalChars = chars + inviolableChars
  const overBudget = finalChars > INJECTION_MAX_TOTAL_CHARS

  // ---- 3) 渲染：原则开头（摘要）→ 证据跟随；不可删集合排在最前（硬规则先被看到） ----
  const lines: string[] = []
  const summaryItem = keptDeletable.find((item) => item.id === 'summary')
  if (summaryItem !== undefined) {
    lines.push('记忆摘要（开局注入）：', summaryItem.text)
    const evidenceLines = [
      ...keptInviolableItems,
      ...keptDeletable.filter((item) => item.id !== 'summary'),
    ]
    if (evidenceLines.length > 0) {
      lines.push('', '相关证据：')
      for (const item of evidenceLines) lines.push(renderLine(item))
    }
  } else {
    lines.push('相关记忆（开局注入）：')
    for (const item of keptInviolableItems) lines.push(renderLine(item))
    for (const item of keptDeletable) lines.push(renderLine(item))
  }

  // items = 最终注入的条目（不含摘要句本身；chars 含摘要正文）。
  const items = [...keptInviolableItems, ...keptDeletable.filter((item) => item.id !== 'summary')]
  // 零注入：既无摘要也无任何条目 ⇒ 空文本（宿主对空文本不产消息；调用方据此跳过）。
  if (summaryItem === undefined && items.length === 0) {
    return {
      text: '',
      items,
      chars: 0,
      truncated,
      overBudget: false,
      keptInviolable: 0,
    }
  }
  return {
    text: lines.join('\n'),
    items,
    chars: finalChars,
    truncated,
    overBudget,
    keptInviolable: keptInviolableItems.length,
  }
}

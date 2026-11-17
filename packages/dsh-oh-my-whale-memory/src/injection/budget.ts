/**
 * 开局注入的预算裁剪（Story 3.3 / B3 / AC:932-935 · FR-9；Story 8.5 / T2 改为 tokens 口径）。
 *
 * **全仓唯一的注入裁剪点**，单位一律 tokens（AD-25 / AC:1801「字符口径随本 story 退役」）：
 * 额度由 {@link computeInjectionBudget}（`recall/injection-budget.ts`）算出，本模块只负责
 * 「按额度裁 + 渲染」，不自己拍数字。
 *
 * 裁剪顺序（AC:932-935，优先级从高到低）：
 * 1. 摘要正文 ≤ `summaryCap`（绝对上限）、单条正文 ≤ `singleCap`（绝对上限），超限标 `…`；
 * 2. 条数 ≤20（按分数序逐条累加；不可删集合不占这 20 个名额）；
 * 3. 正文总 tokens ≤ `budget`（摘要 + 引用证据合计；命中即停止追加）；
 * 4. 裁完剩余正文 < {@link INJECTION_MIN_ITEM_TOKENS} 的条目不注入（不产生碎片行）。
 *
 * 不可删集合（INV-2）：`priority === -1` 或 `kind === 'instruction'` 先全部保留，
 * 不受单条/条数/总长裁剪；若因此超预算则 `overBudget: true`（由 status/观测标注）。
 *
 * 纯函数：无 I/O、无时钟、无随机；provider 只读最终文本（不裁剪）。
 */
import { MEMORY_CONFIG_DEFAULTS } from '../config.js'
import type { RecallResultItem } from '../recall/core.js'
import {
  INJECTION_ELLIPSIS,
  truncateToTokenCap,
  type InjectionTokenBudget,
} from '../recall/injection-budget.js'
import { estimateTokens } from '../shared/text-budget.js'

export { INJECTION_ELLIPSIS }

/** 可删条目数上限（AC:934：条数 ≤20；不可删集合不占名额）。 */
export const INJECTION_MAX_ITEMS = 20
/**
 * 裁完剩余正文低于此值则整条不注入（AC:934 的「<40 字符不产生碎片行」在 tokens 口径下的
 * 落地值；**经验值**：4 tokens 已短到不构成一条可读事实）。
 */
export const INJECTION_MIN_ITEM_TOKENS = 4

/** 一次裁剪的三个额度（全部来自 Config；缺省与 schema 同源，不另写数字）。 */
export interface InjectionBudgetCaps {
  /** 正文总额度（tokens）。 */
  readonly budget: number
  /** 单条正文绝对上限（tokens）。 */
  readonly singleCap: number
  /** 摘要正文绝对上限（tokens）。 */
  readonly summaryCap: number
}

/** 缺省额度（Config 默认值；`injectionRatio` 需要窗口，故未配置时 budget 走 `injectionTokenCap`）。 */
export const DEFAULT_INJECTION_BUDGET_CAPS: InjectionBudgetCaps = {
  budget: MEMORY_CONFIG_DEFAULTS.injectionTokenCap,
  singleCap: MEMORY_CONFIG_DEFAULTS.injectionSingleCap,
  summaryCap: MEMORY_CONFIG_DEFAULTS.injectionSummaryCap,
}

/** 缺省额度 + 空告警（调用方拿不到窗口/压力时的保守形态，满足 {@link InjectionTokenBudget}）。 */
export const DEFAULT_INJECTION_BUDGET_RESULT: InjectionTokenBudget = {
  ...DEFAULT_INJECTION_BUDGET_CAPS,
  warnings: [],
}

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
  /** 计入预算的正文总 tokens（摘要 + 引用证据；标题/前缀不计）。 */
  readonly tokens: number
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
export function applyInjectionBudget(
  draft: InjectionDraft,
  caps: InjectionBudgetCaps = DEFAULT_INJECTION_BUDGET_CAPS,
): InjectionBudgetResult {
  const renderLine = (item: { layer: string; id: string; text: string }): string => `- [${item.layer}] ${item.id}: ${item.text}`
  const capBudget = Number.isFinite(caps.budget) && caps.budget > 0 ? Math.trunc(caps.budget) : 0
  let truncated = false
  let tokens = 0

  // 1) 不可删集合：不裁剪、不占名额；单独统计 tokens 用于 overBudget
  const inviolable = dedupeById(draft.inviolable)
  const keptInviolableItems: InjectionBudgetItem[] = inviolable.map((item) => ({
    id: item.id,
    layer: item.layer,
    text: item.text,
    truncated: false,
    inviolable: true,
  }))
  const inviolableTokens = keptInviolableItems.reduce((sum, item) => sum + estimateTokens(item.text), 0)
  const inviolableIds = new Set(inviolable.map((item) => item.id))

  // 2) 可删候选：摘要 → evidence → l1（去重、去掉已在不可删集合里的 id）
  const candidates: Array<{ id: string; layer: string; text: string; cap: number }> = []
  const summary = draft.summary?.trim()
  if (summary !== undefined && summary !== '') {
    candidates.push({ id: 'summary', layer: 'summary', text: summary, cap: caps.summaryCap })
  }
  for (const item of dedupeById([...draft.evidence, ...draft.l1])) {
    if (inviolableIds.has(item.id)) continue
    candidates.push({ id: item.id, layer: item.layer, text: item.text, cap: caps.singleCap })
  }

  // 可用总 tokens：不可删集合先占额度；已被占满则剩余 0（仍有条目则 overBudget）。
  const availableTokens = Math.max(0, capBudget - inviolableTokens)
  const keptDeletable: InjectionBudgetItem[] = []
  for (const candidate of candidates) {
    if (keptDeletable.length >= INJECTION_MAX_ITEMS) {
      truncated = true
      break
    }
    // ① 摘要 / 单条各自的绝对上限先裁
    const perItem = truncateToTokenCap(candidate.text, candidate.cap)
    if (perItem.truncated) truncated = true
    // 额度为 0（或上限小于一个字）⇒ 本条没有可读正文，不产出空行条目，直接停止。
    if (perItem.text === '') {
      truncated = true
      break
    }
    // ③ 总预算：剩余额度内再裁；剩余 < 最小值时不产生碎片行（停止追加未入列条目）
    const remaining = availableTokens - tokens
    const itemTokens = estimateTokens(perItem.text)
    if (itemTokens > remaining) {
      if (remaining < INJECTION_MIN_ITEM_TOKENS) {
        truncated = true
        break
      }
      const fitted = truncateToTokenCap(perItem.text, remaining)
      truncated = true
      if (fitted.text !== '') {
        keptDeletable.push({
          id: candidate.id,
          layer: candidate.layer,
          text: fitted.text,
          truncated: true,
          inviolable: false,
        })
        tokens += estimateTokens(fitted.text)
      }
      continue
    }
    keptDeletable.push({
      id: candidate.id,
      layer: candidate.layer,
      text: perItem.text,
      truncated: perItem.truncated,
      inviolable: false,
    })
    tokens += itemTokens
  }

  const finalTokens = tokens + inviolableTokens
  const overBudget = finalTokens > capBudget

  // 3) 渲染：原则开头（摘要）→ 证据跟随；不可删集合排在最前（硬规则先被看到）
  const lines: string[] = []
  const summaryItem = keptDeletable.find((item) => item.id === 'summary')
  // items = 最终注入的条目（不含摘要句本身）；tokens 仍含摘要正文。
  const items = [...keptInviolableItems, ...keptDeletable.filter((item) => item.id !== 'summary')]
  if (summaryItem !== undefined) {
    lines.push('记忆摘要（开局注入）：', summaryItem.text)
    if (items.length > 0) {
      lines.push('', '相关证据：')
      for (const item of items) lines.push(renderLine(item))
    }
  } else {
    lines.push('相关记忆（开局注入）：')
    for (const item of items) lines.push(renderLine(item))
  }

  // 零注入：既无摘要也无任何条目 ⇒ 空文本（宿主对空文本不产消息；调用方据此跳过）。
  if (summaryItem === undefined && items.length === 0) {
    return {
      text: '',
      items,
      tokens: 0,
      truncated,
      overBudget: false,
      keptInviolable: 0,
    }
  }
  return {
    text: lines.join('\n'),
    items,
    tokens: finalTokens,
    truncated,
    overBudget,
    keptInviolable: keptInviolableItems.length,
  }
}

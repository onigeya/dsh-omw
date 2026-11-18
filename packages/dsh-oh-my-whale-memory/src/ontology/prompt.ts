/**
 * 本体词表渲染（Story 9.2 / AD-40、FR-33）。
 *
 * **判定用全量、渲染用确定性裁剪子集**（AD-40 的核心分离）：
 * - 输入是全量 `OntologyEntry[]`（来自解析），输出是 prompt 里的一个固定块；
 * - 裁剪键：allowlist（IRI）优先 → `omw:priority` 降序 → IRI 字典序升序；
 * - 预算：`promptCharBudget`（默认 4000 字符），**整条丢弃**（不截断条目内部）；
 * - 未配置/关闭/空 ⇒ `null`（调用方不插入任何文本，抽取 prompt 与启用前逐字节一致）。
 *
 * 纯函数：无 I/O、无时钟、随机、哈希；同一输入两次渲染字节相同（INV-17 / AD-40）。
 */
import type { OntologyEntry } from './turtle.js'

/** 固定块头（常量；改它必须同步测试与 prompt 版本说明）。 */
export const ONTOLOGY_PROMPT_HEADER = '本体词表（判定用全量，渲染用裁剪子集）：'

export interface OntologyPromptConfig {
  /**
   * 闸门档位（矩阵行 10 / epics:1987-1989）：`off` ⇒ 不渲染词表块，即使配置了 `ontology.path`。
   * 缺省（undefined）= 不按档位过滤（纯渲染用例 / 单测直接调用的形态）。
   */
  readonly level?: 'off' | 'align' | 'strict'
  /** 显式 allowlist（IRI）；非空时只渲染命中项。 */
  readonly promptTypes?: readonly string[]
  readonly promptRelations?: readonly string[]
  /** 渲染字符预算（绝对上限，AD-8 字符域）；默认 4000。 */
  readonly promptCharBudget?: number
}

export const DEFAULT_ONTOLOGY_PROMPT_CHAR_BUDGET = 4000

/** 渲染一行（固定形态：`- <kind> <IRI> <label> [domain -> range]`）。 */
function renderEntryLine(entry: OntologyEntry): string {
  const kind = entry.kind === 'entity' ? 'type' : 'relation'
  const shape = entry.kind === 'entity'
    ? ''
    : ' [' + (entry.domain.length > 0 ? entry.domain.join('|') : '*') + ' -> ' +
      (entry.range.length > 0 ? entry.range.join('|') : '*') + ']'
  return '- ' + kind + ' ' + entry.iri + ' ' + entry.label + shape
}

function compareEntries(left: OntologyEntry, right: OntologyEntry): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  if (left.iri !== right.iri) return left.iri < right.iri ? -1 : 1
  return 0
}

/**
 * 渲染词表块；返回 `null` 表示不插入（off / 未配置 / 空）。
 *
 * @param entries 全量条目（解析产物）
 * @param config allowlist 与预算
 */
export function renderOntologyPrompt(
  entries: readonly OntologyEntry[],
  config: OntologyPromptConfig = {},
): string | null {
  // 矩阵行 10 / epics:1987-1989：档位 off ⇒ 抽取 prompt 与启用前**字节级一致**，
  // 即使配置了 ontology.path（本体照常加载给判定/status 用，只是不注入词表）。
  if (config.level === 'off') return null
  if (entries.length === 0) return null
  const budget = Number.isFinite(config.promptCharBudget) && (config.promptCharBudget as number) > 0
    ? Math.trunc(config.promptCharBudget as number)
    : DEFAULT_ONTOLOGY_PROMPT_CHAR_BUDGET
  const typeAllow = new Set((config.promptTypes ?? []).map((value) => value.trim()).filter((value) => value.length > 0))
  const relationAllow = new Set((config.promptRelations ?? []).map((value) => value.trim()).filter((value) => value.length > 0))
  const allowActive = typeAllow.size > 0 || relationAllow.size > 0
  const selected = entries
    .filter((entry) => {
      if (!allowActive) return true
      return entry.kind === 'entity' ? typeAllow.has(entry.iri) : relationAllow.has(entry.iri)
    })
    .slice()
    .sort(compareEntries)

  const lines: string[] = []
  let used = ONTOLOGY_PROMPT_HEADER.length
  for (const entry of selected) {
    const line = renderEntryLine(entry)
    const cost = line.length + 1 // 含换行
    if (used + cost > budget) break // 整条丢弃；按排序继续看下一条更短的也不行（保持确定性顺序）
    lines.push(line)
    used += cost
  }
  if (lines.length === 0) return null
  return ONTOLOGY_PROMPT_HEADER + '\n' + lines.join('\n')
}

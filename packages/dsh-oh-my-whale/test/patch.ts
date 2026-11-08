/**
 * `cordis.patch.yml` 的共享解析器（Story 1.2 测试基础设施）。
 *
 * 两个安装期契约测试都要读同一份 patch 清单，因此解析只实现一次——两份手写
 * 解析器曾经漂移，且各自漏掉结构约束（override 键串进 insert、嵌套 `config:`
 * 下的 `name:` 被误认成模块名）。这里把「结构」显式建模：
 *
 * - 顶层项只能是 `- insert:` 或 `- override:`（宿主 patch 层的两种语义，
 *   publish.md:56-62 / L131-134）。遇到新的顶层项立即结束上一项，其后的键
 *   不会串进上一项。
 * - 一项内的插件行是列表项 `- <key>: ...`；每个列表项开启一条新行，同一项下
 *   可以有多行，互不覆盖。
 * - 行的续写键（`name:` / `config:` 等）必须与行键同缩进层。更深缩进的键属于
 *   上一键的嵌套值（例如 `config:` 下的 `name:`），一律忽略——这是误报来源。
 * - 只收集 `id` / `name` / `config` 三个键；`disabled` 等运行时键开启行但值不收。
 *
 * 刻意不引入 `yaml` 依赖：spec 明确禁止（PRD §14:473 的 constraints 门禁在
 * 后续 story，本 story 不为解析两行 YAML 增加依赖树）。
 */

/** 单个插件行的契约相关键。`config` 只要出现在行上就算违规（见 install-contract）。 */
export interface PatchRow {
  id?: string
  name?: string
  config?: string
}

/** 顶层 patch 项：`- insert:` / `- override:`，各含零或多行。 */
export interface PatchEntry {
  kind: 'insert' | 'override'
  rows: PatchRow[]
}

const CONTRACT_KEYS = new Set(['id', 'name', 'config'])

/** 去掉包裹的单/双引号（YAML 标量引号不参与语义）。 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 解析 patch 清单为结构化条目。
 *
 * @param raw - `cordis.patch.yml` 全文。
 * @returns 顶层项数组，顺序与文件一致。空行与 `#` 注释行先被剔除。
 */
export function parsePatch(raw: string): PatchEntry[] {
  const lines = raw
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))

  const entries: PatchEntry[] = []
  let entry: PatchEntry | undefined
  /** 当前行的键缩进（列号）；续写键必须恰好落在此列。 */
  let rowKeyIndent: number | null = null

  for (const line of lines) {
    const top = /^- (insert|override):\s*$/.exec(line)
    if (top) {
      entry = { kind: top[1] as 'insert' | 'override', rows: [] }
      entries.push(entry)
      rowKeyIndent = null
      continue
    }
    // 其他顶层项（如 `- id: x` 直写形态）：本契约不建模其内容，且必须结束
    // 上一项，避免其键被错误归入前一个 insert/override 块。
    if (/^- /.test(line)) {
      entry = undefined
      rowKeyIndent = null
      continue
    }
    if (!entry) continue

    // 列表项 `- <key>: value`：开启一条新行，永不覆盖已有行。
    const item = /^(\s+)- (\w+):\s*(.*)$/.exec(line)
    if (item) {
      const row: PatchRow = {}
      entry.rows.push(row)
      rowKeyIndent = item[1].length + 2
      const key = item[2]
      if (CONTRACT_KEYS.has(key)) {
        row[key as keyof PatchRow] = unquote(item[3])
      }
      continue
    }

    // 无 dash 的续写键：只有与行键同缩进层的才属于本行。
    const kv = /^(\s+)(\w+):\s*(.*)$/.exec(line)
    if (kv) {
      const indent = kv[1].length
      // 更深缩进 = 上一键的嵌套值（如 config 内部的 name）→ 忽略。
      if (indent !== rowKeyIndent) continue
      const key = kv[2]
      if (!CONTRACT_KEYS.has(key)) continue
      const current = entry.rows[entry.rows.length - 1]
      if (!current) continue
      current[key as keyof PatchRow] = unquote(kv[3])
    }
  }

  return entries
}

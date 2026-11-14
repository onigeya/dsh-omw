/**
 * 文本 token 估算与按预算切分（纯函数，无依赖）。
 *
 * 放在 shared/ 而不是 distill/：召回（recall）与精炼（distill）共用同一套估算/切分规则，
 * 由 distill 定义会让 recall import distill，与 distill → tools → recall 一起构成目录级环
 * （AD-33）。本模块只做本地收敛估算，不做计费。
 */

/** CJK 字符区间（含中日韩标点），每个算 1 token。 */
const CJK_PATTERN = /[\u2E80-\u303F\u3040-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u

/** 句末符：优先后切在这些位置，避免把句子劈开。 */
const SENTENCE_END_PATTERN = /[。！？!?；;\n]/u

/**
 * 极简 token 估算：CJK 每字符算 1 token，其余按空白切词、每词再按字符长度折算
 * （约 4 字符 1 token，评审 T15：URL/hash/base64/压缩 JSON 这类无空白长串原先只算 1 token，
 * 会让「每条 ≤150 token」在它们身上失效）。只用于本地收敛，不做计费。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let rest = ''
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk += 1
    else rest += ch
  }
  const words = rest.split(/\s+/u).filter((word) => word.length > 0)
  const restChars = words.reduce((total, word) => total + word.length, 0)
  // 下限取词数（短词至少 1 token），上限按字符数/4（长 URL/hash 不会只算 1 token）。
  return cjk + Math.max(words.length, Math.ceil(restChars / 4))
}

/**
 * 把一段超预算文本切成 ≤budget token 的连续片段：优先在句末切，单句超预算则按字符硬切。
 * 各片段**分别 trim 后按原顺序拼接**（不等于原文逐字，首尾空白会被吃掉，评审 T16）。
 *
 * budget 必填：不同调用方的预算是各自的业务常量（精炼 150 / 召回文本预算），
 * 本模块不替调用方挑缺省值。
 */
export function splitToBudget(text: string, budget: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (estimateTokens(trimmed) <= budget) return [trimmed]
  const pieces: string[] = []
  let start = 0
  let lastBreak = 0
  let cursor = 0
  for (const ch of trimmed) {
    const before = cursor
    cursor += ch.length
    if (SENTENCE_END_PATTERN.test(ch)) lastBreak = cursor
    if (estimateTokens(trimmed.slice(start, cursor)) <= budget) continue
    // lastBreak === cursor 表示「当前字符恰是句末符」：切在它之前，否则这一片会多含该符号
    // （评审 T14：'甲'.repeat(150) + '。' 会切出 151 token 的片段）。
    const cut = lastBreak > start && lastBreak < cursor
      ? lastBreak
      : before > start ? before : cursor
    const piece = trimmed.slice(start, cut).trim()
    if (piece.length > 0) pieces.push(piece)
    start = cut
    lastBreak = start
  }
  const tail = trimmed.slice(start).trim()
  if (tail.length > 0) pieces.push(tail)
  return pieces
}

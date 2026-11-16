/**
 * 折叠句柄的格式与解析（Story 8.2 / FR-23、AC:1607-1614）。
 *
 * 表面里只留 `[omw:handle=<id> ~<n> tokens]`；`memory_expand(handle)` 用它换回逐字原文（NFR18）。
 *
 * 纯函数：生成与解析都不碰库、不碰时钟，因此可以钉死边界（负数、超大 n、前后空白、多个句柄）。
 */

/** 表面句柄块的正则：非贪婪，只取**第一个**匹配（避免一句话里两个句柄被吞成一个）。 */
const HANDLE_PATTERN = /\[omw:handle=([^\]\s]+)\s*~(\d+)\s*tokens\]/

/** 句柄 id 允许的字符集：字母数字 + `-_.#:`，长度 1-128（防注入到别的语法里）。 */
const HANDLE_ID_PATTERN = /^[A-Za-z0-9._:#-]{1,128}$/

export interface HandleRef {
  readonly id: string
  /** 折叠前原文字符数（只用于展示；还原不依赖它）。 */
  readonly tokens: number
}

/** 把一个非负整数夹紧（负数/NaN ⇒ 0，避免生成 `~-1` / `~NaN` 这种坏串）。 */
export function clampTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/** 生成句柄块（表面里替换原文时用）。 */
export function formatHandleBlock(id: string, tokens: number): string {
  if (!HANDLE_ID_PATTERN.test(id)) {
    throw new Error('非法句柄 id（期望 [A-Za-z0-9._:#-]{1,128}，实际 ' + JSON.stringify(id) + '）')
  }
  return '[omw:handle=' + id + ' ~' + String(clampTokenCount(tokens)) + ' tokens]'
}

/**
 * 从表面文本里解析第一个句柄（前后空白无关；非法/缺字段返回 null，**不抛**）。
 *
 * 为什么不抛：解析发生在工具入参路径上，抛错会把一个「用户手抄错了」变成异常；
 * 调用方拿到 null 后返回 `handle_not_found`（fail-open，INV-3）。
 */
export function parseHandle(text: string): HandleRef | null {
  const match = HANDLE_PATTERN.exec(text)
  if (match === null) return null
  const id = match[1]
  if (id === undefined || !HANDLE_ID_PATTERN.test(id)) return null
  const tokensText = match[2]
  const tokens = tokensText === undefined ? 0 : Number.parseInt(tokensText, 10)
  return { id, tokens: Number.isFinite(tokens) ? tokens : 0 }
}

/** 供工具入参使用：既接受裸 id，也接受整段句柄块。 */
export function resolveHandleInput(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const parsed = parseHandle(trimmed)
  if (parsed !== null) return parsed.id
  return HANDLE_ID_PATTERN.test(trimmed) ? trimmed : null
}

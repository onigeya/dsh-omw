/**
 * T1 无损折叠：判定、渲染、锚点与编排（Story 8.3 / AC:1693-1699、AC:1709-1711、NFR18）。
 *
 * 四件事，都不碰库、不碰时钟、不调 LLM：
 * 1. `classifyT1`：这段区间是否必须走 T1（含 user 原话 / system 消息 / 动态骨架）；
 * 2. `renderRegionText`：把区间渲染成逐字文本（句柄正文就是它，还原率必须 100%）；
 * 3. `fnv1aAnchor`：文本的确定性锚点，作为句柄 `(session, seq)` 幂等键（矩阵行 5）；
 * 4. `summarizeWithT1`：`summarize()` 的编排（只读 / 非 T1 / writer 缺失 / 写失败 ⇒ 委托 stock）。
 *
 * **为什么去掉开头唯一的 system head**：stock 的 `buildSummarizationInput` 会把会话的
 * system prompt 作为前缀拼进 `messages[0]`（只用于复用缓存前缀），它不是「被压内容」；
 * 把它算 T1 会让每次压缩都变成 T1，也让句柄正文里混进系统提示。
 *
 * Story 8.5 / T4：动态骨架消息（`source.kind === SKELETON_SOURCE_KIND`）按受保护内容处理，
 * 因此它既不进 T2/T3 的可压预算，也不会被折成句柄丢失。
 */
import { estimateTokens } from './fold.js'
import { formatHandleBlock } from './handle.js'
import { SKELETON_SOURCE_KIND } from '../shared/injection-vocab.js'
import type { HandleWriter } from './handle-writer.js'

/** 只声明渲染用得到的最小形状：不 import `dsh-llm` 的 `Message`，避免嵌套依赖的类型双身份。 */
export interface T1ContentBlockLike {
  readonly type: string
  readonly text?: string
}

export interface T1MessageLike {
  readonly role: string
  readonly content: readonly (T1ContentBlockLike | string)[] | string
  /**
   * 消息来源标签（宿主 `source.kind` 的结构视图）。Story 8.5 / T4：动态骨架被物化成消息时
   * 这里会出现 {@link SKELETON_SOURCE_KIND}，压缩判据据此把它当**受保护内容**。
   */
  readonly source?: { readonly kind?: unknown } | null
}

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const ANCHOR_MODULUS = 2 ** 31

/** region = 去掉开头唯一的 system head。 */
export function regionMessages(messages: readonly T1MessageLike[]): readonly T1MessageLike[] {
  return messages.length > 0 && messages[0]?.role === 'system' ? messages.slice(1) : messages
}

/** 是否为动态骨架消息（Story 8.5 / T4：骨架与 T1 一样不计入可压预算）。 */
export function isSkeletonMessage(message: T1MessageLike): boolean {
  const kind = message.source?.kind
  return typeof kind === 'string' && kind === SKELETON_SOURCE_KIND
}

/**
 * 段内是否必须走 T1：region 里出现 user / system **或动态骨架**即为真；只有 assistant / tool
 * 交给 stock。
 *
 * Story 8.5 / T4：骨架是「用户明确要求别忘」的内容，折掉它就是自噬；无论宿主把骨架物化成
 * 哪种 role，只要带 {@link SKELETON_SOURCE_KIND} 标签就按受保护内容处理。
 */
export function classifyT1(messages: readonly T1MessageLike[]): boolean {
  return regionMessages(messages).some((message) =>
    message.role === 'user' || message.role === 'system' || isSkeletonMessage(message))
}

/**
 * 渲染 region 为句柄正文：每条消息一行 `[role]`，再按块顺序逐字输出。
 * - `text` / `reasoning` 块原样输出（不 trim、不改换行，NFR18 靠这个）；
 * - 其它块输出 `[<type>]<JSON>`（保留工具调用参数，折叠才真的是「无损」）。
 */
export function renderRegionText(messages: readonly T1MessageLike[]): string {
  const lines: string[] = []
  for (const message of regionMessages(messages)) {
    lines.push('[' + message.role + ']')
    const content = message.content
    if (typeof content === 'string') {
      lines.push(content)
      continue
    }
    for (const block of content) {
      if (typeof block === 'string') {
        lines.push(block)
        continue
      }
      if (block.type === 'text' || block.type === 'reasoning') {
        lines.push(block.text ?? '')
        continue
      }
      lines.push('[' + block.type + ']' + JSON.stringify(block))
    }
  }
  return lines.join('\n')
}

/** FNV-1a 32 位（同输入跨进程稳定）；锚点恒为负、永不为 0，与宿主正 seq 不冲突。 */
export function fnv1aAnchor(text: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return -(1 + (hash % ANCHOR_MODULUS))
}

export interface T1Summary {
  readonly summary: ReadonlyArray<{ readonly type: 'text', readonly text: string }>
  readonly provider: 'omw-t1-fold'
  readonly model: 'handle'
  readonly rawOutput: readonly never[]
}

/** 把 region 原文写进句柄并返回句柄块摘要；空文本由 `writeHandle` 拒绝（调用方 fail-open）。 */
export async function buildT1Summary(input: {
  readonly messages: readonly T1MessageLike[]
  readonly sessionId: string
  readonly writeHandle: HandleWriter
}): Promise<T1Summary> {
  const text = renderRegionText(input.messages)
  const tokens = estimateTokens(text)
  const written = await input.writeHandle({ sessionId: input.sessionId, seq: fnv1aAnchor(text), text, tokens })
  return {
    summary: [{ type: 'text', text: formatHandleBlock(written.id, tokens) }],
    provider: 'omw-t1-fold',
    model: 'handle',
    rawOutput: [],
  }
}

export interface SummarizeRouteInput<T> {
  readonly messages: readonly T1MessageLike[]
  readonly sessionId: string
  readonly readonly: boolean
  readonly writeHandle: HandleWriter | null
  /** 非 T1 / 降级时交给 stock 的 `summarize()`。 */
  readonly fallback: () => Promise<T>
  readonly logger?: { warn(message: string): void }
  /**
   * Story 8.4：长度三带已判定 T1（`< lengthMin` / 硬下界越界）时**强制**折叠——
   * 这类区间可能没有 user 原话，`classifyT1` 会否掉它，但档位裁决优先于 role 分类。
   */
  readonly forceFold?: boolean
}

export interface SummarizeRouteResult<T> {
  readonly result: T
  readonly route: 't1' | 'delegate'
}

/**
 * `summarize()` 的编排：只读 / 非 T1 / writer 缺失 / 无会话归属 / 写失败 ⇒ 委托 stock
 * （fail-open，INV-3）；否则返回 T1 句柄摘要。
 */
export async function summarizeWithT1<T>(input: SummarizeRouteInput<T>): Promise<SummarizeRouteResult<T>> {
  if (input.readonly) return { result: await input.fallback(), route: 'delegate' }
  if (input.forceFold !== true && !classifyT1(input.messages)) return { result: await input.fallback(), route: 'delegate' }
  if (input.writeHandle === null) {
    input.logger?.warn('T1 折叠跳过：句柄写者未注册（库未就绪 / 只读实例），fail-open 委托 stock 摘要')
    return { result: await input.fallback(), route: 'delegate' }
  }
  if (input.sessionId === '') {
    input.logger?.warn('T1 折叠跳过：取不到会话 id，句柄无法归属，fail-open 委托 stock 摘要')
    return { result: await input.fallback(), route: 'delegate' }
  }
  try {
    const summary = await buildT1Summary({
      messages: input.messages,
      sessionId: input.sessionId,
      writeHandle: input.writeHandle,
    })
    return { result: summary as unknown as T, route: 't1' }
  } catch (error) {
    input.logger?.warn('T1 句柄写入失败（fail-open，委托 stock 摘要）：' + String(error))
    return { result: await input.fallback(), route: 'delegate' }
  }
}

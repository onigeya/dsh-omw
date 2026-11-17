/**
 * 消息正文渲染（Story 10.2：从 capture/transcript.ts 下沉到 shared）。
 *
 * 精炼 hydrate 在 kernel 的 `db/host-log.ts` 里按 seq 读回宿主事件后也要把事件拍成
 * `role: text`，而 kernel 不得反向依赖 domain 的 `capture/`（AD-33）。渲染只依赖消息
 * 形状（`role` / `content`），不依赖采集时机，因此归 shared 是正确方向；
 * `capture/transcript.ts` 继续 re-export，既有 import 路径零改动。
 */

/** 从 message.content 取纯文本：字符串直接返回；数组取各文本片段；对象取 text 字段。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const text = (part as { readonly text?: unknown } | null | undefined)?.text
        return typeof text === 'string' ? text : ''
      })
      .filter((part) => part.length > 0)
      .join('\n')
  }
  const text = (content as { readonly text?: unknown } | null | undefined)?.text
  return typeof text === 'string' ? text : ''
}

/** 把一条消息拍成 'role: text'；取不到角色用 'unknown'，取不到文本返回空串。 */
export function renderMessage(message: unknown): string {
  const role = (message as { readonly role?: unknown } | null | undefined)?.role
  const label = typeof role === 'string' && role.length > 0 ? role : 'unknown'
  const text = contentText((message as { readonly content?: unknown } | null | undefined)?.content)
  return text.length > 0 ? label + ': ' + text : ''
}

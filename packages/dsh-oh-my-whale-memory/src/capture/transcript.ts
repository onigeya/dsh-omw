/**
 * 对话原文渲染（Story 2.1 / FR-2）：三钩子共用的「这次采集什么文本」。
 *
 * 文本源是 session.deriveMessages()——同步、缓存、Message 深冻结（宿主 session.md:654-662），
 * 所以采集可以在 session/event 的同步路径里安全取用。
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

/** 渲染整段对话（空消息跳过；多条以空行分隔）。 */
export function renderTranscript(messages: readonly unknown[]): string {
  return messages
    .map(renderMessage)
    .filter((line) => line.length > 0)
    .join('\n\n')
}

/** 守卫式取 session.deriveMessages()：非 Session / 无该方法 / 抛错一律返回 []。 */
export function sessionMessages(session: unknown): readonly unknown[] {
  const derive = (session as { readonly deriveMessages?: unknown } | null | undefined)?.deriveMessages
  if (typeof derive !== 'function') return []
  try {
    const messages = (derive as () => unknown).call(session)
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

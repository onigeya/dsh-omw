/**
 * 对话原文渲染（Story 2.1 / FR-2）：三钩子共用的「这次采集什么文本」。
 *
 * 文本源是 session.deriveMessages()：同步、缓存、Message 深冻结（宿主 session.md:654-662），
 * 所以采集可以在 session/event 的同步路径里安全取用。
 *
 * Story 10.2：`contentText` / `renderMessage` 下沉到 `shared/message-text.ts`
 * （kernel 的 `db/host-log.ts` 也要同一份渲染，且不能反向 import domain），
 * 这里 re-export 保持既有 import 路径与语义不变。
 */
export { contentText, renderMessage } from '../shared/message-text.js'
import { renderMessage } from '../shared/message-text.js'

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

/**
 * 从宿主 session 对象解析精炼路由（Story 2.3 / AC:567 的回退链）。
 *
 * 回退顺序（单一来源，评审 T21 要求可单测）：
 * 1. `session.requestHeader()` 的 `config.provider/model`——log 中**最后一个** header 事件的折叠值，
 *    即「最近一次已记录的请求目标」；
 * 2. `session.requestContext()` 的 `provider/model`——只在 provider/model/capacity 变化时追加；
 * 3. 都没有 ⇒ `null`（调用方据此直接降级，不调 LLM）。
 *
 * 纯函数：只依赖传入对象，不碰 ctx；运行期行为与原先 index.ts 内联实现一致。
 * 这里刻意只用结构化类型 + 宽松 unknown 读取：裸 ctx / 假 session 不会抛错。
 */
import type { RefineRoute } from './llm-refine.js'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 解析 session 的已记录请求目标；解析不出返回 null。
 * `session` 允许为 undefined / 假对象（缺少两个方法时返回 null，不抛错）。
 */
export function routeFromSession(session: unknown): RefineRoute | null {
  const requestHeader = (session as { requestHeader?: () => unknown } | undefined)?.requestHeader
  if (typeof requestHeader === 'function') {
    const header = requestHeader.call(session)
    const config = (header as { config?: { provider?: unknown; model?: unknown } } | undefined)?.config
    const provider = nonEmptyString(config?.provider)
    const model = nonEmptyString(config?.model)
    if (provider && model) return { provider, model }
  }
  const requestContext = (session as { requestContext?: () => unknown } | undefined)?.requestContext
  if (typeof requestContext === 'function') {
    const recorded = requestContext.call(session) as { provider?: unknown; model?: unknown } | undefined
    const provider = nonEmptyString(recorded?.provider)
    const model = nonEmptyString(recorded?.model)
    if (provider && model) return { provider, model }
  }
  return null
}

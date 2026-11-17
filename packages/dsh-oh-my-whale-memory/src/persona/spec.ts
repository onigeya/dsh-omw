/**
 * Persona Spec 静态注入 seam（Story 11.2 / AC:2319-2338、AD-38、AD-39、AD-23、INV-1）。
 *
 * 本模块是**seam 与版本/hash 契约**，不是 Spec 正文：正文必须由产品负责人明确批准
 *（ADR-11.1 决策 2）。批准前 `PERSONA_SPEC_APPROVED=false`、正文为空串、生产默认关闭
 *（Config `personaSpecEnabled=false`），因此 `omw-persona` section 在生产默认**不存在**——
 * 不渲染占位符、不渲染空段、更不渲染从 User Portrait / 反思推断出的文本（ADR-11.1 F-6）。
 *
 * 批准后只替换本文件的 `PERSONA_SPEC_VERSION` / `PERSONA_SPEC_TEXT` / `PERSONA_SPEC_APPROVED`
 * 并把 Config 开关打开，注入逻辑与 hash 契约不变；正文变更必须同时换版本（ADR-11.1 D-1.2）。
 *
 * 纯常量 + 纯函数：无 I/O、无时钟、无随机、无 user data。hash 只由正文决定（sha256），
 * 同一版本在任何会话 / 任何进程渲染出的字节相同（INV-1 / AD-23）。运行时没有任何写 Spec
 * 的 API——`canRewritePersonaSpec` 恒 false（`persona/contract.ts`），本模块也不导出 setter。
 */
import { createHash } from 'node:crypto'
import { PERSONA_SECTION_NAME, PERSONA_SPEC_VERSION } from './contract.js'

// 版本与 section 名的唯一决策源仍在 11.1 的契约里；这里只做 seam 的再导出，
// 避免运行期出现第二份字面量（改版本必须动契约，而不是顺手改一个实现文件）。
export { PERSONA_SECTION_NAME, PERSONA_SPEC_VERSION }

/**
 * 正文批准状态（ADR-11.1：唯一批准人 = 产品负责人）。
 * 生产恒 `false`，直到「正文 + 版本号 + 批准人」同一次变更落地；测试用显式 fixture 覆盖批准分支。
 */
export const PERSONA_SPEC_APPROVED = false

/**
 * Spec 正文。批准前**必须**为空串：空文本是 fail-closed 的判据（`renderPersonaSection` ⇒ null）。
 * 不得在此放置示例人设、默认承诺或从其他子系统生成的文本。
 */
export const PERSONA_SPEC_TEXT = ''

/** 一份版本化的 Persona Spec（版本号与正文一一对应，ADR-11.1 D-1.2）。 */
export interface PersonaSpec {
  readonly version: string
  readonly text: string
}

/** 生产 Spec：当前 = 未批准的空正文（version 仍是 `draft-0` 占位标签，不是批准签名）。 */
export const PERSONA_SPEC: PersonaSpec = { version: PERSONA_SPEC_VERSION, text: PERSONA_SPEC_TEXT }

/** 静态 section 的渲染结果（宿主 `systemPrompt.section` 只消费 name / text）。 */
export interface PersonaSection {
  readonly name: typeof PERSONA_SECTION_NAME
  readonly text: string
  readonly hash: string
}

/** `renderPersonaSection` 的输入：三个开关任不满足即不渲染（fail-closed）。 */
export interface PersonaRenderInput {
  readonly enabled: boolean
  readonly approved: boolean
  readonly spec: PersonaSpec
}

/**
 * 正文的稳定摘要：sha256(UTF-8 字节) 的小写十六进制。
 *
 * 只由正文决定（不含版本、不含时钟/会话），因此「同版本 ⇒ 同 hash」可跨进程比较；
 * 版本与 hash 的绑定关系由调用方/测试保证（同版本文本必须一致，矩阵行 5）。
 */
export function personaSpecHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 构造静态 section：`{ name:'omw-persona', text, hash }`。
 *
 * `version` 是输入契约的一部分（正文必须与版本一起绑定），但不进入 section 对象——宿主
 * section 只认 name/order/text，版本由调用方保持在同一份常量对里，并在 `/memory status`
 * 的 `persona:` 行与 hash 并列展示。
 */
export function buildPersonaSection(spec: PersonaSpec): PersonaSection {
  return { name: PERSONA_SECTION_NAME, text: spec.text, hash: personaSpecHash(spec.text) }
}

/**
 * 批准门 + 渲染：**只有** enabled ∧ approved ∧ 非空正文三者同时成立才返回 section；
 * 未启用 / 未批准 / 空正文一律 null（不得以占位文本代替，ADR-11.1 决策 2）。
 */
export function renderPersonaSection(input: PersonaRenderInput): PersonaSection | null {
  if (!input.enabled || !input.approved || input.spec.text === '') return null
  return buildPersonaSection(input.spec)
}

/** `/memory status` 的 `persona:` 行数据；null = 未启用 / 未批准 / 空正文（渲染成 disabled）。 */
export interface PersonaStatus {
  readonly version: string
  readonly hash: string
}

/** 从同一判据派生 status 视图（命令层只做格式化，不重新判断批准门）。 */
export function personaStatusOf(input: PersonaRenderInput): PersonaStatus | null {
  const section = renderPersonaSection(input)
  return section === null ? null : { version: input.spec.version, hash: section.hash }
}

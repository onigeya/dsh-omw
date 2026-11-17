/**
 * Persona Spec 静态 section 接线（Story 11.2 / T3、矩阵行 1–3、6–7；AD-38 / AD-23）。
 *
 * 与 `omw-memory` 是**两个独立 section**：本函数只注册 `omw-persona`，不读写
 * `omw-memory` 的文本、也不碰 `ctx.systemPrompt.context()` 的动态内容（矩阵行 4）。
 *
 * 调用点约束（`src/index.ts`）：只在**写者实例**调用——只读实例在 apply 里更早 return，
 * 因此不会注册 persona section（矩阵行 7）。默认配置 / 未批准 / 空正文时
 * `renderPersonaSection` 返回 null，本函数连 `host.section` 都不调用（矩阵行 1–2 的结构钉）。
 *
 * 注册失败只 warn、不阻塞插件（矩阵行 6）：`systemPrompt.section` 抛错（层内重名 / 宿主
 * 状态异常）时本函数吞掉错误并返回 null，主装配继续——与 `wireStep` 的单元隔离同口径。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InjectionPromptHost } from '../injection/prompt.js'
import {
  renderPersonaSection,
  type PersonaRenderInput,
  type PersonaSection,
} from '../persona/spec.js'

/**
 * 排序位（自有常量）：与 `omw-memory`（600）同在 reusable-instructions 区、工具区（1000+）之前。
 * 身份承诺先于记忆引导语，但两者互不依赖（宿主不保证同区相对顺序，文本各自自洽）。
 */
export const PERSONA_SECTION_ORDER = 500

/**
 * 按批准门注册静态 section。返回注册的 section（供测试/观测）或 null（未启用/未批准/空正文/
 * 裸 ctx 无 systemPrompt/注册失败）。
 */
export function wirePersonaSection(ctx: Context, input: PersonaRenderInput): PersonaSection | null {
  const section = renderPersonaSection(input)
  if (section === null) return null
  // 裸 ctx / 精简宿主没有 systemPrompt 面：整面跳过，不抛错（与 `registerInjectionPrompt` 同口径）。
  const host = (ctx as unknown as { readonly systemPrompt?: InjectionPromptHost }).systemPrompt
  if (host === undefined) return null
  try {
    // 常量文本 + interpolate:false：与 `omw-memory` 同一防插值约定，正文里的 `{{}}` 不得被宿主当变量。
    host.section({
      name: section.name,
      order: PERSONA_SECTION_ORDER,
      text: section.text,
      interpolate: false,
    })
    return section
  } catch (error) {
    ctx.logger.warn(
      'omw-persona section 注册失败（不阻塞注入面）：' +
      (error instanceof Error ? error.message : String(error)),
    )
    return null
  }
}

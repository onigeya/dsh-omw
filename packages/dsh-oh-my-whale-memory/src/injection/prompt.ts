/**
 * 注入面骨架（Story 3.3 / B1）：静态引导语 section `omw-memory` + 动态 context provider。
 *
 * 载体分工（AD-23）：section 只放**常量**引导语（text 为字面量，`interpolate:false` 防记忆
 * 文本里的 `{{}}` 被当变量插值）；动态摘要全部走 `ctx.systemPrompt.context()`，其 provider
 * 由宿主在**每次请求前重新解析**（B1 探针已核实 `step()` 的 `refreshContext` 会重解析，
 * 见 `probe-3-3-timing.md`）——因此「pre-step 内 await 生成 → provider 读到新状态」可让摘要
 * 进入本会话首个请求。provider 从注入状态机闭包取文本，非 ready/空文本一律返回 `''`
 * （宿主对空文本不产出消息）。
 *
 * B1 只做骨架：section/context 注册 + 文本读取端口；生成与三限制在 B2/B3。
 */
import { inboxSessionKey } from '../inbox/idle-gate.js'
import type { InjectionStore } from './state.js'

/** systemPrompt section 名（AD-2；层内唯一，重复注册宿主直接抛错）。 */
export const INJECTION_SECTION_NAME = 'omw-memory'
/** 动态 context 名（宿主内唯一）。 */
export const INJECTION_CONTEXT_NAME = 'omw-memory:recall'

/**
 * section 排序位（自有常量）：宿主 `SECTION_ORDERS` 未登记第三方名字
 * （`packages/core/system-prompt/src/index.ts:150-190`），取 reusable-instructions 区、
 * 工具区（1000+）之前的 600。
 */
export const INJECTION_SECTION_ORDER = 600
/** context 排序位（自有常量）：紧跟宿主 `SUBAGENT_DELEGATION=120` 之后。 */
export const INJECTION_CONTEXT_ORDER = 130

/**
 * 静态引导语（**常量**，AC:920；禁止函数/动态内容）。只声明「有记忆会被注入 + 用途」，
 * 不包含任何用户数据，保证前缀稳定性。
 */
export const OMW_MEMORY_SECTION_TEXT = [
  '本会话可能附带一份来自长期记忆的开局摘要（用户偏好、既往决策、硬约束）。',
  '摘要只作先验：与用户当前指令冲突时以当前指令为准；需要细节时可调用 memory_recall / memory_related 检索。',
].join('')

/** `ctx.systemPrompt` 的最小结构端口（不引宿主运行时类型；裸 ctx 下该服务不存在）。 */
export interface InjectionPromptHost {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
    readonly interpolate?: boolean
  }): () => void
  context(context: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: unknown) => string)
    readonly interpolate?: boolean
  }): () => void
}

/** 从宿主 `AssembleContext` 里取会话键（结构窄化；拿不到归 'unknown'，与配额/采集同键）。 */
export function injectionSessionKeyOf(context: unknown): string {
  const session = (context as { readonly agent?: { readonly session?: unknown } } | null | undefined)
    ?.agent?.session
  return inboxSessionKey(session)
}

/**
 * 注册注入面（section + context）。返回宿主给的 effect disposer（由调用方 ctx 作用域管理；
 * 注册本身就是 effect，**不**再套 `ctx.effect`——避免 entry-exports 的 closer 数漂移）。
 */
export function registerInjectionPrompt(
  host: InjectionPromptHost,
  store: InjectionStore,
): Array<() => void> {
  return [
    host.section({
      name: INJECTION_SECTION_NAME,
      order: INJECTION_SECTION_ORDER,
      text: OMW_MEMORY_SECTION_TEXT,
      // 常量文本本无变量，显式关闭插值以防未来把动态内容误放进 section。
      interpolate: false,
    }),
    host.context({
      name: INJECTION_CONTEXT_NAME,
      order: INJECTION_CONTEXT_ORDER,
      interpolate: false,
      // 每次组装/请求前被重新解析；空文本短路由 store.textFor 保证。
      text: (context) => store.textFor(injectionSessionKeyOf(context)),
    }),
  ]
}

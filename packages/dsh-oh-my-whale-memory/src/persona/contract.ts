/**
 * Agent 身份契约原型（Story 11.1 / FR-35、AD-38、AD-39）。
 *
 * 本模块是**契约的唯一实现**：纯常量 + 纯函数，无 I/O、无时钟、无随机。
 * Story 11.2 起 `persona/spec.ts` 与 `wire/persona.ts` 消费它；Story 11.3 起
 * `persona/self-knowledge.ts`（经 `src/index.ts` 的 apply 装配）消费 `decidePromotion` /
 * `isVisible` / `canRewritePersonaSpec`。本模块自身仍不接宿主、不写库。
 *
 * 决策依据：`_bmad-output/implementation-artifacts/adr-11-1-agent-identity.md`。
 * 可见性矩阵一经批准即约束所有消费者（AD-38），消费者不得各自重写一套判断。
 */

/**
 * Self-Knowledge 三态（AD-38）。
 *
 * - `candidate`：反思产出的 append-only 候选，默认不可见；
 * - `accepted`：有独立外部信号支撑、只进常驻层（AD-39）的观察；
 * - `rejected`：明确不成立或仅有自评的观察，永不出现。
 */
export const SELF_KNOWLEDGE_STATES = ['candidate', 'accepted', 'rejected'] as const

export type SelfKnowledgeState = (typeof SELF_KNOWLEDGE_STATES)[number]

/**
 * 自省知识的可见面（AD-38 逐字四类）：
 * - `recall`：普通召回（作为可选层候选参与竞争）；
 * - `injection`：prompt 注入（常驻层 / 可选层任何注入路径）；
 * - `query`：专用查询（审计 / 检视接口，不是普通召回）；
 * - `conflict`：User Portrait 冲突处理（能不能作为「用户事实冲突」的一方）。
 */
export const SELF_KNOWLEDGE_SURFACES = ['recall', 'injection', 'query', 'conflict'] as const

export type SelfKnowledgeSurface = (typeof SELF_KNOWLEDGE_SURFACES)[number]

/** Persona Spec 的静态 prompt seam（AD-38 / AD-23）。与 `omw-memory` 是两个独立 section。 */
export const PERSONA_SECTION_NAME = 'omw-persona'

/**
 * Persona Spec 版本标签。
 *
 * `draft-0` 表示「Spec 正文尚未经产品负责人批准」：本 story 不生成、不编造任何默认文本，
 * 只钉住版本位。批准后的正文与真实版本号在 Story 11.2 一起绑定；此后正文每变更一次必须
 * 换版本（同一版本必须确定性渲染，AD-38 / INV-1）。
 */
export const PERSONA_SPEC_VERSION = 'draft-0'

/**
 * 可见性矩阵（T1 ④）。**fail-closed**：未列明的组合一律不可见，未列明的状态/面也不可能
 * 通过本函数拿到 `true`。
 *
 * | state | recall | injection | query | conflict |
 * |---|---|---|---|---|
 * | candidate | ✗ | ✗ | ✗ | ✗ |
 * | accepted | ✗ | ✓ | ✓ | ✗ |
 * | rejected | ✗ | ✗ | ✗ | ✗ |
 *
 * 逐格理由见 ADR-11.1「可见性矩阵」一节。要点：accepted 也不进普通召回（否则会与用户事实
 * 在同一候选池里竞争排序），只能由常驻层收集路径直接取；专用查询是唯一可读的自省审计面。
 */
const SELF_KNOWLEDGE_VISIBILITY: Record<SelfKnowledgeState, Record<SelfKnowledgeSurface, boolean>> = {
  candidate: { recall: false, injection: false, query: false, conflict: false },
  accepted: { recall: false, injection: true, query: true, conflict: false },
  rejected: { recall: false, injection: false, query: false, conflict: false },
}

/** 某状态在某个面是否可见（矩阵的唯一判据；未知输入按不可见处理）。 */
export function isVisible(state: SelfKnowledgeState, surface: SelfKnowledgeSurface): boolean {
  return SELF_KNOWLEDGE_VISIBILITY[state]?.[surface] === true
}

/**
 * 晋升可用的**独立**验证信号（T1 ⑤，均为现有可观察量，不新增埋点）：
 * - `outcome`：`generation_log.outcome`（FR-8 三档）等外部结果记录；
 * - `tool-result`：工具调用的真实返回（成功/失败/内容），与反思文本无关；
 * - `user-feedback`：用户显式反馈（纠正、`await-confirmation` 裁决、forget 等）。
 *
 * 反思模型自评**不在此列**：它不是独立验证器（AD-38「同一反思模型的自我评分不能单独晋升」）。
 */
export const KNOWLEDGE_SIGNALS = ['outcome', 'tool-result', 'user-feedback'] as const

export type KnowledgeSignal = (typeof KNOWLEDGE_SIGNALS)[number]

/** 晋升判定结果：`accepted` / `record-only`（只记录不晋升）/ `rejected`（明确不成立）。 */
export type PromotionState = 'accepted' | 'record-only' | 'rejected'

export interface PromotionInput {
  /** 独立验证信号；`null` = 没有任何独立信号。 */
  readonly signal: KnowledgeSignal | null
  /** 晋升依据是否只有反思模型自己的评分（true ⇒ 永不晋升）。 */
  readonly selfScoreOnly: boolean
}

export interface PromotionDecision {
  readonly state: PromotionState
  readonly reasons: readonly string[]
}

/**
 * 晋升门原型（T2）。判据顺序（不依赖反思自评）：
 *
 * 1. 无独立信号（`signal` 为 `null` 或不在 `KNOWLEDGE_SIGNALS` 内）⇒ `record-only`：只记录
 *    候选，不晋升、不丢弃；这是信号不足时的**规定降级态**（不受 `selfScoreOnly` 影响）。
 * 2. `selfScoreOnly === true` ⇒ `rejected`：同一反思模型的自我评分不能单独晋升；即使调用方
 *    同时报了一个信号名，也按「唯一依据仍是自评」处理（保守优先）。
 * 3. 有独立信号且不是自评 ⇒ `accepted`（具备晋升资格）。
 *
 * **不含数值阈值**：需要几条信号、信号密度多高才算够，现有数据没有基线，本 story 不编造。
 * 第 3 步只是「存在独立信号」的定性判定；Story 11.3 在拿到真实密度后才能补阈值，补阈值
 * 时不得改变本函数的判据形态（自评仍不能单独晋升、无信号仍是 record-only）。
 */
export function decidePromotion(input: PromotionInput): PromotionDecision {
  if (input.signal === null || !KNOWLEDGE_SIGNALS.includes(input.signal)) {
    return {
      state: 'record-only',
      reasons: ['no-independent-signal：无外部结果 / 工具结果 / 用户显式反馈，只记录不晋升'],
    }
  }
  if (input.selfScoreOnly) {
    return {
      state: 'rejected',
      reasons: ['self-score-only：同一反思模型的自我评分不能单独晋升（AD-38）'],
    }
  }
  return {
    state: 'accepted',
    reasons: [`independent-signal:${input.signal}`],
  }
}

/**
 * Persona Spec 的潜在写入来源。**全部不允许**：Spec 是产品/开发者维护、运行时只读的静态
 * 规范；反思、用户记忆、工具调用、会话运行时都没有写路径（AD-38）。
 */
export const PERSONA_SPEC_WRITE_SOURCES = ['runtime', 'reflection', 'user-memory', 'tool-call'] as const

export type PersonaSpecWriteSource = (typeof PERSONA_SPEC_WRITE_SOURCES)[number]

/**
 * 能否由该来源改写 Persona Spec：**恒 false**（T2）。写成函数而不是「什么都不导出」，是为了
 * 让任何未来的写路径都必须显式经过一个返回 false 的判定，改造它需要先改契约与 ADR，而不是
 * 顺手在运行时拼一段新 Spec。
 */
export function canRewritePersonaSpec(source: PersonaSpecWriteSource): boolean {
  void source
  return false
}

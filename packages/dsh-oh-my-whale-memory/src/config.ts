/**
 * Config schema 与运行时配置投影（Story 1.3）。
 *
 * 契约锁定（见 spec frozen block / AD-9 / AD-11 / FR-18）：
 * - 凭据字段命名 `token` 且标 `.role('secret')`，redact.ts 按 node.meta?.role === 'secret' 判定，
 *   字段名不参与脱敏判定（AD-9）。
 * - 所有进 /settings 表单的字段标 `.volatile()`，宿主 volatileForm() 只递归 volatile 节点（AD-11）。
 * - 嵌套对象（embedding / rerank / layerWeights / systemOne）整体 `.volatile()`，子字段保持 plain：
 *   schemastery 的 validateVolatileSchema 硬约束禁止 volatile 嵌套 volatile，否则启动即抛
 *   ValidationError('volatile fields require a fixed object path without an enclosing volatile field')。
 * - ReRank 字段 v2 预留：schema 先落，v1 不消费、不校验（本文件 resolveRuntimeConfig 不触达 rerank）。
 */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/**
 * 配置缺省值的唯一来源：schema 的 `default(...)` 与 `resolveRuntimeConfig` 的兜底必须同源。
 * 两处若各写一份数字，「宿主未注入该字段」与「volatile 节点取默认值」会给出不同结果（没有测试绑住两者）。
 *
 * Story 8.5 起也对外导出：注入裁剪（`injection/budget.ts`）的缺省额度必须与 schema 同源，
 * 否则「没配额度」与「额度取默认值」会算出两个不同的预算。
 */
export const MEMORY_CONFIG_DEFAULTS = {
  captureSteps: 50,
  // Story 10.1 / AD-36：token 触发账本的三个阈值（tokens）。8K 软阈值 / 500 最小累计 /
  // 32K 硬上限——数值由 epics.md:2070 逐字钉死，不是实测标定。`captureSteps` 只在
  // `ctx.tokenMeter` 不可用时作为降级触发（NFR12）。
  captureTokens: 8000,
  captureMinTokens: 500,
  captureMaxTokens: 32000,
  inboxRefineConcurrency: 4,
  injectOnNewSession: true,
  rrfK: 60,
  retrievalTopK: 50,
  layerWeights: { l2: 0.7, l1: 0.4 },
  priorityWeight: 0.5,
  systemOneEnabled: true,
  // Story 7.2 / AD-37：三项默认值锁在架构（阈值不是本 story 拍定的）。
  reflectionThreshold: 6,
  reflectionIdleWaitMs: 90_000,
  reflectionIntervalMs: 900_000,
  // Story 7.3 / AD-20：采纳门三项默认值锁在架构（0.6 / 7 天 / 5 条）。
  strategyMinConfidence: 0.6,
  strategyExpiryDays: 7,
  strategyMaxPendingPerSession: 5,
  // Story 8.1 / AC:1544：compaction/start 未配对时的解阻塞超时（与 AD-6 lease 同量级）。
  compactionOrphanTimeoutMs: 60_000,
  // Story 8.2 / FR-23：工具结果折叠阈值（tokens）；超阈值折成句柄，全文入图。
  foldThresholdTokens: 2000,
  // Story 8.4 / AC:1713-1760：T1/T2/T3 长度三带的两条阈值与句柄重写阈值。
  // **经验值**（无实证语料标定，AC:1806 要求字段文档显式标注）：1200 / 8000 / 2 / 2。
  // 全部可运行期覆盖（INV-12 / FR-28），且 `lengthMin` 的硬下界由调用方按滚动窗口校验。
  compactionLengthMin: 1200,
  compactionT3Threshold: 8000,
  expandCountThreshold: 2,
  chainDepthThreshold: 2,
  // 反思驱动的阈值自调开关（AC:1737-1740）。默认关：没有建议生产端时开启也只是 no-op。
  compactionSelfTuneEnabled: false,
  // Story 8.5 / AC:1827-1832、AD-25：注入预算一律 tokens。
  // `injectionTokenCap` 4096 与两项单条/摘要上限都是**经验值**（AC:1792 要求字段文档显式标注），
  // 不是实测标定；`injectionRatio` 0.5 是 AC:1832 钉死的 v1 落地值（PRD §8 Q-19）。
  injectionTokenCap: 4096,
  injectionRatio: 0.5,
  injectionSingleCap: 512,
  injectionSummaryCap: 512,
  // 常驻层 / 动态骨架的绝对上限，**不套窗口公式**（AC:1827，默认 2000）。
  alwaysOnTokenCap: 2000,
  // Story 8.6 / AC:1868：确定性净化 pass 的四个开关。默认**开 R1 + R3、关 R2**；
  // `purifyMinRemainder` 24 是 R1/R2 安全阀（剥离后剩余长度低于它 ⇒ 整行不动）。
  purifyR1: true,
  purifyR2: false,
  purifyR3: true,
  purifyMinRemainder: 24,
  // Story 11.2 / AD-38：Persona Spec 静态 section 的开关。默认**关**——Spec 正文尚未经
  // 产品负责人批准（ADR-11.1 决策 2），打开也只是 no-op（未批准/空正文仍不注册）。
  personaSpecEnabled: false,
  // Story 11.3 / T5、AD-38：反思成功后把观察写入 Self-Knowledge 候选区的开关。默认**关**：
  // 关闭时反思不产生任何候选（fail-closed，spec 的 deferred 项）；打开后候选仍默认不可见，
  // 只有通过独立晋升门（accepted）才进常驻层。
  selfKnowledgeCaptureEnabled: false,
  // Story 9.1 / AD-31：抽取期本体约束闸门的档位。默认 **off**——默认行为与未启用本体时
  // 逐条一致（SM-9 ④ 的可回退对照）；档位只在 9.2 加载本体后才可能有可观察效果。
  ontologyGateLevel: 'off' as const,
}

/** Volatile 子对象：整体标 .volatile()，子字段保持 plain（AD-11 / Design Notes）。 */
const EmbeddingSchema = Schema.object({
  endpoint: Schema.string(),
  token: Schema.string().role('secret'),
  model: Schema.string(),
  // 建库 pin 的向量维度（Story 1.4 / AD-14）：留空按已知模型表或默认 1024 解析。
  dim: Schema.number(),
}).default({}).volatile()

const RerankSchema = Schema.object({
  endpoint: Schema.string(),
  token: Schema.string().role('secret'),
  model: Schema.string(),
}).default({}).volatile()

const LayerWeightsSchema = Schema.object({
  l2: Schema.number().default(MEMORY_CONFIG_DEFAULTS.layerWeights.l2),
  l1: Schema.number().default(MEMORY_CONFIG_DEFAULTS.layerWeights.l1),
}).default({}).volatile()

/**
 * System One 配置（Story 2.5 / 评审 P3-T4）：`enabled` 之外再给三个可选覆盖项。
 *
 * 端点与模型此前只有模块常量，不可覆盖；`token` 更是完全无处可配（上游若要求凭据就无解）。
 * - 三者全部可选，缺省行为与 2.5 之前逐字一致（不翻转 `enabled` 的默认值）；
 * - `token` 必须标 `.role('secret')`（AD-9：字段名不参与脱敏判定，不标则明文广播）；
 * - 凭据值不进日志 / 审计 / status（NFR9）。
 */
const SystemOneSchema = Schema.object({
  enabled: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.systemOneEnabled),
  endpoint: Schema.string(),
  model: Schema.string(),
  token: Schema.string().role('secret'),
}).default({}).volatile()

/**
 * 反思触发阈值子对象（Story 7.2 / AD-37）。
 *
 * 三项的语义：窗口兴趣分 ≥ threshold ∧ 会话空闲 ≥ idleWaitMs ∧ 距上次反思 ≥ intervalMs。
 * 只调数值不改判据形态（AD-28 / INV-14）；默认值与 `MEMORY_CONFIG_DEFAULTS` 同源。
 */
const ReflectionSchema = Schema.object({
  threshold: Schema.number().default(MEMORY_CONFIG_DEFAULTS.reflectionThreshold),
  idleWaitMs: Schema.number().default(MEMORY_CONFIG_DEFAULTS.reflectionIdleWaitMs),
  intervalMs: Schema.number().default(MEMORY_CONFIG_DEFAULTS.reflectionIntervalMs),
}).default({}).volatile()

/**
 * 策略采纳门子对象（Story 7.3 / AD-20）。
 *
 * 三项语义：低于 minConfidence 不采纳；候选未采纳 expiryDays 天后过期；单会话待采纳候选上限
 * maxPendingPerSession（超限时新候选不入候选区，而不是挤掉旧的）。默认值与 MEMORY_CONFIG_DEFAULTS 同源。
 */
const StrategyGateSchema = Schema.object({
  minConfidence: Schema.number().default(MEMORY_CONFIG_DEFAULTS.strategyMinConfidence),
  expiryDays: Schema.number().default(MEMORY_CONFIG_DEFAULTS.strategyExpiryDays),
  maxPendingPerSession: Schema.number().default(MEMORY_CONFIG_DEFAULTS.strategyMaxPendingPerSession),
}).default({}).volatile()

/**
 * Story 9.1 / AD-31：本体闸门的档位与逐维覆盖（全部 `.volatile()`，INV-12）。
 *
 * 子对象整体 `.volatile()`、子字段 plain（AD-11 的 volatile 嵌套约束）。默认 `off`：
 * 关闭时判定函数完全不执行，默认行为与未启用本体时逐条一致（off 下逐维覆盖被忽略，
 * 保证「off 产出的图与未启用本体逐条一致」）。逐维覆盖只在 align / strict 之上生效。
 */
const OntologyGateSchema = Schema.object({
  level: Schema.union(['off', 'align', 'strict'] as const).default(MEMORY_CONFIG_DEFAULTS.ontologyGateLevel),
  nameNormalization: Schema.boolean(),
  duplicateTypeDiscard: Schema.boolean(),
  entityType: Schema.boolean(),
  relationType: Schema.boolean(),
  domainRange: Schema.boolean(),
  datatype: Schema.boolean(),
}).default({}).volatile()

/** FR-18 全字段 Config schema。每项 `.volatile()`；凭据标 `.role('secret')`。 */
export const Config = Schema.object({
  embedding: EmbeddingSchema,
  rerank: RerankSchema,
  captureSteps: Schema.number().default(MEMORY_CONFIG_DEFAULTS.captureSteps).volatile(),
  /**
   * Story 10.1 / AC:2070：token 触发账本的三项阈值（全部 `.volatile()`，INV-12 运行期可覆盖）。
   * - `captureTokens`（8000）：`seq > lastSeq` 的 tokens 累计到它即触发一次 INBOX；
   * - `captureMinTokens`（500）：切片时尾部不足它的碎片并入上一片（不切碎记录）；
   * - `captureMaxTokens`（32000）：超过它按事件边界切多单，单事件不切（超限独立成单标 `oversize`）。
   * 三者不满足 `min ≤ tokens ≤ max` 时 fail-loud（否则阈值语义自相矛盾）。
   */
  captureTokens: Schema.number().default(MEMORY_CONFIG_DEFAULTS.captureTokens).volatile(),
  captureMinTokens: Schema.number().default(MEMORY_CONFIG_DEFAULTS.captureMinTokens).volatile(),
  captureMaxTokens: Schema.number().default(MEMORY_CONFIG_DEFAULTS.captureMaxTokens).volatile(),
  inboxRefineConcurrency: Schema.number().default(MEMORY_CONFIG_DEFAULTS.inboxRefineConcurrency).volatile(),
  injectOnNewSession: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.injectOnNewSession).volatile(),
  rrfK: Schema.number().default(MEMORY_CONFIG_DEFAULTS.rrfK).volatile(),
  retrievalTopK: Schema.number().default(MEMORY_CONFIG_DEFAULTS.retrievalTopK).volatile(),
  layerWeights: LayerWeightsSchema,
  // priority 二次加权系数（Story 3.1 / FR-16）：排序分再乘 `1 + priorityWeight × priority/100`。
  priorityWeight: Schema.number().default(MEMORY_CONFIG_DEFAULTS.priorityWeight).volatile(),
  llmProvider: Schema.string().volatile(),
  llmModel: Schema.string().volatile(),
  systemOne: SystemOneSchema,
  /**
   * 反思触发阈值（Story 7.2 / AD-37 / INV-12）：三项都必须是 Config 字段且可运行期覆盖；
   * 子对象整体 `.volatile()`、子字段 plain（AD-11 的 volatile 嵌套约束）。
   */
  reflection: ReflectionSchema,
  strategyGate: StrategyGateSchema,
  /** Story 8.1 / AC:1544：compaction/start 未配对的解阻塞超时（ms，与 AD-6 lease 同量级）。 */
  compactionOrphanTimeoutMs: Schema.number().default(MEMORY_CONFIG_DEFAULTS.compactionOrphanTimeoutMs).volatile(),
  /** Story 8.2：工具结果折叠阈值（tokens）。 */
  foldThresholdTokens: Schema.number().default(MEMORY_CONFIG_DEFAULTS.foldThresholdTokens).volatile(),
  /**
   * Story 8.4 / AC:1713-1760：长度三带的两条阈值（tokens）。
   * `< lengthMin ⇒ T1`、`[lengthMin, t3Threshold) ⇒ T2`、`>= t3Threshold ⇒ T3 候选`。
   * 均为**经验值**（AC:1806：无证据支撑的默认值必须显式标注），不是实测标定结果。
   */
  compactionLengthMin: Schema.number().default(MEMORY_CONFIG_DEFAULTS.compactionLengthMin).volatile(),
  compactionT3Threshold: Schema.number().default(MEMORY_CONFIG_DEFAULTS.compactionT3Threshold).volatile(),
  /** Story 8.4 / FR-29：句柄展开计数与重写链深的超阈判据（`>=` 即不合格）。 */
  expandCountThreshold: Schema.number().default(MEMORY_CONFIG_DEFAULTS.expandCountThreshold).volatile(),
  chainDepthThreshold: Schema.number().default(MEMORY_CONFIG_DEFAULTS.chainDepthThreshold).volatile(),
  /** Story 8.4 / AC:1737-1740：自调开关；关时不改任何数值（建议生产端见 spec 的 deferred）。 */
  compactionSelfTuneEnabled: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.compactionSelfTuneEnabled).volatile(),
  /**
   * Story 8.5 / AC:1826-1832、AD-25：注入预算一律 tokens（字符口径退役）。
   * `min(injectionTokenCap, injectionRatio × (contextWindow − pressureTokens))`，单条 / 摘要各一个
   * 绝对上限；`alwaysOnTokenCap` 是常驻层 / 动态骨架的绝对上限（不套窗口公式）。
   */
  injectionTokenCap: Schema.number().default(MEMORY_CONFIG_DEFAULTS.injectionTokenCap).volatile(),
  injectionRatio: Schema.number().default(MEMORY_CONFIG_DEFAULTS.injectionRatio).volatile(),
  injectionSingleCap: Schema.number().default(MEMORY_CONFIG_DEFAULTS.injectionSingleCap).volatile(),
  injectionSummaryCap: Schema.number().default(MEMORY_CONFIG_DEFAULTS.injectionSummaryCap).volatile(),
  alwaysOnTokenCap: Schema.number().default(MEMORY_CONFIG_DEFAULTS.alwaysOnTokenCap).volatile(),
  /**
   * Story 8.6 / AC:1868、FR-30：确定性净化 pass 的开关（四字段全部 `.volatile()`，
   * 运行期可覆盖，INV-12）。默认开 R1 + R3、关 R2；R1/R2 共用 `purifyMinRemainder` 安全阀。
   */
  purifyR1: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.purifyR1).volatile(),
  purifyR2: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.purifyR2).volatile(),
  purifyR3: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.purifyR3).volatile(),
  purifyMinRemainder: Schema.number().default(MEMORY_CONFIG_DEFAULTS.purifyMinRemainder).volatile(),
  /**
   * Story 11.2 / AD-38：Persona Spec 静态 section 的总开关（默认 false）。
   * 打开不等于注入：正文还必须经产品负责人批准（`PERSONA_SPEC_APPROVED`）且非空，
   * 三者同时成立才注册 `omw-persona`；批准前的默认语义是「没有静态人设承诺」。
   */
  personaSpecEnabled: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.personaSpecEnabled).volatile(),
  /**
   * Story 11.3 / T5、AD-38：反思观察写入 Self-Knowledge 候选区的开关（默认 false）。
   * 关闭时反思不产生任何候选（零候选，fail-closed）；打开也只写候选——候选默认不可见，
   * 只有独立晋升门产生的 accepted 才进常驻层（AD-39）。
   */
  selfKnowledgeCaptureEnabled: Schema.boolean().default(MEMORY_CONFIG_DEFAULTS.selfKnowledgeCaptureEnabled).volatile(),
  /** Story 9.1：本体约束闸门档位 + 逐维覆盖（默认 off，见上方 OntologyGateSchema）。 */
  ontologyGate: OntologyGateSchema,
})

/**
 * 解析后的运行时配置形态。
 * `embedding` 为降级开关：token 或 model 任一缺失即 'disabled'（FR-18）。
 * `warnings` 收集降级说明，调用方按需写入日志 / status（本 story 只落日志通道）。
 */
export interface RuntimeConfig {
  embedding: { endpoint?: string; token?: string; model?: string; dim?: number }
  embeddingMode: 'enabled' | 'disabled'
  captureSteps: number
  /** Story 10.1：token 触发账本的三个阈值（tokens，已过合法性校验）。 */
  captureTokens: number
  captureMinTokens: number
  captureMaxTokens: number
  inboxRefineConcurrency: number
  injectOnNewSession: boolean
  rrfK: number
  retrievalTopK: number
  layerWeights: { l2: number; l1: number }
  /** priority 二次加权系数（≥0；0 = 关闭 priority 对排序的影响，Story 3.1 / FR-16）。 */
  priorityWeight: number
  llmProvider?: string
  llmModel?: string
  systemOne: { enabled: boolean; endpoint?: string; model?: string; token?: string }
  /** 反思触发阈值（Story 7.2 / AD-37），已过合法性校验。 */
  reflection: { threshold: number; idleWaitMs: number; intervalMs: number }
  /** 策略采纳门（Story 7.3 / AD-20），已过合法性校验。 */
  strategyGate: { minConfidence: number; expiryDays: number; maxPendingPerSession: number }
  /** Story 8.1：compaction/start 未配对的解阻塞超时（ms，已校验为正整数）。 */
  compactionOrphanTimeoutMs: number
  /** Story 8.2：工具结果折叠阈值（tokens）。 */
  foldThresholdTokens: number
  /** Story 8.4：T1/T2/T3 长度三带阈值（tokens，已校验为正整数且 lengthMin < t3Threshold）。 */
  compactionLengthMin: number
  compactionT3Threshold: number
  /** Story 8.4 / FR-29：句柄展开计数与重写链深阈值（已校验为正整数）。 */
  expandCountThreshold: number
  chainDepthThreshold: number
  /** Story 8.4：自调开关（默认 false；无建议生产端时即使开启也不改数值）。 */
  compactionSelfTuneEnabled: boolean
  /** Story 8.5 / AC:1827：注入总预算的绝对上限（tokens，已校验为正整数）。 */
  injectionTokenCap: number
  /**
   * Story 8.5 / AC:1832：窗口占比（默认 0.5）。**刻意不在这里校验负数**：
   * 负 ratio 的语义是「预算按 0 计 + 可见告警」（由 `computeInjectionBudget` 产出），
   * 在这里抛错会让一句可解释的降级变成启动失败。
   */
  injectionRatio: number
  /** Story 8.5 / AC:1827：单条正文绝对上限（tokens，已校验为正整数）。 */
  injectionSingleCap: number
  /** Story 8.5 / AC:1827：摘要正文绝对上限（tokens，已校验为正整数）。 */
  injectionSummaryCap: number
  /** Story 8.5 / AC:1827：常驻层 / 动态骨架的绝对上限（tokens，不套窗口公式）。 */
  alwaysOnTokenCap: number
  /**
   * Story 8.6 / AC:1868：确定性净化 pass 的选项（结构同 `context/purify.ts` 的
   * `PurifyOptions`；**本文件不 import 它**，kernel 不得依赖 domain 层）。
   */
  purify: { r1: boolean; r2: boolean; r3: boolean; minRemainder: number }
  /**
   * Story 11.2 / AD-38：Persona Spec 静态 section 开关（默认 false）。
   * 打开后仍需 `PERSONA_SPEC_APPROVED` 为真且正文非空才注册（批准门在 `persona/spec.ts`）。
   */
  personaSpecEnabled: boolean
  /**
   * Story 11.3 / T5：反思观察写入 Self-Knowledge 候选区的开关（默认 false）。
   * 关闭时零候选；打开也只写候选，可见性仍由晋升门与 `isVisible` 决定。
   */
  selfKnowledgeCaptureEnabled: boolean
  /**
   * Story 9.1 / AD-31：本体约束闸门（判定侧）。`level` 默认 off；逐维覆盖缺省 = 沿用档位默认。
   * 结构上与 `ontology/gate.ts` 的 `OntologyGatePolicy` 同形，两处靠结构类型直接对接。
   */
  ontologyGate: OntologyGateConfig
  warnings: string[]
}

/** Story 9.1：本体闸门三档（off / align / strict；不设中间档）。 */
export type OntologyGateLevel = 'off' | 'align' | 'strict'

/** Story 9.1：闸门档位 + 逐维覆盖（未给的覆盖项 = 沿用档位默认）。 */
export interface OntologyGateConfig {
  readonly level: OntologyGateLevel
  readonly nameNormalization?: boolean
  readonly duplicateTypeDiscard?: boolean
  readonly entityType?: boolean
  readonly relationType?: boolean
  readonly domainRange?: boolean
  readonly datatype?: boolean
}

/** 统一读法：既接受 volatile 节点（.get()），也接受普通值，便于纯单测直接传值包装。 */
type Getter<T> = { get(): T } | T
function read<T>(field: Getter<T>): T {
  return typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function'
    ? (field as { get(): T }).get()
    : (field as T)
}

/** HTTP(S) URL 硬校验。失败抛 Error，消息含字段名 + 期望格式 + 当前值。 */
function requireHttpUrl(field: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let valid = false
  try {
    const protocol = new URL(raw).protocol
    valid = protocol === 'http:' || protocol === 'https:'
  } catch {
    valid = false
  }
  if (!valid) throw new Error(`${field}（期望 http(s):// URL，实际 ${JSON.stringify(raw)}）`)
  return raw
}

/** 正整数硬校验（captureSteps / inboxRefineConcurrency）。 */
function requirePositiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field}（期望 ≥ 1 的整数，实际 ${value}）`)
  }
  return value
}

/** 层权重硬校验：值必须 ∈ (0, 1]。 */
function requireUnitWeight(field: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${field}（期望 ∈ (0, 1]，实际 ${value}）`)
  }
  return value
}

/**
 * priority 二次加权系数硬校验（Story 3.1 / FR-16）：必须有限且 ≥ 0。
 * 0 是合法值（显式关闭 priority 对排序的影响），负数会让高优先级节点反被压低。
 */
function requireNonNegativeWeight(field: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field}（期望有限且 ≥ 0 的数，实际 ${value}）`)
  }
  return value
}

/**
 * Story 9.1：逐维开关的严格布尔校验。未给 = undefined（沿用档位默认）；给了非布尔值 =
 * 配置错误（静默 truthy 强转会让「关闭这一维」与「拼错字段」产生同样的结果）。
 */
function optionalBoolean(field: string, value: boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${field}（期望布尔值，实际 ${JSON.stringify(value)}）`)
  return value
}

/** 把一维覆盖收进 config 对象；未给（undefined）时不落键，保证「缺省 = 沿用档位默认」。 */
function gateOverride<K extends Exclude<keyof OntologyGateConfig, 'level'>>(
  key: K,
  value: boolean | undefined,
): Pick<OntologyGateConfig, K> | Record<string, never> {
  const checked = optionalBoolean('ontologyGate.' + key, value)
  return checked === undefined ? {} : ({ [key]: checked } as Pick<OntologyGateConfig, K>)
}

/**
 * 分级校验入口。
 * 硬校验失败即抛 Error（仅阻塞本插件，宿主继续运行）；
 * Embedding token/model 缺失走降级（warn + embeddingMode='disabled'，FR-18）。
 * 凭据字段（token）的错误信息固定只含字段名，值本身是秘密，不得入错误日志（NFR9）。
 */
export function resolveRuntimeConfig(config: {
  embedding?: Getter<{ endpoint?: string; token?: string; model?: string; dim?: number }>
  captureSteps?: Getter<number>
  captureTokens?: Getter<number>
  captureMinTokens?: Getter<number>
  captureMaxTokens?: Getter<number>
  inboxRefineConcurrency?: Getter<number>
  injectOnNewSession?: Getter<boolean>
  rrfK?: Getter<number>
  retrievalTopK?: Getter<number>
  layerWeights?: Getter<{ l2?: number; l1?: number }>
  priorityWeight?: Getter<number>
  llmProvider?: Getter<string | undefined>
  llmModel?: Getter<string | undefined>
  systemOne?: Getter<{ enabled?: boolean; endpoint?: string; model?: string; token?: string }>
    reflection?: Getter<{ threshold?: number; idleWaitMs?: number; intervalMs?: number }>
    strategyGate?: Getter<{ minConfidence?: number; expiryDays?: number; maxPendingPerSession?: number }>
    compactionOrphanTimeoutMs?: Getter<number>
    foldThresholdTokens?: Getter<number>
    compactionLengthMin?: Getter<number>
    compactionT3Threshold?: Getter<number>
    expandCountThreshold?: Getter<number>
    chainDepthThreshold?: Getter<number>
    compactionSelfTuneEnabled?: Getter<boolean>
    injectionTokenCap?: Getter<number>
    injectionRatio?: Getter<number>
    injectionSingleCap?: Getter<number>
    injectionSummaryCap?: Getter<number>
    alwaysOnTokenCap?: Getter<number>
    purifyR1?: Getter<boolean>
    purifyR2?: Getter<boolean>
    purifyR3?: Getter<boolean>
    purifyMinRemainder?: Getter<number>
    personaSpecEnabled?: Getter<boolean>
    selfKnowledgeCaptureEnabled?: Getter<boolean>
    ontologyGate?: Getter<{
      level?: string
      nameNormalization?: boolean
      duplicateTypeDiscard?: boolean
      entityType?: boolean
      relationType?: boolean
      domainRange?: boolean
      datatype?: boolean
    }>
}): RuntimeConfig {
  const warnings: string[] = []

  // Embedding endpoint：填了就硬校验 http(s)
  const embeddingRaw = read(config.embedding ?? {}) as { endpoint?: string; token?: string; model?: string; dim?: number }
  const embeddingEndpoint = requireHttpUrl('embedding.endpoint', embeddingRaw.endpoint)
  // dim 可留空（由 db 层按模型表/默认值解析），填了就必须是正整数（AC2：按配置 pin）。
  const embeddingDim = embeddingRaw.dim === undefined ? undefined : requirePositiveInt('embedding.dim', embeddingRaw.dim)

  // Embedding endpoint / token / model：任一缺失即降级，不抛错（FR-18）。
  // endpoint 也纳入判据（评审 T6）：客户端构造要求 endpoint，只按 token+model 判 enabled
  // 会造出「假启用态」：L1 静默写 NULL 向量且无审计，而 /memory status 仍打印 enabled。
  const token = embeddingRaw.token?.trim() || ''
  const model = embeddingRaw.model?.trim() || ''
  let embeddingMode: RuntimeConfig['embeddingMode'] = 'enabled'
  if (!embeddingEndpoint || !token || !model) {
    embeddingMode = 'disabled'
    const missing = [
      !embeddingEndpoint ? 'embedding.endpoint' : null,
      !token ? 'embedding.token' : null,
      !model ? 'embedding.model' : null,
    ].filter(Boolean).join(' / ')
    warnings.push(`embedding 降级为 disabled：缺少 ${missing}（可留空走关键词单路）`)
  }

  const captureSteps = requirePositiveInt('captureSteps', read(config.captureSteps ?? MEMORY_CONFIG_DEFAULTS.captureSteps))
  // Story 10.1 / AC:2070：三阈值各 ≥1，且必须构成 min ≤ tokens ≤ max（否则「累计到下次」
  // 与「按上限切片」互相矛盾，配置错误会静默变成永不触发或每轮触发）。
  const captureTokens = requirePositiveInt(
    'captureTokens',
    read(config.captureTokens ?? MEMORY_CONFIG_DEFAULTS.captureTokens),
  )
  const captureMinTokens = requirePositiveInt(
    'captureMinTokens',
    read(config.captureMinTokens ?? MEMORY_CONFIG_DEFAULTS.captureMinTokens),
  )
  const captureMaxTokens = requirePositiveInt(
    'captureMaxTokens',
    read(config.captureMaxTokens ?? MEMORY_CONFIG_DEFAULTS.captureMaxTokens),
  )
  if (captureMinTokens > captureTokens || captureTokens > captureMaxTokens) {
    throw new Error(
      `captureMinTokens / captureTokens / captureMaxTokens（期望 min ≤ tokens ≤ max，实际 ` +
      `${captureMinTokens} / ${captureTokens} / ${captureMaxTokens}）`,
    )
  }
  const inboxRefineConcurrency = requirePositiveInt('inboxRefineConcurrency', read(config.inboxRefineConcurrency ?? MEMORY_CONFIG_DEFAULTS.inboxRefineConcurrency))
  const rrfK = read(config.rrfK ?? MEMORY_CONFIG_DEFAULTS.rrfK)
  if (!Number.isFinite(rrfK) || rrfK <= 0) {
    throw new Error(`rrfK（期望 > 0 的数，实际 ${rrfK}）`)
  }
  // F-12：与相邻 rrfK 同款硬校验，生成为 NaN/0/负数会被 `Math.max(1, Math.trunc(...))`
  // 静默变成 1（或把 NaN 绑进 $k/TOP 变成查询期失败），配错必须 fail-loud。
  const retrievalTopK = requirePositiveInt('retrievalTopK', read(config.retrievalTopK ?? MEMORY_CONFIG_DEFAULTS.retrievalTopK))

  const weightsRaw = read(config.layerWeights ?? {}) as { l2?: number; l1?: number }
  const l2 = requireUnitWeight('layerWeights.l2', weightsRaw.l2 ?? MEMORY_CONFIG_DEFAULTS.layerWeights.l2)
  const l1 = requireUnitWeight('layerWeights.l1', weightsRaw.l1 ?? MEMORY_CONFIG_DEFAULTS.layerWeights.l1)
  const priorityWeight = requireNonNegativeWeight('priorityWeight', read(config.priorityWeight ?? MEMORY_CONFIG_DEFAULTS.priorityWeight))

  // Story 7.2 / AD-37：三项阈值都是 `number`，但 0 / 负数 / NaN 会让判定退化成「每 turn 都反思」
  // 或「永不反思」，两者都是静默事故 ⇒ 正数硬校验（与 captureSteps 同一口径）。
  const reflectionRaw = read(config.reflection ?? {}) as {
    threshold?: number
    idleWaitMs?: number
    intervalMs?: number
  }
  const compactionOrphanTimeoutMs = requirePositiveInt(
    'compactionOrphanTimeoutMs',
    Math.trunc(read(config.compactionOrphanTimeoutMs ?? MEMORY_CONFIG_DEFAULTS.compactionOrphanTimeoutMs)),
  )
  const foldThresholdTokens = requirePositiveInt(
    'foldThresholdTokens',
    Math.trunc(read(config.foldThresholdTokens ?? MEMORY_CONFIG_DEFAULTS.foldThresholdTokens)),
  )
  // Story 8.4（AC:1713-1760）：两条长度阈值必须构成合法三带（lengthMin < t3Threshold），
  // 否则 `<lengthMin ⇒ T1` 与 `>=t3Threshold ⇒ T3` 会自相矛盾，档位判定静默退化。
  // 刻意**不** `Math.trunc`：2.5 这种值截断后就成了合法阈值，属于「静默夹紧」。
  const compactionLengthMin = requirePositiveInt(
    'compactionLengthMin',
    read(config.compactionLengthMin ?? MEMORY_CONFIG_DEFAULTS.compactionLengthMin),
  )
  const compactionT3Threshold = requirePositiveInt(
    'compactionT3Threshold',
    read(config.compactionT3Threshold ?? MEMORY_CONFIG_DEFAULTS.compactionT3Threshold),
  )
  if (compactionLengthMin >= compactionT3Threshold) {
    throw new Error(
      `compactionLengthMin（期望 < compactionT3Threshold，实际 ${compactionLengthMin} vs ${compactionT3Threshold}）`,
    )
  }
  const expandCountThreshold = requirePositiveInt(
    'expandCountThreshold',
    read(config.expandCountThreshold ?? MEMORY_CONFIG_DEFAULTS.expandCountThreshold),
  )
  const chainDepthThreshold = requirePositiveInt(
    'chainDepthThreshold',
    read(config.chainDepthThreshold ?? MEMORY_CONFIG_DEFAULTS.chainDepthThreshold),
  )
  const compactionSelfTuneEnabled = read(
    config.compactionSelfTuneEnabled ?? MEMORY_CONFIG_DEFAULTS.compactionSelfTuneEnabled,
  ) === true
  // Story 8.5 / AC:1826-1832：四项注入预算上限必须可运行期覆盖（INV-12），且都是正数。
  // 0 / 负数 / NaN 会让注入静默变成「零注入」或「无限注入」，与 captureSteps 同款 fail-loud。
  const injectionTokenCap = requirePositiveInt(
    'injectionTokenCap',
    read(config.injectionTokenCap ?? MEMORY_CONFIG_DEFAULTS.injectionTokenCap),
  )
  const injectionSingleCap = requirePositiveInt(
    'injectionSingleCap',
    read(config.injectionSingleCap ?? MEMORY_CONFIG_DEFAULTS.injectionSingleCap),
  )
  const injectionSummaryCap = requirePositiveInt(
    'injectionSummaryCap',
    read(config.injectionSummaryCap ?? MEMORY_CONFIG_DEFAULTS.injectionSummaryCap),
  )
  const alwaysOnTokenCap = requirePositiveInt(
    'alwaysOnTokenCap',
    read(config.alwaysOnTokenCap ?? MEMORY_CONFIG_DEFAULTS.alwaysOnTokenCap),
  )
  // Story 8.6 / AC:1868：净化四开关。三个布尔保持原样（缺省取 schema 同源默认值）；
  // `purifyMinRemainder` 与相邻阈值同款硬校验（0 / 负数 / NaN 会让 R2 的安全阀失效）。
  const purifyR1 = read(config.purifyR1 ?? MEMORY_CONFIG_DEFAULTS.purifyR1) === true
  const purifyR2 = read(config.purifyR2 ?? MEMORY_CONFIG_DEFAULTS.purifyR2) === true
  const purifyR3 = read(config.purifyR3 ?? MEMORY_CONFIG_DEFAULTS.purifyR3) === true
  const purifyMinRemainder = requirePositiveInt(
    'purifyMinRemainder',
    read(config.purifyMinRemainder ?? MEMORY_CONFIG_DEFAULTS.purifyMinRemainder),
  )
  // Story 11.2 / AD-38：Persona Spec 开关。布尔保持原样（缺省取 schema 同源默认值 = false）；
  // 打开也不代表会注入——批准门与空正文判据在 persona/spec.ts。
  const personaSpecEnabled = read(config.personaSpecEnabled ?? MEMORY_CONFIG_DEFAULTS.personaSpecEnabled) === true
  // Story 11.3 / T5：Self-Knowledge 采集开关。布尔保持原样（缺省 false）；打开也只写候选区，
  // 可见性由晋升门与 isVisible 决定，不在这里做任何可见性判断。
  const selfKnowledgeCaptureEnabled =
    read(config.selfKnowledgeCaptureEnabled ?? MEMORY_CONFIG_DEFAULTS.selfKnowledgeCaptureEnabled) === true
  // ratio 的负数/非有限值不抛错：语义是「预算 0 + 可见告警」（AC:1832，由 T1 产出 warning）。
  const injectionRatio = Number(read(config.injectionRatio ?? MEMORY_CONFIG_DEFAULTS.injectionRatio))
  // Story 9.1 / AD-31：闸门档位只认三档（拼错档位会静默退化成「哪几维默认开」的猜测，
  // 与 AD-31「三档硬编码」冲突）；逐维覆盖只认布尔。
  const ontologyRaw = read(config.ontologyGate ?? {}) as {
    level?: string
    nameNormalization?: boolean
    duplicateTypeDiscard?: boolean
    entityType?: boolean
    relationType?: boolean
    domainRange?: boolean
    datatype?: boolean
  }
  const ontologyLevelRaw = ontologyRaw.level ?? MEMORY_CONFIG_DEFAULTS.ontologyGateLevel
  if (ontologyLevelRaw !== 'off' && ontologyLevelRaw !== 'align' && ontologyLevelRaw !== 'strict') {
    throw new Error(
      `ontologyGate.level（期望 off / align / strict，实际 ${JSON.stringify(ontologyLevelRaw)}）`,
    )
  }
  const ontologyGate = {
    level: ontologyLevelRaw as OntologyGateLevel,
    ...gateOverride('nameNormalization', ontologyRaw.nameNormalization),
    ...gateOverride('duplicateTypeDiscard', ontologyRaw.duplicateTypeDiscard),
    ...gateOverride('entityType', ontologyRaw.entityType),
    ...gateOverride('relationType', ontologyRaw.relationType),
    ...gateOverride('domainRange', ontologyRaw.domainRange),
    ...gateOverride('datatype', ontologyRaw.datatype),
  }
  requirePositiveInt('reflection.threshold', Math.trunc(reflectionRaw.threshold ?? MEMORY_CONFIG_DEFAULTS.reflectionThreshold))
  requirePositiveInt('reflection.idleWaitMs', Math.trunc(reflectionRaw.idleWaitMs ?? MEMORY_CONFIG_DEFAULTS.reflectionIdleWaitMs))
  requirePositiveInt('reflection.intervalMs', Math.trunc(reflectionRaw.intervalMs ?? MEMORY_CONFIG_DEFAULTS.reflectionIntervalMs))

  // Story 7.3 / AD-20：minConfidence 必须在 [0,1]（越界会让「永不采纳」或「全采纳」静默发生）。
  const strategyRaw = read(config.strategyGate ?? {}) as {
    minConfidence?: number
    expiryDays?: number
    maxPendingPerSession?: number
  }
  const strategyMinConfidence = Number(strategyRaw.minConfidence ?? MEMORY_CONFIG_DEFAULTS.strategyMinConfidence)
  if (!Number.isFinite(strategyMinConfidence) || strategyMinConfidence < 0 || strategyMinConfidence > 1) {
    throw new Error(`strategyGate.minConfidence（期望 [0,1]，实际 ${String(strategyRaw.minConfidence)}）`)
  }
  requirePositiveInt('strategyGate.expiryDays', Math.trunc(strategyRaw.expiryDays ?? MEMORY_CONFIG_DEFAULTS.strategyExpiryDays))
  requirePositiveInt(
    'strategyGate.maxPendingPerSession',
    Math.trunc(strategyRaw.maxPendingPerSession ?? MEMORY_CONFIG_DEFAULTS.strategyMaxPendingPerSession),
  )


  const systemOneRaw = read(config.systemOne ?? {}) as {
    enabled?: boolean
    endpoint?: string
    model?: string
    token?: string
  }
  const systemOneEnabled = systemOneRaw.enabled ?? MEMORY_CONFIG_DEFAULTS.systemOneEnabled
  // 端点填了就硬校验（与 embedding.endpoint 同一口径）；token 只做 trim，值本身不落任何输出。
  const systemOneEndpoint = requireHttpUrl('systemOne.endpoint', systemOneRaw.endpoint)
  const systemOneModel = systemOneRaw.model?.trim() || undefined
  const systemOneToken = systemOneRaw.token?.trim() || undefined
  const injectOnNewSession = read(config.injectOnNewSession ?? MEMORY_CONFIG_DEFAULTS.injectOnNewSession)
  const llmProvider = read(config.llmProvider ?? undefined)
  const llmModel = read(config.llmModel ?? undefined)

  return {
    embedding: {
      endpoint: embeddingEndpoint,
      token: token || undefined,
      model: model || undefined,
      dim: embeddingDim,
    },
    embeddingMode,
    captureSteps,
    captureTokens,
    captureMinTokens,
    captureMaxTokens,
    inboxRefineConcurrency,
    injectOnNewSession,
    rrfK,
    retrievalTopK,
    layerWeights: { l2, l1 },
    priorityWeight,
    llmProvider: llmProvider || undefined,
    llmModel: llmModel || undefined,
    systemOne: {
      enabled: systemOneEnabled,
      endpoint: systemOneEndpoint,
      model: systemOneModel,
      token: systemOneToken,
    },
    // Story 7.2 / AD-37：三项阈值必须在 schema 与这里同源（`MEMORY_CONFIG_DEFAULTS`）。
    reflection: {
      threshold: Number(reflectionRaw.threshold ?? MEMORY_CONFIG_DEFAULTS.reflectionThreshold),
      idleWaitMs: Number(reflectionRaw.idleWaitMs ?? MEMORY_CONFIG_DEFAULTS.reflectionIdleWaitMs),
      intervalMs: Number(reflectionRaw.intervalMs ?? MEMORY_CONFIG_DEFAULTS.reflectionIntervalMs),
    },
    compactionOrphanTimeoutMs,
    foldThresholdTokens,
    compactionLengthMin,
    compactionT3Threshold,
    expandCountThreshold,
    chainDepthThreshold,
    compactionSelfTuneEnabled,
    injectionTokenCap,
    injectionRatio,
    injectionSingleCap,
    injectionSummaryCap,
    alwaysOnTokenCap,
    // Story 8.6 / AC:1868：净化选项与 schema 的 `default(...)` 同源（MEMORY_CONFIG_DEFAULTS）。
    purify: { r1: purifyR1, r2: purifyR2, r3: purifyR3, minRemainder: purifyMinRemainder },
    personaSpecEnabled,
    selfKnowledgeCaptureEnabled,
    ontologyGate,
    strategyGate: {
      minConfidence: strategyMinConfidence,
      expiryDays: Number(strategyRaw.expiryDays ?? MEMORY_CONFIG_DEFAULTS.strategyExpiryDays),
      maxPendingPerSession: Number(
        strategyRaw.maxPendingPerSession ?? MEMORY_CONFIG_DEFAULTS.strategyMaxPendingPerSession,
      ),
    },
    warnings,
  }
}

/**
 * Schema 字段类型（供外部消费者 / IDE 类型推导）。
 * 每字段对应一个 volatile 节点，读取用 `.get()`。
 */
export interface ConfigShape {
  embedding: Volatile<{ endpoint?: string; token?: string; model?: string; dim?: number }>
  rerank: Volatile<{ endpoint?: string; token?: string; model?: string }>
  captureSteps: Volatile<number>
  inboxRefineConcurrency: Volatile<number>
  injectOnNewSession: Volatile<boolean>
  rrfK: Volatile<number>
  retrievalTopK: Volatile<number>
  layerWeights: Volatile<{ l2: number; l1: number }>
  priorityWeight: Volatile<number>
  llmProvider: Volatile<string | undefined>
  llmModel: Volatile<string | undefined>
  systemOne: Volatile<{ enabled: boolean; endpoint?: string; model?: string; token?: string }>
  reflection: Volatile<{ threshold: number; idleWaitMs: number; intervalMs: number }>
  strategyGate: Volatile<{ minConfidence: number; expiryDays: number; maxPendingPerSession: number }>
  compactionLengthMin: Volatile<number>
  compactionT3Threshold: Volatile<number>
  expandCountThreshold: Volatile<number>
  chainDepthThreshold: Volatile<number>
  compactionSelfTuneEnabled: Volatile<boolean>
  injectionTokenCap: Volatile<number>
  injectionRatio: Volatile<number>
  injectionSingleCap: Volatile<number>
  injectionSummaryCap: Volatile<number>
  alwaysOnTokenCap: Volatile<number>
  purifyR1: Volatile<boolean>
  purifyR2: Volatile<boolean>
  purifyR3: Volatile<boolean>
  purifyMinRemainder: Volatile<number>
  personaSpecEnabled: Volatile<boolean>
  selfKnowledgeCaptureEnabled: Volatile<boolean>
  /** Story 9.1：本体闸门档位 + 逐维覆盖（默认 level=off）。 */
  ontologyGate: Volatile<OntologyGateConfig>
}

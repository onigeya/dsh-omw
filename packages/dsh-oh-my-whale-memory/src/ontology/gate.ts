/**
 * 抽取期闭世界形状闸门（Story 9.1 / FR-32 / AD-31 / INV-17）。
 *
 * 这是一个**纯函数**：输入 = 冻结的 {@link OntologyIndex} + 一条 {@link CandidateAssertion}
 * + 策略；输出 = 通过 / 丢弃 + 触发维度。无 LLM、无时钟、无随机、无 I/O，查表 O(1)。
 *
 * 六维（AD-31:436）各维独立、失败姿态 = 丢弃：
 * ① 名称归一化；② 丢弃「重复陈述实体自身类型」的退化断言；③ 实体类型须已声明；
 * ④ 关系类型须已声明；⑤ 域 / 值域相容；⑥ 数据类型相容。
 *
 * 未解析 ≠ 违反：未声明的类只被第 ③ 维拒绝，第 ⑤ 维必须放行；某一维关闭后不得通过
 * 其它维间接生效（这是「各维独立」的可断言含义）。
 */
import { normalizeOntologyName, type CandidateAssertion, type OntologyIndex } from './index.js'

/** 三维判定档位（spec-9.1 T2；不提供「只靠提示词措辞区分」的中间档）。 */
export type OntologyGateLevel = 'off' | 'align' | 'strict'

/** 六维的稳定标识（账本分桶与 status 计数共用；顺序即判定顺序）。 */
export const ONTOLOGY_DIMENSIONS = [
  'nameNormalization',
  'duplicateTypeDiscard',
  'entityType',
  'relationType',
  'domainRange',
  'datatype',
] as const

export type OntologyDimension = (typeof ONTOLOGY_DIMENSIONS)[number]

/** 各维开关（`true` = 该维生效）。 */
export type OntologyDimensionSwitches = Readonly<Record<OntologyDimension, boolean>>

/** 闸门策略：档位 + 逐维覆盖（覆盖项缺省表示沿用档位默认）。 */
export interface OntologyGatePolicy {
  readonly level: OntologyGateLevel
  readonly nameNormalization?: boolean
  readonly duplicateTypeDiscard?: boolean
  readonly entityType?: boolean
  readonly relationType?: boolean
  readonly domainRange?: boolean
  readonly datatype?: boolean
}

/** 档位 → 各维默认开关（`off` 全关；`align` 除 ② 外全开；`strict` 六维全开）。 */
const LEVEL_DEFAULTS: Readonly<Record<OntologyGateLevel, OntologyDimensionSwitches>> = Object.freeze({
  off: Object.freeze({
    nameNormalization: false,
    duplicateTypeDiscard: false,
    entityType: false,
    relationType: false,
    domainRange: false,
    datatype: false,
  }),
  align: Object.freeze({
    nameNormalization: true,
    // ② 是「重复陈述实体自身类型」的退化断言清理；align 保留它、strict 才丢弃，
    // 这是两档之间唯一可观察的严格度差异（矩阵行 9）。
    duplicateTypeDiscard: false,
    entityType: true,
    relationType: true,
    domainRange: true,
    datatype: true,
  }),
  strict: Object.freeze({
    nameNormalization: true,
    duplicateTypeDiscard: true,
    entityType: true,
    relationType: true,
    domainRange: true,
    datatype: true,
  }),
})

/**
 * 解析生效开关：档位默认值 + 逐维覆盖。
 *
 * 逐维覆盖是「该维不再生效」的唯一入口；返回对象顺序由 {@link ONTOLOGY_DIMENSIONS}
 * 固定，不依赖对象键序（INV-17）。
 */
export function resolveDimensionSwitches(policy: OntologyGatePolicy): OntologyDimensionSwitches {
  // `off` 是硬身份档：即使配了逐维覆盖也必须全关，否则「off 产出的图与未启用本体逐条一致」
  // （SM-9 ④）不成立。逐维覆盖只在 align / strict 之上生效。
  if (policy.level === 'off') return LEVEL_DEFAULTS.off
  const defaults = LEVEL_DEFAULTS[policy.level]
  return Object.freeze({
    nameNormalization: policy.nameNormalization ?? defaults.nameNormalization,
    duplicateTypeDiscard: policy.duplicateTypeDiscard ?? defaults.duplicateTypeDiscard,
    entityType: policy.entityType ?? defaults.entityType,
    relationType: policy.relationType ?? defaults.relationType,
    domainRange: policy.domainRange ?? defaults.domainRange,
    datatype: policy.datatype ?? defaults.datatype,
  })
}

/** 是否至少有一维生效（全关 = 与未启用本体逐条一致；处理器据此完全跳过判定）。 */
export function isOntologyGateActive(policy: OntologyGatePolicy): boolean {
  const switches = resolveDimensionSwitches(policy)
  for (const dimension of ONTOLOGY_DIMENSIONS) {
    if (switches[dimension]) return true
  }
  return false
}

/** 判定结果二元形态：通过，或丢弃并给出首个触发维度。 */
export type CandidateVerdict =
  | { readonly passed: true; readonly dimension: null }
  | { readonly passed: false; readonly dimension: OntologyDimension }

const PASS: CandidateVerdict = Object.freeze({ passed: true, dimension: null })

function drop(dimension: OntologyDimension): CandidateVerdict {
  return { passed: false, dimension }
}

/** 字段是否「有值」（null / undefined / 纯空白视为未解析）。 */
function hasValue(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.trim().length > 0
}

/**
 * 单条候选判定（T2）。
 *
 * 判定顺序固定为 ①→⑥，返回**首个**不通过维度：一条候选最多计入一个桶，所以
 * 「各维丢弃数之和 = 候选丢失总数」在调用方侧自然成立（AD-31:443）。
 */
export function classifyCandidate(
  candidate: CandidateAssertion,
  index: OntologyIndex,
  policy: OntologyGatePolicy,
): CandidateVerdict {
  const switches = resolveDimensionSwitches(policy)

  // ① 名称归一化：字段在、但归一化失败（空 / 内部空白）⇒ 丢弃。关闭时不做任何校验，
  //    也不把非法名称转交给别的维（关闭维度互不泄漏）。
  if (switches.nameNormalization) {
    const fields: readonly (string | null | undefined)[] = [
      candidate.subject,
      candidate.type,
      candidate.relation,
      candidate.object,
      candidate.objectType,
      candidate.datatype,
    ]
    for (const field of fields) {
      // 显式给了值（含空串）就必须是合法名称；undefined / null 才表示「这一维没提供」。
      if (field !== undefined && field !== null && normalizeOntologyName(field) === null) {
        return drop('nameNormalization')
      }
    }
  }

  // ② 丢弃「重复陈述实体自身类型」的退化断言：subject 与 object 是同一实体、
  //    type 与 objectType 是同一类型（例如 `Person -[type]-> Person`）。
  if (switches.duplicateTypeDiscard) {
    const subject = normalizeOntologyName(candidate.subject)
    const object = hasValue(candidate.object) ? normalizeOntologyName(candidate.object) : null
    const type = hasValue(candidate.type) ? normalizeOntologyName(candidate.type) : null
    const objectType = hasValue(candidate.objectType) ? normalizeOntologyName(candidate.objectType) : null
    if (subject !== null && object !== null && type !== null && objectType !== null) {
      if (subject === object && type === objectType) return drop('duplicateTypeDiscard')
    }
  }

  // ③ 实体类型：subject 的 type 必须已声明（未声明 = 这一维拒绝）；objectType 若给出也须已声明。
  //    本维只看类型字段，不看 subject/object 名称本身（那属 ①；两维互不泄漏）。
  if (switches.entityType) {
    if (!hasValue(candidate.type) || !index.hasEntityType(candidate.type)) return drop('entityType')
    if (hasValue(candidate.objectType) && !index.hasEntityType(candidate.objectType)) return drop('entityType')
  }

  // ④ 关系类型：声明了关系才检查；未声明关系 ⇒ 丢弃。没有关系 = 类型断言，本维放行。
  if (switches.relationType && hasValue(candidate.relation)) {
    if (!index.hasRelation(candidate.relation)) return drop('relationType')
  }

  // ⑤ 域 / 值域：只有关系、两端类型都**已解析且已声明**时才可能不符；任何未解析 /
  //    未声明的类都必须放行（AD-31：未解析 ≠ 违反）。
  if (switches.domainRange && hasValue(candidate.relation)) {
    const relation = index.relation(candidate.relation)
    const type = hasValue(candidate.type) ? normalizeOntologyName(candidate.type) : null
    const objectType = hasValue(candidate.objectType) ? normalizeOntologyName(candidate.objectType) : null
    if (relation !== null && type !== null && objectType !== null) {
      // 只对**已声明**的类型做域 / 值域相容性比较：未声明的类归 ③ 管，⑤ 必须放行
      //（即使 ③ 被关闭，⑤ 也不得间接接手）。
      if (index.hasEntityType(type) && relation.domain.length > 0 && !relation.domain.includes(type)) {
        return drop('domainRange')
      }
      if (index.hasEntityType(objectType) && relation.range.length > 0 && !relation.range.includes(objectType)) {
        return drop('domainRange')
      }
    }
  }

  // ⑥ 数据类型：候选给出的 datatype 必须已在词表中声明；关系还声明了 datatype 时再比较相容性。
  //    任一侧缺失都放行（未解析 ≠ 违反）。
  if (switches.datatype && hasValue(candidate.datatype)) {
    const datatype = normalizeOntologyName(candidate.datatype)
    if (datatype === null || !index.hasDatatype(datatype)) return drop('datatype')
    if (hasValue(candidate.relation)) {
      const relation = index.relation(candidate.relation)
      if (relation !== null && relation.datatype !== null && relation.datatype !== datatype) {
        return drop('datatype')
      }
    }
  }

  return PASS
}

/**
 * 抽取期本体约束闸门 —— 判定侧的内存索引（Story 9.1 / AD-31、INV-17）。
 *
 * 范围锁定（spec-9.1 T1 / 范围与边界）：
 * - 只做**判定输入**：实体类型、关系类型、域 / 值域、数据类型与名称归一化后的查表；
 * - 不解析 Turtle、不读文件、不落 RDF、不物化推理闭包（解析与词表渲染属 Story 9.2）；
 * - 构建时**显式排序**并**冻结**（INV-17：无哈希 / 插入序依赖，索引只读）。
 *
 * 纯 TS：本文件不 import LLM / 时钟 / 随机 / I/O，也不 import 任何存储层。
 */

/** 一条关系声明（域 / 值域 / 数据类型都可缺省；缺省表示「本维无约束」）。 */
export interface OntologyRelationShape {
  /** 归一化后的关系名（查表键）。 */
  readonly name: string
  /** 允许的 subject 实体类型（归一化、显式排序、去重）。空数组 = 不限。 */
  readonly domain: readonly string[]
  /** 允许的 object 实体类型（归一化、显式排序、去重）。空数组 = 不限。 */
  readonly range: readonly string[]
  /** 该关系声明的对象数据类型（归一化）；null = 不限。 */
  readonly datatype: string | null
}

/** 冻结后的只读本体索引：判定侧唯一输入（Story 9.2 的解析产物未来落成这个形状）。 */
export interface OntologyIndex {
  /** 全量实体类型（归一化、显式字典序）。 */
  readonly entityTypes: readonly string[]
  /** 全量关系声明（按 name 显式字典序）。 */
  readonly relations: readonly OntologyRelationShape[]
  /** 全量数据类型（归一化、显式字典序；含关系声明上的 datatype）。 */
  readonly datatypes: readonly string[]
  /** 实体类型是否已声明（O(1)）。 */
  hasEntityType(name: string): boolean
  /** 关系类型是否已声明（O(1)）。 */
  hasRelation(name: string): boolean
  /** 取关系声明（未声明返回 null，O(1)）。 */
  relation(name: string): OntologyRelationShape | null
  /** 数据类型是否已声明（O(1)）。 */
  hasDatatype(name: string): boolean
}

/** 关系声明输入（字符串形式等价于只有 name 的声明）。 */
export interface OntologyRelationInput {
  readonly name: string
  readonly domain?: readonly string[]
  readonly range?: readonly string[]
  readonly datatype?: string
}

/** 本体输入：固定内存结构，可由 Story 9.2 的 Turtle 解析器产出，也可由测试直接构造。 */
export interface OntologyInput {
  readonly entityTypes?: readonly string[]
  readonly relationTypes?: readonly (string | OntologyRelationInput)[]
  readonly datatypes?: readonly string[]
}

/**
 * 候选断言（spec-9.1 T1）：subject / type / relation / object / objectType / datatype。
 *
 * 只有 subject 必填；`type` 是 subject 的实体类型，`objectType` 是 object 的实体类型，
 * `datatype` 是 object 的数据类型。未填的字段按「未解析」处理，判定侧不把它当违反
 * （AD-31：未解析 ≠ 违反）。
 */
export interface CandidateAssertion {
  readonly subject: string
  readonly type?: string | null
  readonly relation?: string | null
  readonly object?: string | null
  readonly objectType?: string | null
  readonly datatype?: string | null
}

/**
 * 名称归一化（spec-9.1 矩阵行 1）：去首尾空白、大小写折叠。
 *
 * 返回 null = 非法名称（空串 / 纯空白 / 内部含空白）。判定侧只把 null 当作「这一维不通过」，
 * 不把它混进别的维度（关闭维度互不泄漏）。
 *
 * 注意：这是**判定键**的归一化，不是 RDF IRI 的语义归一化；IRI 的大小写会被折叠成同一键。
 */
export function normalizeOntologyName(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/\s/.test(trimmed)) return null
  return trimmed.toLowerCase()
}

/** 显式排序比较器（INV-17：不依赖哈希序 / 插入序）。 */
function compareNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** 归一化 + 去重 + 显式排序；任一名称非法即抛（本体加载失败属基础设施故障，走整闸 fail-open）。 */
function normalizeNameList(rawList: readonly string[] | undefined, field: string): readonly string[] {
  const seen = new Set<string>()
  for (const raw of rawList ?? []) {
    const normalized = normalizeOntologyName(raw)
    if (normalized === null) {
      throw new Error(`ontology-index: ${field} 含非法名称 ${JSON.stringify(raw)}`)
    }
    seen.add(normalized)
  }
  return Object.freeze([...seen].sort(compareNames))
}

/**
 * 构建冻结的只读索引（T1）。
 *
 * 输入顺序不影响产物：名称集合显式排序；同名关系重复声明直接抛错（不静默择一，
 * 否则产物取决于插入序，违反 INV-17）。
 */
export function buildOntologyIndex(input: OntologyInput): OntologyIndex {
  const entityTypes = normalizeNameList(input.entityTypes, 'entityTypes')
  const datatypes = new Set<string>(normalizeNameList(input.datatypes, 'datatypes'))
  const relationMap = new Map<string, OntologyRelationShape>()

  for (const raw of input.relationTypes ?? []) {
    const declaration: OntologyRelationInput = typeof raw === 'string' ? { name: raw } : raw
    const name = normalizeOntologyName(declaration.name)
    if (name === null) {
      throw new Error(`ontology-index: relationTypes 含非法名称 ${JSON.stringify(declaration.name)}`)
    }
    if (relationMap.has(name)) {
      throw new Error(`ontology-index: relationTypes 重复声明 ${JSON.stringify(name)}`)
    }
    const datatype = declaration.datatype === undefined ? null : normalizeOntologyName(declaration.datatype)
    if (declaration.datatype !== undefined && datatype === null) {
      throw new Error(`ontology-index: relation ${JSON.stringify(name)} 的 datatype 非法`)
    }
    if (datatype !== null) datatypes.add(datatype)
    relationMap.set(name, Object.freeze({
      name,
      domain: normalizeNameList(declaration.domain, `relation ${JSON.stringify(name)} 的 domain`),
      range: normalizeNameList(declaration.range, `relation ${JSON.stringify(name)} 的 range`),
      datatype,
    }))
  }

  const relations = Object.freeze([...relationMap.values()].sort((left, right) => compareNames(left.name, right.name)))
  const sortedDatatypes = Object.freeze([...datatypes].sort(compareNames))
  const entityTypeSet = new Set(entityTypes)
  const relationNames = new Set(relations.map((relation) => relation.name))
  const datatypeSet = new Set(sortedDatatypes)

  return Object.freeze({
    entityTypes,
    relations,
    datatypes: sortedDatatypes,
    hasEntityType(name: string): boolean {
      const normalized = normalizeOntologyName(name)
      return normalized !== null && entityTypeSet.has(normalized)
    },
    hasRelation(name: string): boolean {
      const normalized = normalizeOntologyName(name)
      return normalized !== null && relationNames.has(normalized)
    },
    relation(name: string): OntologyRelationShape | null {
      const normalized = normalizeOntologyName(name)
      return normalized === null ? null : relationMap.get(normalized) ?? null
    },
    hasDatatype(name: string): boolean {
      const normalized = normalizeOntologyName(name)
      return normalized !== null && datatypeSet.has(normalized)
    },
  })
}

/**
 * Turtle 解析 → 判定索引 + 渲染条目（Story 9.2 / AD-31、AD-40、INV-17）。
 *
 * 用 `n3` 的**同步** `Parser`（AD-31 的输入契约：Turtle + `n3` 同步 Parser、单本体、
 * 加载期一次）。解析产物分两份：
 * - `index`：只给判定侧（归一化名称、显式排序、冻结；与 9.1 的 `buildOntologyIndex` 同形）；
 * - `entries`：给渲染侧（保留 IRI / label / domain / range / priority，供 AD-40 裁剪与展示）。
 *
 * 判定与渲染**不共用同一份渲染产物**（AD-31 明确禁止）；这里只是同一份解析结果的两个视图。
 *
 * 纯解析：无 I/O、无时钟、无随机；输入文本、输出确定性结构（同一文本两次解析逐位相同）。
 */
import { Parser, type Quad } from 'n3'
import {
  buildOntologyIndex,
  type OntologyIndex,
  type OntologyRelationInput,
} from './index.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class'
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class'
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty'
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const SKOS_PREFLABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel'
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain'
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range'
/** `omw:priority`：AD-40 的裁剪排序键（整数，缺省 0）。 */
export const OMW_PRIORITY = 'https://dsh-oh-my-whale.local/ontology#priority'

/** 渲染侧的一条词表条目（判定侧不读它；AD-40 的裁剪只用这些字段）。 */
export interface OntologyEntry {
  readonly kind: 'entity' | 'relation'
  /** 归一化名称（与 `index` 的键一致）。 */
  readonly name: string
  /** 原始 IRI（渲染展示 / allowlist 匹配用）。 */
  readonly iri: string
  /** 展示标签（`rdfs:label` / `skos:prefLabel`；缺省 = local name）。 */
  readonly label: string
  readonly domain: readonly string[]
  readonly range: readonly string[]
  readonly datatype: string | null
  /** AD-40 排序键：越大越优先；缺省 0。 */
  readonly priority: number
}

export interface ParsedOntology {
  readonly index: OntologyIndex
  /** 按 (kind, iri) 显式排序的渲染条目。 */
  readonly entries: readonly OntologyEntry[]
}

export class OntologyParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OntologyParseError'
  }
}

/** IRI 的 local name（`#` 或 `/` 后最后一段）；识别不出时退回全串。 */
export function ontologyLocalName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  const slash = iri.lastIndexOf('/')
  const cut = Math.max(hash, slash)
  const local = cut >= 0 ? iri.slice(cut + 1) : iri
  return local.length > 0 ? local : iri
}

interface SubjectFacts {
  types: Set<string>
  labels: string[]
  domain: string[]
  range: string[]
  priority: number
}

function subjectFacts(quads: readonly Quad[]): Map<string, SubjectFacts> {
  const map = new Map<string, SubjectFacts>()
  const factsFor = (subject: string): SubjectFacts => {
    const existing = map.get(subject)
    if (existing !== undefined) return existing
    const created: SubjectFacts = { types: new Set(), labels: [], domain: [], range: [], priority: 0 }
    map.set(subject, created)
    return created
  }
  for (const quad of quads) {
    if (quad.subject.termType !== 'NamedNode') continue
    const facts = factsFor(quad.subject.value)
    const predicate = quad.predicate.value
    if (predicate === RDF_TYPE) {
      if (quad.object.termType === 'NamedNode') facts.types.add(quad.object.value)
      continue
    }
    if (predicate === RDFS_LABEL || predicate === SKOS_PREFLABEL) {
      if (quad.object.termType === 'Literal') facts.labels.push(quad.object.value)
      continue
    }
    if (predicate === RDFS_DOMAIN) {
      if (quad.object.termType === 'NamedNode') facts.domain.push(quad.object.value)
      continue
    }
    if (predicate === RDFS_RANGE) {
      if (quad.object.termType === 'NamedNode') facts.range.push(quad.object.value)
      continue
    }
    if (predicate === OMW_PRIORITY && quad.object.termType === 'Literal') {
      const parsed = Number.parseInt(quad.object.value, 10)
      if (Number.isInteger(parsed)) facts.priority = parsed
    }
  }
  return map
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
}

/**
 * 解析 Turtle 文本。
 *
 * 支持的最小 OWL/RDFS 子集（AD-31 的约束形状所需）：`owl:Class` / `rdfs:Class`、
 * `owl:ObjectProperty`、`owl:DatatypeProperty`、`rdfs:label` / `skos:prefLabel`、
 * `rdfs:domain` / `rdfs:range`、`omw:priority`。其余三元组一律忽略（不引入推理）。
 *
 * @throws OntologyParseError 语法错误 / 空文本 / 无任何可用声明（闸门不可用，由加载层 fail-open）。
 */
export function parseOntologyTurtle(text: string): ParsedOntology {
  if (text.trim().length === 0) throw new OntologyParseError('本体文件为空（未声明任何类/关系）')
  let quads: readonly Quad[]
  try {
    quads = new Parser({ format: 'Turtle' }).parse(text) as Quad[]
  } catch (error) {
    throw new OntologyParseError('Turtle 解析失败：' + (error instanceof Error ? error.message : String(error)))
  }
  const facts = subjectFacts(quads)
  const entityEntries: OntologyEntry[] = []
  const relationEntries: OntologyEntry[] = []
  for (const [iri, entryFacts] of facts) {
    const name = ontologyLocalName(iri)
    const label = sortedUnique(entryFacts.labels)[0] ?? name
    const isClass = entryFacts.types.has(OWL_CLASS) || entryFacts.types.has(RDFS_CLASS)
    const isObjectProperty = entryFacts.types.has(OWL_OBJECT_PROPERTY)
    const isDatatypeProperty = entryFacts.types.has(OWL_DATATYPE_PROPERTY)
    if (isClass) {
      entityEntries.push({
        kind: 'entity',
        name,
        iri,
        label,
        domain: [],
        range: [],
        datatype: null,
        priority: entryFacts.priority,
      })
      continue
    }
    if (isObjectProperty || isDatatypeProperty) {
      const range = sortedUnique(entryFacts.range.map(ontologyLocalName))
      relationEntries.push({
        kind: 'relation',
        name,
        iri,
        label,
        domain: sortedUnique(entryFacts.domain.map(ontologyLocalName)),
        range,
        datatype: isDatatypeProperty ? (range[0] ?? null) : null,
        priority: entryFacts.priority,
      })
    }
  }
  if (entityEntries.length === 0 && relationEntries.length === 0) {
    throw new OntologyParseError('本体未声明任何 owl:Class / owl:ObjectProperty / owl:DatatypeProperty')
  }
  const entries = Object.freeze(
    [...entityEntries, ...relationEntries]
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'entity' ? -1 : 1
        if (left.iri !== right.iri) return left.iri < right.iri ? -1 : 1
        return 0
      })
      // 冻结每条：渲染侧只读投影，不允许调用方改动解析产物。
      .map((entry) => Object.freeze(entry)),
  )
  const datatypes = sortedUnique(
    relationEntries
      .filter((entry) => entry.datatype !== null)
      .map((entry) => entry.datatype as string),
  )
  const relationInputs: OntologyRelationInput[] = relationEntries.map((entry) => ({
    name: entry.name,
    domain: entry.domain,
    range: entry.range,
    ...(entry.datatype === null ? {} : { datatype: entry.datatype }),
  }))
  const index = buildOntologyIndex({
    entityTypes: entityEntries.map((entry) => entry.name),
    relationTypes: relationInputs,
    datatypes,
  })
  return Object.freeze({ index, entries })
}

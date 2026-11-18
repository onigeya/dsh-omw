/**
 * Turtle 解析（Story 9.2 / AD-31、AD-40）。纯函数，0 开库/0 网络。
 */
import { describe, expect, it } from 'vitest'
import { OntologyParseError, ontologyLocalName, parseOntologyTurtle } from '../src/ontology/turtle'

const TTL = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.test/ontology#> .
@prefix omw: <https://dsh-oh-my-whale.local/ontology#> .

ex:Person a owl:Class ; rdfs:label "Person" ; omw:priority 2 .
ex:Company a owl:Class ; rdfs:label "Company" .
ex:worksAt a owl:ObjectProperty ; rdfs:domain ex:Person ; rdfs:range ex:Company ; rdfs:label "works at" .
ex:bornOn a owl:DatatypeProperty ; rdfs:domain ex:Person ; rdfs:range <http://www.w3.org/2001/XMLSchema#date> .
`

describe('parseOntologyTurtle', () => {
  it('解析类 / 对象属性 / 数据类型属性 / label / domain / range / priority', () => {
    const parsed = parseOntologyTurtle(TTL)
    expect(parsed.index.entityTypes).toEqual(['company', 'person'])
    expect(parsed.index.hasEntityType('person')).toBe(true)
    expect(parsed.index.hasRelation('worksat')).toBe(true)
    const worksAt = parsed.index.relation('worksat')
    expect(worksAt).toMatchObject({ domain: ['person'], range: ['company'], datatype: null })
    const bornOn = parsed.index.relation('bornon')
    expect(bornOn?.datatype).toBe('date')
    expect(parsed.index.hasDatatype('date')).toBe(true)
    // 渲染条目保留 IRI / label / priority，按 (kind, iri) 排序。
    const person = parsed.entries.find((entry) => entry.iri.endsWith('Person'))
    expect(person).toMatchObject({ kind: 'entity', label: 'Person', priority: 2 })
    expect(parsed.entries[0]?.kind).toBe('entity')
  })

  it('同一文本两次解析逐位相同（无哈希/插入序依赖）', () => {
    // 判定索引带方法（闭包），按引用比较必然不等；确定性看的是**数据**：序列化后逐字节相同，
    // 且同一查表动作给出同一结果（INV-17）。
    const first = parseOntologyTurtle(TTL)
    const second = parseOntologyTurtle(TTL)
    expect(JSON.stringify({ index: { ...first.index, hasEntityType: undefined }, entries: first.entries }))
      .toBe(JSON.stringify({ index: { ...second.index, hasEntityType: undefined }, entries: second.entries }))
    expect(first.index.hasEntityType('person')).toBe(second.index.hasEntityType('person'))
    expect(first.index.hasRelation('worksat')).toBe(second.index.hasRelation('worksat'))
  })

  it('语法错误 / 空文本 / 无可用声明 ⇒ OntologyParseError（不静默当空本体）', () => {
    expect(() => parseOntologyTurtle('<<< not turtle')).toThrow(OntologyParseError)
    expect(() => parseOntologyTurtle('   ')).toThrow(OntologyParseError)
    expect(() => parseOntologyTurtle('@prefix ex: <https://e.test#> .\nex:a ex:b ex:c .')).toThrow(OntologyParseError)
  })

  it('local name（# / / 后最后一段）', () => {
    expect(ontologyLocalName('https://e.test/ontology#Person')).toBe('Person')
    expect(ontologyLocalName('https://e.test/ontology/Person')).toBe('Person')
  })

  it('最小本体：只声明一个类也能解析（空关系集合）', () => {
    const parsed = parseOntologyTurtle(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex: <https://e.test#> .
      ex:Person a owl:Class .
    `)
    expect(parsed.index.entityTypes).toEqual(['person'])
    expect(parsed.index.relations).toEqual([])
    expect(parsed.entries).toHaveLength(1)
  })

  it('重复声明：同一类 / 同一关系声明两次不抛错，域值域合并去重', () => {
    const parsed = parseOntologyTurtle(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix ex: <https://e.test#> .
      ex:Person a owl:Class .
      ex:Person a owl:Class ; rdfs:label "Person" .
      ex:worksAt a owl:ObjectProperty ; rdfs:domain ex:Person .
      ex:worksAt a owl:ObjectProperty ; rdfs:range ex:Person ; rdfs:domain ex:Person .
    `)
    expect(parsed.index.entityTypes).toEqual(['person'])
    expect(parsed.index.relations).toHaveLength(1)
    expect(parsed.index.relation('worksat')).toMatchObject({ domain: ['person'], range: ['person'] })
    expect(parsed.entries).toHaveLength(2)
  })
})

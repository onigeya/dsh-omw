/**
 * 本体索引测试（Story 9.1 / T1、INV-17）。
 *
 * 覆盖：名称归一化、显式排序、构建后冻结、重复声明 fail-loud、输入顺序不影响产物。
 */
import { describe, expect, it } from 'vitest'
import { buildOntologyIndex, normalizeOntologyName } from '../src/ontology/index'

describe('normalizeOntologyName（矩阵行 1）', () => {
  it('大小写与首尾空白归一化到同一键', () => {
    expect(normalizeOntologyName('Foo')).toBe('foo')
    expect(normalizeOntologyName('foo')).toBe('foo')
    expect(normalizeOntologyName('  FOO\t')).toBe('foo')
  })

  it('空 / 纯空白 / 内部含空白 = 非法名称（返回 null）', () => {
    expect(normalizeOntologyName('')).toBeNull()
    expect(normalizeOntologyName('   ')).toBeNull()
    expect(normalizeOntologyName('Fo o')).toBeNull()
    expect(normalizeOntologyName('a\nb')).toBeNull()
  })
})

describe('buildOntologyIndex（T1：显式排序 + 冻结）', () => {
  it('实体类型 / 关系 / 数据类型都按字典序显式排序，与输入顺序无关', () => {
    const forward = buildOntologyIndex({
      entityTypes: ['Zeta', 'alpha', 'Beta'],
      relationTypes: [
        { name: 'worksAt', domain: ['org', 'Person'], range: ['Company'] },
        { name: 'age', datatype: 'Integer' },
      ],
      datatypes: ['string', 'Integer'],
    })
    const reverse = buildOntologyIndex({
      entityTypes: ['Beta', 'alpha', 'Zeta'],
      relationTypes: [
        { name: 'age', datatype: 'Integer' },
        { name: 'worksAt', domain: ['Person', 'org'], range: ['Company'] },
      ],
      datatypes: ['Integer', 'string'],
    })

    expect(forward.entityTypes).toEqual(['alpha', 'beta', 'zeta'])
    expect(forward.relations.map((relation) => relation.name)).toEqual(['age', 'worksat'])
    expect(forward.relations[1]?.domain).toEqual(['org', 'person'])
    expect(forward.relations[1]?.range).toEqual(['company'])
    expect(forward.datatypes).toEqual(['integer', 'string'])
    expect(JSON.stringify(forward.entityTypes)).toBe(JSON.stringify(reverse.entityTypes))
    expect(JSON.stringify(forward.relations)).toBe(JSON.stringify(reverse.relations))
    expect(JSON.stringify(forward.datatypes)).toBe(JSON.stringify(reverse.datatypes))
  })

  it('构建后冻结：索引、名称数组、关系声明都不可变', () => {
    const index = buildOntologyIndex({
      entityTypes: ['Person'],
      relationTypes: [{ name: 'worksAt', domain: ['Person'], range: ['Org'] }],
      datatypes: ['string'],
    })
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.entityTypes)).toBe(true)
    expect(Object.isFrozen(index.relations)).toBe(true)
    expect(Object.isFrozen(index.relations[0])).toBe(true)
    expect(Object.isFrozen(index.relations[0]?.domain)).toBe(true)
    expect(Object.isFrozen(index.datatypes)).toBe(true)
    expect(() => { (index.entityTypes as string[]).push('Ghost') }).toThrow()
  })

  it('查表大小写 / 空白不敏感，未声明返回 false / null', () => {
    const index = buildOntologyIndex({
      entityTypes: ['Person'],
      relationTypes: ['worksAt'],
      datatypes: ['string'],
    })
    expect(index.hasEntityType(' person ')).toBe(true)
    expect(index.hasEntityType('org')).toBe(false)
    expect(index.hasRelation('WORKSAT')).toBe(true)
    expect(index.hasRelation('unknown')).toBe(false)
    expect(index.relation(' WorksAt ')?.name).toBe('worksat')
    expect(index.relation('unknown')).toBeNull()
    expect(index.hasDatatype('STRING')).toBe(true)
    expect(index.hasDatatype('integer')).toBe(false)
  })

  it('非法名称与重复关系声明 fail-loud（不静默择一，产物不依赖插入序）', () => {
    expect(() => buildOntologyIndex({ entityTypes: ['Fo o'] })).toThrow(/非法名称/)
    expect(() => buildOntologyIndex({ relationTypes: ['ok', 'OK'] })).toThrow(/重复声明/)
    expect(() => buildOntologyIndex({ relationTypes: [{ name: 'r', datatype: 'bad type' }] })).toThrow(/datatype/)
  })
})

/**
 * 本体闸门六维判定测试（Story 9.1 / T2-T4、矩阵行 1-9、11-12）。
 *
 * 断言口径：
 * - 失败姿态 = 丢弃并给出**首个**触发维度；
 * - 关闭任一维后该维不生效，且不通过其它维间接生效；
 * - 未解析 ≠ 违反：未声明的类只被 ③ 拒绝，⑤ 必须放行；
 * - off 档全部放行；同一输入两次判定逐位相同；单条判定远低于 1ms。
 */
import { describe, expect, it } from 'vitest'
import { buildOntologyIndex, type CandidateAssertion } from '../src/ontology/index'
import {
  classifyCandidate,
  isOntologyGateActive,
  ONTOLOGY_DIMENSIONS,
  resolveDimensionSwitches,
  type OntologyGatePolicy,
} from '../src/ontology/gate'

const INDEX = buildOntologyIndex({
  entityTypes: ['Person', 'Org', 'Integer'],
  relationTypes: [
    { name: 'worksAt', domain: ['Person'], range: ['Org'] },
    { name: 'age', domain: ['Person'], datatype: 'integer' },
  ],
  datatypes: ['integer', 'string'],
})

const align = (overrides: Partial<Omit<OntologyGatePolicy, 'level'>> = {}): OntologyGatePolicy => ({
  level: 'align',
  ...overrides,
})

const verdict = (candidate: CandidateAssertion, policy: OntologyGatePolicy) =>
  classifyCandidate(candidate, INDEX, policy)

describe('档位默认（off / align / strict）', () => {
  it('off 全关、align 除 ② 外全开、strict 六维全开', () => {
    expect(resolveDimensionSwitches({ level: 'off' })).toEqual({
      nameNormalization: false,
      duplicateTypeDiscard: false,
      entityType: false,
      relationType: false,
      domainRange: false,
      datatype: false,
    })
    expect(resolveDimensionSwitches({ level: 'align' })).toEqual({
      nameNormalization: true,
      duplicateTypeDiscard: false,
      entityType: true,
      relationType: true,
      domainRange: true,
      datatype: true,
    })
    expect(resolveDimensionSwitches({ level: 'strict' })).toEqual({
      nameNormalization: true,
      duplicateTypeDiscard: true,
      entityType: true,
      relationType: true,
      domainRange: true,
      datatype: true,
    })
    expect(isOntologyGateActive({ level: 'off' })).toBe(false)
    // off 是硬身份档：逐维覆盖不能把任何一维打开（否则 off ≠ 未启用本体）。
    expect(isOntologyGateActive({ level: 'off', entityType: true })).toBe(false)
  })
})

describe('矩阵 1：名称归一化（①）', () => {
  it('Foo / foo / 带空白归一化后同一键，合法名称放行', () => {
    expect(verdict({ subject: 'Alice', type: 'Person' }, align()).passed).toBe(true)
    expect(verdict({ subject: 'alice', type: 'person' }, align()).passed).toBe(true)
    expect(verdict({ subject: ' alice ', type: ' PERSON ' }, align()).passed).toBe(true)
  })

  it('非法名称丢弃，触发维度 = ①', () => {
    expect(verdict({ subject: 'Al ice', type: 'Person' }, align())).toEqual({
      passed: false,
      dimension: 'nameNormalization',
    })
    expect(verdict({ subject: '   ', type: 'Person' }, align())).toEqual({
      passed: false,
      dimension: 'nameNormalization',
    })
  })
})

describe('矩阵 2：重复陈述实体自身类型（②）', () => {
  const degenerate: CandidateAssertion = {
    subject: 'Person',
    type: 'Person',
    object: 'person',
    objectType: 'Person',
  }

  it('strict 丢弃退化断言（② 生效）', () => {
    expect(verdict(degenerate, { level: 'strict' })).toEqual({
      passed: false,
      dimension: 'duplicateTypeDiscard',
    })
  })

  it('align 不启用 ②：同一断言放行（两档唯一可观察的严格度差异）', () => {
    expect(verdict(degenerate, { level: 'align' }).passed).toBe(true)
  })

  it('subject ≠ object 的同类断言不是退化断言', () => {
    expect(verdict({ ...degenerate, object: 'Other' }, { level: 'strict' }).passed).toBe(true)
  })
})

describe('矩阵 3：未声明实体类型只被 ③ 拒绝、⑤ 放行', () => {
  it('未声明 type ⇒ ③ 拒绝', () => {
    expect(verdict({ subject: 'alice', type: 'Ghost' }, align())).toEqual({
      passed: false,
      dimension: 'entityType',
    })
    expect(verdict({ subject: 'alice' }, align())).toEqual({
      passed: false,
      dimension: 'entityType',
    })
  })

  it('关闭 ③ 后同一候选放行（⑤ 不接手）', () => {
    expect(verdict({ subject: 'alice', type: 'Ghost' }, align({ entityType: false })).passed).toBe(true)
  })

  it('objectType 未声明同样只由 ③ 处理', () => {
    const candidate = { subject: 'alice', type: 'Person', relation: 'worksAt', objectType: 'Ghost' }
    expect(verdict(candidate, align()).dimension).toBe('entityType')
    expect(verdict(candidate, align({ entityType: false })).passed).toBe(true)
  })
})

describe('矩阵 4：关系未声明（④）', () => {
  const candidate = { subject: 'alice', type: 'Person', relation: 'unknownRel', objectType: 'Org' }

  it('④ 拒绝未声明关系', () => {
    expect(verdict(candidate, align())).toEqual({ passed: false, dimension: 'relationType' })
  })

  it('关闭 ④ 后不通过 ⑤ / ⑥ 间接生效', () => {
    expect(verdict(candidate, align({ relationType: false })).passed).toBe(true)
  })
})

describe('矩阵 5：域 / 值域不符（⑤）', () => {
  it('已声明类型落在域外 ⇒ ⑤ 拒绝', () => {
    expect(verdict({
      subject: 'alice',
      type: 'Person',
      relation: 'worksAt',
      object: 'acme',
      objectType: 'Person',
    }, align())).toEqual({ passed: false, dimension: 'domainRange' })
  })

  it('未声明的类型不被 ⑤ 判为违反（未解析 ≠ 违反）', () => {
    const candidate = {
      subject: 'alice',
      type: 'Ghost',
      relation: 'worksAt',
      object: 'acme',
      objectType: 'Ghost',
    }
    // ③ 关掉之后 ⑤ 必须放行；③ 打开时由 ③ 负责拒绝。
    expect(verdict(candidate, align({ entityType: false })).passed).toBe(true)
    expect(verdict(candidate, align()).dimension).toBe('entityType')
  })

  it('关闭 ⑤ 后域外候选放行', () => {
    expect(verdict({
      subject: 'alice',
      type: 'Person',
      relation: 'worksAt',
      objectType: 'Person',
    }, align({ domainRange: false })).passed).toBe(true)
  })
})

describe('矩阵 6：数据类型不符（⑥）', () => {
  it('关系声明 integer、候选给 string ⇒ ⑥ 拒绝', () => {
    expect(verdict({
      subject: 'alice',
      type: 'Person',
      relation: 'age',
      datatype: 'string',
    }, align())).toEqual({ passed: false, dimension: 'datatype' })
  })

  it('匹配 / 缺失 datatype 都放行；关闭 ⑥ 后不符也放行', () => {
    expect(verdict({ subject: 'alice', type: 'Person', relation: 'age', datatype: 'Integer' }, align()).passed).toBe(true)
    expect(verdict({ subject: 'alice', type: 'Person', relation: 'age' }, align()).passed).toBe(true)
    expect(verdict(
      { subject: 'alice', type: 'Person', relation: 'age', datatype: 'string' },
      align({ datatype: false }),
    ).passed).toBe(true)
  })

  it('未声明的 datatype 同样由 ⑥ 拒绝；关闭 ⑥ 后放行（避免 datatypes 词表成为死数据）', () => {
    expect(verdict({ subject: 'alice', type: 'Person', datatype: 'uuid' }, align())).toEqual({
      passed: false,
      dimension: 'datatype',
    })
    expect(verdict({ subject: 'alice', type: 'Person', datatype: 'uuid' }, align({ datatype: false })).passed).toBe(true)
  })
})

describe('矩阵 7：关闭维度互不泄漏', () => {
  it('① 关闭后非法 subject 不被 ③ 接手', () => {
    expect(verdict({ subject: 'Al ice', type: 'Person' }, align({ nameNormalization: false })).passed).toBe(true)
  })

  it('任一维单独关闭只影响该维', () => {
    const base = align({ entityType: false })
    expect(verdict({ subject: 'alice', type: 'Ghost' }, base).passed).toBe(true)
    expect(verdict({ subject: 'alice', type: 'Ghost', relation: 'unknown' }, base).dimension).toBe('relationType')
  })
})

describe('矩阵 8：off 档全部放行', () => {
  it('空 subject / 未声明类型 / 未声明关系都通过', () => {
    expect(verdict({ subject: '', type: 'Ghost', relation: 'nope', datatype: 'nope' }, { level: 'off' }))
      .toEqual({ passed: true, dimension: null })
  })
})

describe('矩阵 11-12：确定性与性能', () => {
  it('同一 index + candidate 连续判定逐位相同', () => {
    const candidate = { subject: 'alice', type: 'Person', relation: 'worksAt', objectType: 'Person' }
    const first = JSON.stringify(verdict(candidate, align()))
    for (let round = 0; round < 100; round += 1) {
      expect(JSON.stringify(verdict(candidate, align()))).toBe(first)
    }
    expect(first).toBe(JSON.stringify({ passed: false, dimension: 'domainRange' }))
  })

  it('1e4 条判定总耗时远低于 1e4 ms（单条 ≤ 1ms，O(1) 查表）', () => {
    const candidate = { subject: 'alice', type: 'Person', relation: 'worksAt', objectType: 'Org' }
    const policy: OntologyGatePolicy = { level: 'strict' }
    // 预热：避免把首次 JIT 计入。
    for (let warm = 0; warm < 1000; warm += 1) classifyCandidate(candidate, INDEX, policy)
    const started = performance.now()
    for (let round = 0; round < 10_000; round += 1) classifyCandidate(candidate, INDEX, policy)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(2000)
  })

  it('六维顺序固定（账本分桶与判定顺序同源）', () => {
    expect(ONTOLOGY_DIMENSIONS).toEqual([
      'nameNormalization',
      'duplicateTypeDiscard',
      'entityType',
      'relationType',
      'domainRange',
      'datatype',
    ])
  })
})

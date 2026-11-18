/**
 * `/memory status` 的 ontology 行测试（Story 9.1 / T7、AD-31:443）。
 *
 * 三态钉死：off ⇒ `ontology: off`；有计数 ⇒ level + 六维分桶；算不出来 ⇒ n/a（原因）。
 * 缺省（undefined）不追加，既有逐行输出逐字不变。
 */
import { describe, expect, it } from 'vitest'
import { renderMemoryStatus, type MemoryStatusSnapshot } from '../src/command'

const BASE: MemoryStatusSnapshot = {
  layers: { L1: 0, L2: 0 },
  inboxes: { L1: 0, L2: 0 },
  failed: 0,
  embeddingMode: 'enabled',
  systemOne: 'enabled',
  unembedded: 0,
  readonly: false,
  auditGap: 0,
  evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
  relatedSkipped: 0,
}

const ontologyLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('ontology:'))

describe('ontology 行三态', () => {
  it('off ⇒ 恰好一行 `ontology: off`（不计其它维）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'off',
        drops: {
          nameNormalization: 0,
          duplicateTypeDiscard: 0,
          entityType: 0,
          relationType: 0,
          domainRange: 0,
          datatype: 0,
        },
      },
    })
    expect(ontologyLines(text)).toEqual(['ontology: off'])
  })

  it('align ⇒ level + 六维丢弃计数（十进制、顺序固定）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'align',
        drops: {
          nameNormalization: 1,
          duplicateTypeDiscard: 0,
          entityType: 3,
          relationType: 0,
          domainRange: 2,
          datatype: 0,
        },
      },
    })
    expect(ontologyLines(text)).toEqual([
      'ontology: align name-normalization=1 duplicate-type-discard=0 entity-type=3 ' +
      'relation-type=0 domain-range=2 datatype=0',
    ])
  })

  it('strict ⇒ 档位逐字可见', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'strict',
        drops: {
          nameNormalization: 0,
          duplicateTypeDiscard: 4,
          entityType: 0,
          relationType: 0,
          domainRange: 0,
          datatype: 0,
        },
      },
    })
    expect(text).toContain('ontology: strict ')
    expect(text).toContain('duplicate-type-discard=4')
  })

  it('drops=null ⇒ n/a + 原因（缺省原因 = 审计表缺失），不静默报 0', () => {
    const missingTable = renderMemoryStatus({ ...BASE, ontology: { level: 'align', drops: null } })
    expect(ontologyLines(missingTable)).toEqual(['ontology: align n/a（审计表缺失）'])

    const readonly = renderMemoryStatus({
      ...BASE,
      ontology: { level: 'align', drops: null, unavailableReason: '只读实例' },
    })
    expect(ontologyLines(readonly)).toEqual(['ontology: align n/a（只读实例）'])
  })

  it('缺省（undefined）不追加该行，既有输出逐字不变', () => {
    expect(renderMemoryStatus(BASE)).not.toContain('ontology:')
  })

  it('Story 9.2：types=full/prompt + path + 重新抽取提示（AD-40:765 / FR-18）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'align',
        drops: {
          nameNormalization: 0,
          duplicateTypeDiscard: 0,
          entityType: 0,
          relationType: 0,
          domainRange: 0,
          datatype: 0,
        },
        fullEntries: 4,
        promptEntries: 2,
        path: '/p/memory/ontology.ttl',
        reextractHint: true,
      },
    })
    expect(ontologyLines(text)).toEqual([
      'ontology: align types=4/2 name-normalization=0 duplicate-type-discard=0 entity-type=0 ' +
      'relation-type=0 domain-range=0 datatype=0 path=/p/memory/ontology.ttl （改本体或档位后需重新抽取）',
    ])
  })

  it('Story 9.2：闸门不可用原因可见（AD-31:437），不清零也不报 0', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'strict',
        drops: null,
        loadReason: '本体文件不可读（ENOENT）：/p/memory/ontology.ttl',
        path: '/p/memory/ontology.ttl',
        reextractHint: true,
      },
    })
    expect(ontologyLines(text)).toEqual([
      'ontology: strict unavailable=本体文件不可读（ENOENT）：/p/memory/ontology.ttl ' +
      'n/a（审计表缺失） path=/p/memory/ontology.ttl （改本体或档位后需重新抽取）',
    ])
  })

  it('Story 9.2：off 档仍可显示已加载条目数与路径（不渲染词表，但事实可见）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: { level: 'off', drops: null, fullEntries: 3, promptEntries: 0, path: '/p/o.ttl', reextractHint: true },
    })
    expect(ontologyLines(text)).toEqual(['ontology: off types=3/0 path=/p/o.ttl （改本体或档位后需重新抽取）'])
  })

  it('Story 9.2：只读实例仍显示 types=full/prompt 与 path（加载只读，计数才 n/a）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      ontology: {
        level: 'align',
        drops: null,
        unavailableReason: '只读实例',
        fullEntries: 5,
        promptEntries: 3,
        path: '/p/memory/ontology.ttl',
        reextractHint: true,
      },
    })
    expect(ontologyLines(text)).toEqual([
      'ontology: align types=5/3 n/a（只读实例） path=/p/memory/ontology.ttl （改本体或档位后需重新抽取）',
    ])
  })

  it('行位置固定在 self_knowledge 之后、health 之前（只增不改既有块）', () => {
    const text = renderMemoryStatus({
      ...BASE,
      selfKnowledge: { candidate: 0, accepted: 0, rejected: 0, recordOnly: 0 },
      ontology: {
        level: 'align',
        drops: {
          nameNormalization: 0,
          duplicateTypeDiscard: 0,
          entityType: 0,
          relationType: 0,
          domainRange: 0,
          datatype: 0,
        },
      },
      health: {
        inboxBacklog: { status: 'none' },
        lastRefineAt: { status: 'none' },
      },
    })
    const lines = text.split('\n')
    expect(lines.indexOf('self_knowledge: candidate=0 accepted=0 rejected=0 record-only=0'))
      .toBeLessThan(lines.indexOf(lines.find((line) => line.startsWith('ontology: '))!))
    expect(lines.findIndex((line) => line.startsWith('ontology: ')))
      .toBeLessThan(lines.findIndex((line) => line.startsWith('inbox_backlog: ')))
  })
})

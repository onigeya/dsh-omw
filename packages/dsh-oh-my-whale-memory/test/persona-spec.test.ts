/**
 * Persona Spec 静态注入 seam 测试（Story 11.2 / T1–T5、矩阵 1–7）。
 *
 * 生产默认**关闭**（`PERSONA_SPEC_APPROVED=false`、正文空串、Config `personaSpecEnabled=false`）：
 * 「已批准」分支只能用显式 fixture 覆盖——**本文件不编造任何 Spec 正文**，fixture 文本只存在于
 * 测试里，不进入 `src/persona/spec.ts`。
 *
 * 分层：
 * 1. 纯函数（T1）：版本/hash 契约、批准门、状态视图；
 * 2. 接线 seam（T3）：注册条件、`interpolate:false`、注册失败只 warn、与 `omw-memory` 独立；
 * 3. 装配面（T3 / 矩阵 1–2、7）：默认配置 / 开关打开但未批准 ⇒ 不注册；只读实例不注册。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index'
import type { MemoryCommandDefinition } from '../src/command'
import { OMW_MEMORY_SECTION_TEXT, registerInjectionPrompt } from '../src/injection/prompt'
import { createInjectionStore } from '../src/injection/state'
import {
  PERSONA_SPEC,
  PERSONA_SPEC_APPROVED,
  PERSONA_SPEC_TEXT,
  PERSONA_SPEC_VERSION,
  buildPersonaSection,
  personaSpecHash,
  personaStatusOf,
  renderPersonaSection,
  type PersonaSpec,
} from '../src/persona/spec'
import * as personaSpec from '../src/persona/spec'
import { PERSONA_SECTION_ORDER, wirePersonaSection } from '../src/wire/persona'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)

/** 显式「已批准」fixture：只用于测试批准分支，绝不复制进 `src/persona/spec.ts`。 */
const APPROVED_FIXTURE: PersonaSpec = {
  version: '1.0.0-fixture',
  text: '身份承诺 fixture：诚实说明边界，不越权，不伪造来源。',
}

const enabled = (spec: PersonaSpec) => ({ enabled: true, approved: true, spec })

describe('T1：版本 / 批准 / 正文常量（矩阵 1–2）', () => {
  it('生产默认是 fail-closed：draft-0 + 未批准 + 空正文', () => {
    expect(PERSONA_SPEC_VERSION).toBe('draft-0')
    expect(PERSONA_SPEC_APPROVED).toBe(false)
    expect(PERSONA_SPEC_TEXT).toBe('')
    expect(PERSONA_SPEC).toEqual({ version: PERSONA_SPEC_VERSION, text: PERSONA_SPEC_TEXT })
  })

  it('矩阵行 5：版本与正文绑定——draft-0 只允许是未批准的空正文', () => {
    // 这是给未来改动的结构钉：给 draft-0 填正文 / 置 approved=true 会立刻变红；
    // 必须同时换版本号并走产品负责人批准（ADR-11.1 D-1.2），而不是只改实现文件。
    if (PERSONA_SPEC_VERSION === 'draft-0') {
      expect(PERSONA_SPEC_APPROVED).toBe(false)
      expect(PERSONA_SPEC_TEXT).toBe('')
    }
  })
})

describe('T1：buildPersonaSection 与 hash 契约（矩阵行 3）', () => {
  it('返回 {name,text,hash} 三字段，name 独立于 omw-memory', () => {
    const section = buildPersonaSection(APPROVED_FIXTURE)
    expect(Object.keys(section).sort()).toEqual(['hash', 'name', 'text'])
    expect(section.name).toBe('omw-persona')
    expect(section.name).not.toBe('omw-memory')
    expect(section.text).toBe(APPROVED_FIXTURE.text)
  })

  it('hash = sha256(text)：与 node:crypto 独立计算的十六进制一致', () => {
    const expected = createHash('sha256').update(APPROVED_FIXTURE.text, 'utf8').digest('hex')
    expect(buildPersonaSection(APPROVED_FIXTURE).hash).toBe(expected)
    // 空正文同样有确定 hash（不能被当成「随便一个值」）。
    expect(personaSpecHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(personaSpecHash(APPROVED_FIXTURE.text)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同版本两次构建 hash 字节一致（跨会话稳定，无时钟/随机/会话状态）', () => {
    const first = buildPersonaSection(APPROVED_FIXTURE)
    const second = buildPersonaSection({ ...APPROVED_FIXTURE })
    expect(second.hash).toBe(first.hash)
    // 列表顺序唯一：正文变一个字符，hash 必须变（否则「同版本必须一致」无从检验）。
    expect(buildPersonaSection({ ...APPROVED_FIXTURE, text: APPROVED_FIXTURE.text + ' ' }).hash)
      .not.toBe(first.hash)
  })
})

describe('T1：renderPersonaSection 批准门（矩阵 1–3、5）', () => {
  it('未启用 ⇒ null（即使已批准且有正文）', () => {
    expect(renderPersonaSection({ enabled: false, approved: true, spec: APPROVED_FIXTURE })).toBeNull()
  })

  it('已启用但未批准 ⇒ null（不得注入占位文本）', () => {
    expect(renderPersonaSection({ enabled: true, approved: false, spec: APPROVED_FIXTURE })).toBeNull()
  })

  it('已启用 + 已批准 + 空正文 ⇒ null（批准后忘填正文也不渲染空段）', () => {
    expect(renderPersonaSection(enabled({ version: '1.0.0', text: '' }))).toBeNull()
    // 生产 Spec 走「已启用 + 已批准」也必须 null：正文仍是空。
    expect(renderPersonaSection({ enabled: true, approved: true, spec: PERSONA_SPEC })).toBeNull()
  })

  it('三者同时成立 ⇒ 返回 section（text 原样、hash 稳定）', () => {
    const first = renderPersonaSection(enabled(APPROVED_FIXTURE))
    const second = renderPersonaSection(enabled(APPROVED_FIXTURE))
    expect(first).not.toBeNull()
    expect(first?.text).toBe(APPROVED_FIXTURE.text)
    expect(first?.hash).toBe(second?.hash)
  })
})

describe('T5：status 视图由同一批准门派生', () => {
  it('未启用 / 未批准 ⇒ null；已批准 ⇒ version + hash（前 12 位由命令层截取）', () => {
    expect(personaStatusOf({ enabled: false, approved: true, spec: APPROVED_FIXTURE })).toBeNull()
    expect(personaStatusOf({ enabled: true, approved: false, spec: APPROVED_FIXTURE })).toBeNull()
    expect(personaStatusOf(enabled(APPROVED_FIXTURE))).toEqual({
      version: APPROVED_FIXTURE.version,
      hash: personaSpecHash(APPROVED_FIXTURE.text),
    })
  })
})

/** 捕获 section 注册的宿主替身（`systemPrompt.section` 的返回 disposer 由 ctx 作用域管理）。 */
function makePromptHost(options: { readonly throwOnSection?: boolean } = {}) {
  const sections: Array<{ name: string, order: number, text: string, interpolate?: boolean }> = []
  const contexts: string[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    systemPrompt: {
      section: (entry: { name: string, order: number, text: string, interpolate?: boolean }) => {
        if (options.throwOnSection === true) throw new Error('section "omw-persona" is already registered')
        sections.push(entry)
        return () => {}
      },
      context: (entry: { name: string }) => {
        contexts.push(entry.name)
        return () => {}
      },
    },
  } as unknown as Context
  return { ctx, sections, contexts }
}

describe('T3：wirePersonaSection 接线 seam', () => {
  it('未启用 / 未批准 / 空正文 ⇒ 连 host.section 都不调用（矩阵行 1–2 的结构钉）', () => {
    for (const input of [
      { enabled: false, approved: false, spec: PERSONA_SPEC },
      { enabled: false, approved: true, spec: APPROVED_FIXTURE },
      { enabled: true, approved: false, spec: APPROVED_FIXTURE },
      { enabled: true, approved: true, spec: { version: '1.0.0', text: '' } },
    ]) {
      const host = makePromptHost()
      expect(wirePersonaSection(host.ctx, input)).toBeNull()
      expect(host.sections).toHaveLength(0)
    }
  })

  it('已批准分支：注册静态 section（omw-persona、order 500、interpolate:false），返回同一 section', () => {
    const host = makePromptHost()
    const section = wirePersonaSection(host.ctx, enabled(APPROVED_FIXTURE))
    expect(section?.hash).toBe(personaSpecHash(APPROVED_FIXTURE.text))
    expect(host.sections).toEqual([{
      name: 'omw-persona',
      order: PERSONA_SECTION_ORDER,
      text: APPROVED_FIXTURE.text,
      interpolate: false,
    }])
    expect(PERSONA_SECTION_ORDER).toBeLessThan(600) // omw-memory = 600：身份承诺先于记忆引导语
  })

  it('同一 spec 两次接线 hash 稳定（跨构建/会话一致，矩阵行 3）', () => {
    const first = makePromptHost()
    const second = makePromptHost()
    expect(wirePersonaSection(first.ctx, enabled(APPROVED_FIXTURE))?.hash)
      .toBe(wirePersonaSection(second.ctx, enabled(APPROVED_FIXTURE))?.hash)
  })

  it('矩阵行 6：注册抛错只 warn、不抛出、不阻塞注入面', () => {
    const host = makePromptHost({ throwOnSection: true })
    expect(() => wirePersonaSection(host.ctx, enabled(APPROVED_FIXTURE))).not.toThrow()
    expect(wirePersonaSection(host.ctx, enabled(APPROVED_FIXTURE))).toBeNull()
    expect(host.ctx.logger.warn).toHaveBeenCalled()
    expect(String((host.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('omw-persona')
  })

  it('裸 ctx（无 systemPrompt）⇒ null，不抛错（与既有注入面同一降级口径）', () => {
    const ctx = { logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    expect(wirePersonaSection(ctx, enabled(APPROVED_FIXTURE))).toBeNull()
  })
})

describe('矩阵行 4：与 omw-memory 独立（两个 section、文本与动态 context 契约不变）', () => {
  it('同宿主上并列注册：名字/文本互不覆盖，动态 context 只有 omw-memory 那一条', () => {
    type Section = { name: string, order: number, text: string, interpolate?: boolean }
    const sections = new Map<string, Section>()
    const contexts: string[] = []
    const host = {
      section: (entry: Section) => {
        if (sections.has(entry.name)) throw new Error('duplicate section ' + entry.name)
        sections.set(entry.name, entry)
        return () => {}
      },
      context: (entry: { name: string }) => {
        contexts.push(entry.name)
        return () => {}
      },
    }

    registerInjectionPrompt(host, createInjectionStore())
    wirePersonaSection(makeHostCtx(host), enabled(APPROVED_FIXTURE))

    // 两个独立 section；omw-memory 的文本仍是常量，persona 文本只来自 fixture。
    expect([...sections.keys()].sort()).toEqual(['omw-memory', 'omw-persona'])
    expect(sections.get('omw-memory')?.text).toBe(OMW_MEMORY_SECTION_TEXT)
    expect(sections.get('omw-memory')?.order).toBe(600)
    expect(sections.get('omw-persona')?.text).toBe(APPROVED_FIXTURE.text)
    expect(sections.get('omw-persona')?.interpolate).toBe(false)
    // 动态 context 契约不变：persona 不新增/改写任何 context。
    expect(contexts).toEqual(['omw-memory:recall'])
  })
})

/** 只带 systemPrompt 的 ctx 包装（logger 供 wirePersonaSection 的 warn 分支使用）。 */
function makeHostCtx(host: { section: (entry: unknown) => unknown, context: (entry: unknown) => unknown }): Context {
  return { logger: { warn: vi.fn(), info: vi.fn() }, systemPrompt: host } as unknown as Context
}

describe('T4：运行时不可写（结构钉）', () => {
  it('spec 模块只导出常量与纯函数，没有任何 set/write/mutate API', () => {
    const names = Object.keys(personaSpec).sort()
    expect(names).toEqual([
      'PERSONA_SECTION_NAME',
      'PERSONA_SPEC',
      'PERSONA_SPEC_APPROVED',
      'PERSONA_SPEC_TEXT',
      'PERSONA_SPEC_VERSION',
      'buildPersonaSection',
      'personaSpecHash',
      'personaStatusOf',
      'renderPersonaSection',
    ])
    expect(names.filter((name) => /set|write|update|mutate|append|remove/i.test(name))).toEqual([])
  })

  it('index.ts 只经 spec seam 接线，不直接依赖契约原型（11.1 的边界不因接线扩大）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('persona/contract')
    expect(source).toContain('persona/spec')
  })
})

describe('T3 / 矩阵行 1–2、7：装配面', () => {
  function makeApplyCtx(dir: string, sections: string[], registered: MemoryCommandDefinition[]) {
    return {
      logger: { warn: vi.fn(), info: vi.fn() },
      get: (key: string) => {
        if (key === 'profileContext') return { dir }
        if (key === 'commands') {
          return {
            register: (definition: MemoryCommandDefinition) => {
              registered.push(definition)
              return () => {}
            },
          }
        }
        return undefined
      },
      effect: (factory: () => () => unknown) => factory(),
      tools: { register: () => () => {} },
      systemPrompt: {
        section: (entry: { name: string }) => { sections.push(entry.name); return () => {} },
        context: () => () => {},
      },
    } as unknown as Parameters<typeof plugin.apply>[0]
  }

  const EMBEDDING = { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } }

  it('默认配置：只注册 omw-memory，status 显示 disabled(awaiting-approval)（矩阵行 1）', async () => {
    const dir = await makeTempDir('omw-persona-off-')
    const sections: string[] = []
    const registered: MemoryCommandDefinition[] = []
    await plugin.apply(makeApplyCtx(dir, sections, registered), EMBEDDING)

    expect(sections).toEqual(['omw-memory'])
    const result = await registered[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('persona: disabled(awaiting-approval)')
  }, 30_000)

  it('Config 打开但正文未批准：仍不注册 omw-persona，status 说明未批准（矩阵行 2）', async () => {
    const dir = await makeTempDir('omw-persona-enabled-')
    const sections: string[] = []
    const registered: MemoryCommandDefinition[] = []
    await plugin.apply(makeApplyCtx(dir, sections, registered), {
      ...EMBEDDING,
      personaSpecEnabled: true,
    })

    expect(sections).toEqual(['omw-memory'])
    const result = await registered[0]!.handler({ rawInput: ' status' })
    expect(result.text).toContain('persona: disabled(awaiting-approval)')
  }, 30_000)

  it('结构钉：persona 接线位于写者路径（只读早退之后）——只读实例物理上走不到（矩阵行 7）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    const earlyReturn = source.indexOf('if (readonlyMode) {')
    const wiring = source.indexOf('wirePersonaSection(ctx')
    expect(earlyReturn).toBeGreaterThan(-1)
    expect(wiring).toBeGreaterThan(earlyReturn)
  })
})

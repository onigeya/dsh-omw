/**
 * 注入面骨架测试（Story 3.3 / B1；fake host，0 开库）。
 *
 * 覆盖：
 * - 静态 section：名 `omw-memory`、text 是**常量**、`interpolate:false`、order 常量；
 * - 动态 context：名/order、`interpolate:false`、provider 从注入状态机取文本，
 *   非 ready / 空文本一律 `''`（空文本短路 ⇒ 宿主不产消息）；
 * - 裸 ctx（无 systemPrompt 服务）：`registerInjectionPrompt` 不被调用也不抛错（由 index 守卫，
 *   此处直接断言端口形状 + entry-exports 的裸 ctx apply 用例覆盖）；
 * - 状态机骨架：pending 不回退已 ready、skipped、textFor、reset。
 */
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import {
  INJECTION_CONTEXT_NAME,
  INJECTION_CONTEXT_ORDER,
  INJECTION_SECTION_NAME,
  INJECTION_SECTION_ORDER,
  OMW_MEMORY_SECTION_TEXT,
  injectionSessionKeyOf,
  registerInjectionPrompt,
  type InjectionPromptHost,
} from '../src/injection/prompt'
import { createInjectionStore } from '../src/injection/state'

interface CapturedSection { name: string; order: number; text: string | ((context: unknown) => string); interpolate?: boolean }
interface CapturedContext { name: string; order: number; text: string | ((context: unknown) => string); interpolate?: boolean }

function makeHost(): { host: InjectionPromptHost; sections: CapturedSection[]; contexts: CapturedContext[] } {
  const sections: CapturedSection[] = []
  const contexts: CapturedContext[] = []
  return {
    sections,
    contexts,
    host: {
      section: (section) => {
        sections.push(section as CapturedSection)
        return () => {}
      },
      context: (context) => {
        contexts.push(context as CapturedContext)
        return () => {}
      },
    },
  }
}

describe('注入面注册（Story 3.3 / B1）', () => {
  it('section 是常量文本、名 omw-memory、order=600、关闭插值（AD-23：section 常量 + context 动态）', () => {
    const { host, sections } = makeHost()
    const dispose = registerInjectionPrompt(host, createInjectionStore())

    expect(dispose).toHaveLength(2)
    const section = sections[0]!
    expect(section.name).toBe(INJECTION_SECTION_NAME)
    expect(section.name).toBe('omw-memory')
    expect(section.order).toBe(INJECTION_SECTION_ORDER)
    expect(section.order).toBe(600)
    // text 必须是与导出常量同一字面量（不是函数/模板）——AC:920「text 必须为常量」。
    expect(section.text).toBe(OMW_MEMORY_SECTION_TEXT)
    expect(typeof section.text).toBe('string')
    expect(section.interpolate).toBe(false)
  })

  it('context provider：无状态/空文本返回空串；ready 后按会话键返回文本（空文本短路）', () => {
    const store = createInjectionStore()
    const { host, contexts } = makeHost()
    registerInjectionPrompt(host, store)

    const context = contexts[0]!
    expect(context.name).toBe(INJECTION_CONTEXT_NAME)
    expect(context.order).toBe(INJECTION_CONTEXT_ORDER)
    expect(context.interpolate).toBe(false)

    const assembleContext = { agent: { session: { id: 'session-a' } } }
    // 未识别会话 ⇒ 空串（宿主对空文本不产消息）。
    expect(typeof context.text).toBe('function')
    expect((context.text as (c: unknown) => string)(assembleContext)).toBe('')

    store.markPending('session-a')
    expect((context.text as (c: unknown) => string)(assembleContext)).toBe('')

    store.markReady('session-a', '摘要文本')
    expect((context.text as (c: unknown) => string)(assembleContext)).toBe('摘要文本')
    // 另一个会话不受影响。
    expect((context.text as (c: unknown) => string)({ agent: { session: { id: 'session-b' } } })).toBe('')
    // ready 但文本为空 ⇒ 空串（无命中/仅降级空结果）。
    store.markReady('session-b', '')
    expect((context.text as (c: unknown) => string)({ agent: { session: { id: 'session-b' } } })).toBe('')
    // 拿不到会话身份归 unknown 桶（与配额/采集同键）。
    store.markReady('unknown', '无身份文本')
    expect(injectionSessionKeyOf({ agent: {} })).toBe('unknown')
    expect((context.text as (c: unknown) => string)({})).toBe('无身份文本')
  })

  it('状态机骨架：pending 不覆盖已 ready、skipped 后 textFor 为空、reset 清会话', () => {
    const store = createInjectionStore()
    store.markReady('s1', '文本')
    store.markPending('s1') // 不得把 ready 回退成 pending（「每会话一次」AC:916）
    expect(store.read('s1')).toMatchObject({ status: 'ready', text: '文本' })
    expect(store.textFor('s1')).toBe('文本')

    store.markSkipped('s1')
    expect(store.textFor('s1')).toBe('')
    expect(store.read('s1')?.status).toBe('skipped')

    store.reset('s1')
    expect(store.read('s1')).toBeUndefined()
  })

  it('`inject` 声明含 systemPrompt（裸 ctx 下整面跳过：apply 不因缺 systemPrompt 抛错）', async () => {
    expect(plugin.inject).toContain('systemPrompt')

    // 裸 ctx：没有 systemPrompt 服务（也没有 profileContext）⇒ apply 走 warn 早退，不抛错。
    const warn = vi.fn()
    const ctx = {
      logger: { warn },
      effect: () => () => {},
      tools: { register: () => () => {} },
      get: () => undefined,
      on: () => () => {},
    } as unknown as Parameters<typeof plugin.apply>[0]
    await expect(plugin.apply(ctx, {})).resolves.toBeUndefined()
  })
})

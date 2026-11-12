/**
 * session 路由解析单测（Story 2.3 / AC:567 / 评审 T21）。
 *
 * 回退链：requestHeader().config → requestContext() → null；纯函数、结构化类型，
 * 缺方法/缺字段一律返回 null（调用方据此直接降级，不调 LLM）。
 */
import { describe, expect, it } from 'vitest'
import { routeFromSession } from '../src/distill/session-route'

describe('routeFromSession（评审 T21）', () => {
  it('优先取 requestHeader().config 的 provider/model（最近一次已记录的请求目标）', () => {
    const session = {
      requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }),
      requestContext: () => ({ provider: 'p2', model: 'm2' }),
    }
    expect(routeFromSession(session)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('requestHeader 缺失或字段不全时退回 requestContext()', () => {
    expect(routeFromSession({ requestContext: () => ({ provider: 'p2', model: 'm2' }) }))
      .toEqual({ provider: 'p2', model: 'm2' })
    expect(routeFromSession({
      requestHeader: () => ({ config: { provider: 'p1' } }),
      requestContext: () => ({ provider: 'p2', model: 'm2' }),
    })).toEqual({ provider: 'p2', model: 'm2' })
  })

  it('两者都缺 / 空串字段 / 非对象 session ⇒ null（不抛错）', () => {
    expect(routeFromSession({})).toBeNull()
    expect(routeFromSession(undefined)).toBeNull()
    expect(routeFromSession(null)).toBeNull()
    expect(routeFromSession({
      requestHeader: () => ({ config: { provider: '', model: 'm1' } }),
      requestContext: () => ({ provider: 'p2', model: '' }),
    })).toBeNull()
  })
})

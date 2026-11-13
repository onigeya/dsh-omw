/**
 * Config schema 与设置表单投影测试（Story 1.3 / I/O 矩阵 12 行全覆盖）。
 *
 * 断言分三类：
 * 1. schema lint——凭据 role=secret（AD-9）、全字段 volatile（AD-11）、defaults 值、
 *    以及 schemastery validateVolatileSchema 的「volatile 不嵌套 volatile」硬约束。
 * 2. resolveRuntimeConfig——硬校验抛错路径 + 可降级路径（FR-18）。
 * 3. 脱敏投影——按宿主 redact.ts 的 role==='secret' 判定复现，确认 token 值不入投影内容。
 *
 * 错误信息契约：硬校验错误含字段名 + 期望格式 + 当前值；凭据字段只含字段名（NFR9）。
 */
import { describe, expect, it } from 'vitest'
import { Config, resolveRuntimeConfig } from '../src/config'

/** 一张全合法配置（I/O 矩阵第 1 行基线）。 */
function validConfig() {
  return {
    embedding: { endpoint: 'https://api.example.com/v1', token: 'sk-test', model: 'bge-m3' },
    captureSteps: 50,
    inboxRefineConcurrency: 4,
    injectOnNewSession: true,
    rrfK: 60,
    retrievalTopK: 50,
    layerWeights: { l2: 0.7, l1: 0.4 },
    systemOne: { enabled: true },
  }
}

describe('Config schema 形态（AD-9 / AD-11）', () => {
  it('每个顶层字段都标了 volatile（否则不进 /settings 表单）', () => {
    // schemastery toJSON 的根节点不含 dict，字段列表须从 Config.dict 取。
    const dict = Config.dict as Record<string, any>
    const missing = Object.entries(dict)
      .filter(([, node]) => !(node as { meta?: { volatile?: boolean } }).meta?.volatile)
      .map(([key]) => key)
    expect(missing).toEqual([])
    // 顶层字段数量锁定 FR-18 全字段，防止后续误删
    expect(Object.keys(dict).sort()).toEqual([
      'captureSteps', 'embedding', 'inboxRefineConcurrency', 'injectOnNewSession',
      'layerWeights', 'llmModel', 'llmProvider', 'priorityWeight', 'rerank', 'retrievalTopK', 'rrfK', 'systemOne',
    ])
  })

  it('凭据字段命名为 token 且 role === secret（AD-9：字段名不参与脱敏判定）', () => {
    const top = Config.dict as Record<string, any>
    for (const parent of ['embedding', 'rerank']) {
      const parentNode = top[parent]
      expect(parentNode, `Config.${parent} 应存在`).toBeTruthy()
      const sub = parentNode.dict
      expect(Object.keys(sub)).toContain('token')
      const tokenNode = sub.token
      expect(tokenNode.meta?.role).toBe('secret')
    }
  })

  it('不存在 volatile 嵌套 volatile（schemastery validateVolatileSchema 硬约束）', () => {
    // 递归遍历：任何 volatile 节点内部不得再出现 volatile 子孙
    function walk(node: any, path: string[], enclosedByVolatile: boolean): string[] {
      const violations: string[] = []
      const isVolatile = node?.meta?.volatile === true
      if (isVolatile && enclosedByVolatile) violations.push(path.join('.'))
      for (const [key, child] of Object.entries(node?.dict ?? {})) {
        violations.push(...walk(child, [...path, key], isVolatile))
      }
      return violations
    }
    const root: any = { type: 'object', dict: Config.dict, meta: Config.meta }
    expect(walk(root, [], false)).toEqual([])
    // 且 schema 能被 resolve（违反约束会在 resolve 阶段抛 ValidationError）
    expect(() => Config({})).not.toThrow()
  })

  it('默认值与 spec 锁定一致', () => {
    const resolved = Config({}) as Record<string, any>
    expect(resolved.captureSteps.get()).toBe(50)
    expect(resolved.inboxRefineConcurrency.get()).toBe(4)
    expect(resolved.injectOnNewSession.get()).toBe(true)
    expect(resolved.rrfK.get()).toBe(60)
    expect(resolved.retrievalTopK.get()).toBe(50)
    expect(resolved.layerWeights.get()).toEqual({ l2: 0.7, l1: 0.4 })
    // Story 3.1 / FR-16：priority 二次加权系数缺省 0.5。
    expect(resolved.priorityWeight.get()).toBe(0.5)
    expect(resolved.systemOne.get()).toEqual({ enabled: true })
    expect(resolved.embedding.get()).toEqual({})
    expect(resolved.rerank.get()).toEqual({})
  })

  it('volatile 字段读取用 .get() 返回当前值（I/O 矩阵第 10 行）', () => {
    const resolved = Config({ captureSteps: 12 }) as Record<string, any>
    expect(resolved.captureSteps.get()).toBe(12)
    expect(typeof resolved.captureSteps.get()).toBe('number')
  })
})

describe('GC 正常配置（I/O 矩阵第 1 行）', () => {
  it('全字段合法时 embedding 为 enabled 且无 warn', () => {
    const resolved = resolveRuntimeConfig(validConfig())
    expect(resolved.embeddingMode).toBe('enabled')
    expect(resolved.warnings).toEqual([])
    expect(resolved.captureSteps).toBe(50)
    expect(resolved.rrfK).toBe(60)
    expect(resolved.layerWeights).toEqual({ l2: 0.7, l1: 0.4 })
    expect(resolved.priorityWeight).toBe(0.5)
  })
})

describe('硬校验（任一失败即抛错，仅阻塞本插件）', () => {
  it('embedding.endpoint 非 http(s) 抛错，消息含字段名+期望格式+当前值（第 2 行）', () => {
    for (const bad of ['ftp://x', 'not-a-url']) {
      const cfg = validConfig()
      cfg.embedding.endpoint = bad
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/embedding\.endpoint/)
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/http\(s\)/)
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(new RegExp(JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  it('captureSteps < 1 抛错（第 3 行）', () => {
    for (const bad of [0, -3]) {
      const cfg = { ...validConfig(), captureSteps: bad }
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/captureSteps/)
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(new RegExp(String(bad)))
    }
  })

  it('rrfK = 0 抛错（第 4 行）', () => {
    const cfg = { ...validConfig(), rrfK: 0 }
    expect(() => resolveRuntimeConfig(cfg)).toThrowError(/rrfK/)
    expect(() => resolveRuntimeConfig(cfg)).toThrowError(/> 0/)
  })

  it('层权重越界抛错（第 5 行）', () => {
    for (const bad of [1.5, 0]) {
      const l2cfg = { ...validConfig(), layerWeights: { l2: bad, l1: 0.4 } }
      expect(() => resolveRuntimeConfig(l2cfg)).toThrowError(/layerWeights\.l2/)
      const l1cfg = { ...validConfig(), layerWeights: { l2: 0.7, l1: bad } }
      expect(() => resolveRuntimeConfig(l1cfg)).toThrowError(/layerWeights\.l1/)
    }
  })

  it('inboxRefineConcurrency = 0 抛错（第 9 行）', () => {
    const cfg = { ...validConfig(), inboxRefineConcurrency: 0 }
    expect(() => resolveRuntimeConfig(cfg)).toThrowError(/inboxRefineConcurrency/)
    expect(() => resolveRuntimeConfig(cfg)).toThrowError(/≥ 1/)
  })

  it('priorityWeight 硬校验（Story 3.1 / FR-16）：负数/非有限抛错，0 合法（显式关闭）', () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cfg = { ...validConfig(), priorityWeight: bad }
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/priorityWeight/)
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/≥ 0/)
    }
    // 0 是显式关闭 priority 影响，不抛错。
    expect(resolveRuntimeConfig({ ...validConfig(), priorityWeight: 0 }).priorityWeight).toBe(0)
    expect(resolveRuntimeConfig({ ...validConfig(), priorityWeight: 1.5 }).priorityWeight).toBe(1.5)
  })

  it('embedding.dim 硬校验：0 / -1 / 1.5 抛错，4 通过', () => {
    for (const bad of [0, -1, 1.5]) {
      const cfg = { ...validConfig(), embedding: { ...validConfig().embedding, dim: bad } }
      expect(() => resolveRuntimeConfig(cfg), 'dim=' + bad + ' 应抛错').toThrowError(/embedding\.dim/)
    }
    const ok = { ...validConfig(), embedding: { ...validConfig().embedding, dim: 4 } }
    expect(resolveRuntimeConfig(ok).embedding.dim).toBe(4)
  })
})

describe('可降级路径（FR-18：不抛错，warn + disabled）', () => {
  it('embedding token 缺失降级，不抛错（第 6 行）', () => {
    const cfg = validConfig()
    cfg.embedding.token = ''
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.embeddingMode).toBe('disabled')
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain('embedding.token')
    expect(resolved.warnings[0]).toContain('disabled')
  })

  it('embedding model 缺失降级，不抛错（第 7 行）', () => {
    const cfg = validConfig()
    cfg.embedding.model = ''
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.embeddingMode).toBe('disabled')
    expect(resolved.warnings[0]).toContain('embedding.model')
  })

  it('评审 T6：endpoint 缺失也降级（避免「假启用态」），warn 点名字段', () => {
    const cfg = validConfig()
    delete (cfg.embedding as { endpoint?: string }).endpoint
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.embeddingMode).toBe('disabled')
    expect(resolved.warnings).toHaveLength(1)
    expect(resolved.warnings[0]).toContain('embedding.endpoint')
  })

  it('两者都缺失时 warn 同时列出两个字段', () => {
    const cfg = validConfig()
    cfg.embedding.token = ''
    cfg.embedding.model = ''
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.warnings[0]).toContain('embedding.token')
    expect(resolved.warnings[0]).toContain('embedding.model')
  })

  it('降级 warn 绝不携带 token 值（NFR9）', () => {
    const cfg = validConfig()
    cfg.embedding.model = ''
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.warnings.join(' ')).not.toContain('sk-test')
  })
})

describe('ReRank 字段（第 8 行：v1 不消费不校验）', () => {
  it('rerank 任意组合（含非法 endpoint）都不影响解析', () => {
    const rerankVariants = [
      {},
      { endpoint: 'not-a-url' },
      { token: '', model: '' },
      { endpoint: 'ftp://bad', token: 'x', model: 'y' },
    ]
    for (const rerank of rerankVariants) {
      // 把 rerank 真的放进配置——v1 不读即不影响，否则 vacuous。
      const cfg = { ...validConfig(), rerank }
      const resolved = resolveRuntimeConfig(cfg)
      expect(resolved.embeddingMode).toBe('enabled')
      expect('rerank' in resolved).toBe(false)
    }
    // schema 仍保留 rerank 字段（v2 预留）
    expect(Object.keys(Config.dict as Record<string, unknown>)).toContain('rerank')
  })
})

describe('凭据脱敏（第 11 行 / AD-9）', () => {
  /** 复刻宿主 redact.ts walk() 的判定：node.meta?.role === 'secret'。 */
  function collectSecrets(node: any, path: string[], out: string[]): void {
    if (node?.meta?.role === 'secret') out.push(path.join('.'))
    for (const [key, child] of Object.entries(node?.dict ?? {})) {
      collectSecrets(child, [...path, key], out)
    }
  }

  it('redact 判定能命中 embedding/rerank/systemOne 的 token，字段值不进入投影内容', () => {
    // schemastery toJSON 根节点只暴露 refs，dict 须从 Config.dict 直接读。
    const root: any = { type: 'object', dict: Config.dict, meta: Config.meta }
    const secrets: string[] = []
    collectSecrets(root, [], secrets)
    // Story 2.5 / 评审 P3（T4）：systemOne 也可经 Config 注入 token（.role('secret')）——
    // 它必须同样被脱敏判定命中，否则凭据会明文进投影（AD-9）。
    expect(secrets.sort()).toEqual(['embedding.token', 'rerank.token', 'systemOne.token'])

    // token 值只存在于 resolve 后的运行时对象，且不出现在 warnings/错误消息里
    const cfg = validConfig()
    const resolved = resolveRuntimeConfig(cfg)
    const serialized = JSON.stringify(resolved)
    expect(serialized).toContain('sk-test') // 运行时内存中保留（供调用）
    expect(resolved.warnings.join(' ')).not.toContain('sk-test')
  })

  it('systemOne.token 值不进 warnings / 投影，endpoint 非法时报错点名字段（NFR9）', () => {
    const cfg = validConfig()
    cfg.embedding.model = 'bge-m3'
    const withToken = resolveRuntimeConfig({ ...cfg, systemOne: { token: 'sk-systemone' } })
    // token 只在运行时内存对象里（供调用），绝不进 warnings。
    expect(JSON.stringify(withToken)).toContain('sk-systemone')
    expect(JSON.stringify(withToken.warnings)).not.toContain('sk-systemone')

    // endpoint 不是凭据：与 embedding.endpoint 同约定，错误点名字段并回显当前值
    // （见本文件既有的「消息含字段名+期望格式+当前值」用例）。
    expect(() => resolveRuntimeConfig({ ...cfg, systemOne: { endpoint: 'not-a-url' } }))
      .toThrowError(/systemOne\.endpoint/)
  })

  it('token 缺失时的错误/告警只含字段名，不含任何值', () => {
    const cfg = validConfig()
    cfg.embedding.token = ''
    cfg.embedding.model = 'bge-m3'
    const resolved = resolveRuntimeConfig(cfg)
    expect(resolved.warnings[0]).toMatch(/^embedding 降级为 disabled：缺少 embedding\.token/)
  })
})

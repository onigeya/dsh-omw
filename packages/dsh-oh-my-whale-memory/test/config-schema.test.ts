/**
 * Config schema 与设置表单投影测试（Story 1.3 / I/O 矩阵 12 行全覆盖）。
 *
 * 断言分三类：
 * 1. schema lint，凭据 role=secret（AD-9）、全字段 volatile（AD-11）、defaults 值、
 *    以及 schemastery validateVolatileSchema 的「volatile 不嵌套 volatile」硬约束。
 * 2. resolveRuntimeConfig，硬校验抛错路径 + 可降级路径（FR-18）。
 * 3. 脱敏投影，按宿主 redact.ts 的 role==='secret' 判定复现，确认 token 值不入投影内容。
 *
 * 错误信息契约：硬校验错误含字段名 + 期望格式 + 当前值；凭据字段只含字段名（NFR9）。
 */
import { describe, expect, it } from 'vitest'
import { Config, resolveRuntimeConfig } from '../src/config'
import { DEFAULT_PURIFY_OPTIONS } from '../src/context/purify'

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
      'alwaysOnTokenCap', 'captureMaxTokens', 'captureMinTokens', 'captureSteps', 'captureTokens',
      'chainDepthThreshold', 'compactionLengthMin',
      'compactionOrphanTimeoutMs', 'compactionSelfTuneEnabled', 'compactionT3Threshold', 'embedding',
      'expandCountThreshold', 'foldThresholdTokens', 'inboxRefineConcurrency', 'injectOnNewSession',
      'injectionRatio', 'injectionSingleCap', 'injectionSummaryCap', 'injectionTokenCap',
      'layerWeights', 'llmModel', 'llmProvider',
      // Story 9.2 / AD-40：本体输入（path）与词表渲染（allowlist + 字符预算）。
      'ontology',
      // Story 9.1 / AD-31：本体闸门档位 + 逐维覆盖（默认 level=off）。
      'ontologyGate',
      // Story 11.2 / AD-38：Persona Spec 静态 section 开关（默认 false，运行期可覆盖）。
      'personaSpecEnabled',
      'priorityWeight',
      // Story 8.6 / AC:1868：确定性净化 pass 的四个开关。
      'purifyMinRemainder', 'purifyR1', 'purifyR2', 'purifyR3',
      'reflection', 'rerank',
      'retrievalTopK', 'rrfK',
      // Story 11.3 / T5：反思观察写入 Self-Knowledge 候选区的开关（默认 false）。
      'selfKnowledgeCaptureEnabled',
      'strategyGate', 'systemOne',
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
    // Story 8.4 / AC:1713-1760：长度三带与句柄重写阈值的默认值（经验值，可覆盖）。
    expect(resolved.compactionLengthMin.get()).toBe(1200)
    expect(resolved.compactionT3Threshold.get()).toBe(8000)
    expect(resolved.expandCountThreshold.get()).toBe(2)
    expect(resolved.chainDepthThreshold.get()).toBe(2)
    expect(resolved.compactionSelfTuneEnabled.get()).toBe(false)
    // Story 8.5 / AC:1827-1832：注入预算一律 tokens 的默认值（经验值，可运行期覆盖）。
    expect(resolved.injectionTokenCap.get()).toBe(4096)
    expect(resolved.injectionRatio.get()).toBe(0.5)
    expect(resolved.injectionSingleCap.get()).toBe(512)
    expect(resolved.injectionSummaryCap.get()).toBe(512)
    expect(resolved.alwaysOnTokenCap.get()).toBe(2000)
    // Story 8.6 / AC:1868：默认开 R1 + R3、关 R2；安全阀 24。
    expect(resolved.purifyR1.get()).toBe(true)
    expect(resolved.purifyR2.get()).toBe(false)
    expect(resolved.purifyR3.get()).toBe(true)
    expect(resolved.purifyMinRemainder.get()).toBe(24)
    // Story 11.2 / T2：Persona Spec 开关默认**关**（正文未获产品负责人批准）。
    expect(resolved.personaSpecEnabled.get()).toBe(false)
    // Story 11.3 / T5：Self-Knowledge 采集开关默认**关**（关闭时反思零候选，fail-closed）。
    expect(resolved.selfKnowledgeCaptureEnabled.get()).toBe(false)
    // Story 9.1 / AD-31：本体闸门默认 off（默认行为与未启用本体逐条一致）。
    expect(resolved.ontologyGate.get()).toEqual({ level: 'off' })
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

describe('Story 8.6：净化配置投影（AC:1868 / T2）', () => {
  it('缺省投影与 purify 模块的 DEFAULT_PURIFY_OPTIONS 同源（两处默认值不得漂移）', () => {
    expect(resolveRuntimeConfig(validConfig()).purify).toEqual(DEFAULT_PURIFY_OPTIONS)
  })

  it('四个开关运行期可覆盖（volatile，INV-12）', () => {
    const resolved = resolveRuntimeConfig({
      ...validConfig(),
      purifyR1: false,
      purifyR2: true,
      purifyR3: false,
      purifyMinRemainder: 40,
    })
    expect(resolved.purify).toEqual({ r1: false, r2: true, r3: false, minRemainder: 40 })
  })

  it('purifyMinRemainder 非正整数 ⇒ 硬校验抛错（安全阀不得静默失效）', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => resolveRuntimeConfig({ ...validConfig(), purifyMinRemainder: bad }))
        .toThrowError(/purifyMinRemainder/)
    }
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

  it('retrievalTopK 硬校验（F-12）：0 / 负数 / 非整数 / NaN 抛错，缺省 50 合法', () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const cfg = { ...validConfig(), retrievalTopK: bad }
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/retrievalTopK/)
      expect(() => resolveRuntimeConfig(cfg)).toThrowError(/≥ 1/)
    }
    expect(resolveRuntimeConfig(validConfig()).retrievalTopK).toBe(50)
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
      // 把 rerank 真的放进配置：v1 不读即不影响，否则 vacuous。
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
    // Story 2.5 / 评审 P3（T4）：systemOne 也可经 Config 注入 token（.role('secret')）。
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
    // token 只在运行时内存对象里（供调用），不进 warnings。
    expect(JSON.stringify(withToken)).toContain('sk-systemone')
    expect(JSON.stringify(withToken.warnings)).not.toContain('sk-systemone')

    // endpoint 不是凭据：与 embedding.endpoint 同约定，错误点名字段并回显当前值
    // （「消息含字段名+期望格式+当前值」用例）。
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

describe('Story 8.4 阈值治理（AC:1713-1760 / INV-12 / FR-28）', () => {
  it('默认值与 resolved 同源：schema 默认 === resolveRuntimeConfig 兜底', () => {
    const schemaResolved = Config({}) as Record<string, any>
    const runtime = resolveRuntimeConfig({})
    expect(schemaResolved.compactionLengthMin.get()).toBe(runtime.compactionLengthMin)
    expect(schemaResolved.compactionT3Threshold.get()).toBe(runtime.compactionT3Threshold)
    expect(schemaResolved.expandCountThreshold.get()).toBe(runtime.expandCountThreshold)
    expect(schemaResolved.chainDepthThreshold.get()).toBe(runtime.chainDepthThreshold)
    expect(schemaResolved.compactionSelfTuneEnabled.get()).toBe(runtime.compactionSelfTuneEnabled)
  })

  it('运行期可覆盖：五项全部按传入值生效', () => {
    const runtime = resolveRuntimeConfig({
      ...validConfig(),
      compactionLengthMin: 500,
      compactionT3Threshold: 4000,
      expandCountThreshold: 3,
      chainDepthThreshold: 4,
      compactionSelfTuneEnabled: true,
    })
    expect(runtime.compactionLengthMin).toBe(500)
    expect(runtime.compactionT3Threshold).toBe(4000)
    expect(runtime.expandCountThreshold).toBe(3)
    expect(runtime.chainDepthThreshold).toBe(4)
    expect(runtime.compactionSelfTuneEnabled).toBe(true)
    expect(runtime.warnings).toEqual([])
  })

  it('两条长度阈值必须构成合法三带：lengthMin >= t3Threshold 抛错（不静默夹紧）', () => {
    expect(() => resolveRuntimeConfig({ ...validConfig(), compactionLengthMin: 8000 }))
      .toThrowError(/compactionLengthMin.*compactionT3Threshold/)
    expect(() => resolveRuntimeConfig({ ...validConfig(), compactionT3Threshold: 100 }))
      .toThrowError(/compactionLengthMin.*compactionT3Threshold/)
  })

  it('四个数值阈值都是正整数硬校验（0 / 负数 / 非整数 / NaN 抛错）', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['compactionLengthMin', 0],
      ['compactionT3Threshold', -1],
      ['expandCountThreshold', 2.5],
      ['chainDepthThreshold', Number.NaN],
    ]
    for (const [field, bad] of cases) {
      const cfg = { ...validConfig(), [field]: bad }
      expect(() => resolveRuntimeConfig(cfg), field + '=' + String(bad)).toThrowError(new RegExp(field))
      expect(() => resolveRuntimeConfig(cfg), field + '=' + String(bad)).toThrowError(/≥ 1/)
    }
  })

  it('表单投影：五项都带 volatile（否则不进 /settings，AD-11）', () => {
    const dict = Config.dict as Record<string, any>
    for (const field of ['compactionLengthMin', 'compactionT3Threshold', 'expandCountThreshold', 'chainDepthThreshold', 'compactionSelfTuneEnabled']) {
      expect(dict[field]?.meta?.volatile, field).toBe(true)
    }
  })
})

/**
 * Story 8.5 / T2：注入预算的五个 Config 字段（AC:1826-1832、AD-25、INV-12）。
 * 四项上限是正整数硬校验（0/负/NaN 会让注入静默变零或无限）；`injectionRatio` 刻意不校验负数——
 * 负 ratio 的语义是「预算 0 + 可见告警」，由 T1 产出 warning，不在这里变成启动失败。
 */
describe('Story 8.5：注入预算字段（tokens）', () => {
  it('默认值与 resolved 同源（schema 的 .get() 与 resolveRuntimeConfig 一致）', () => {
    const schemaResolved = Config({}) as Record<string, any>
    // embedding 缺失的降级 warn 与本组字段无关，用全合法配置只钉注入预算五项。
    const runtime = resolveRuntimeConfig(validConfig())
    for (const [schemaField, runtimeValue] of [
      ['injectionTokenCap', runtime.injectionTokenCap],
      ['injectionRatio', runtime.injectionRatio],
      ['injectionSingleCap', runtime.injectionSingleCap],
      ['injectionSummaryCap', runtime.injectionSummaryCap],
      ['alwaysOnTokenCap', runtime.alwaysOnTokenCap],
    ] as const) {
      expect(schemaResolved[schemaField].get(), schemaField).toBe(runtimeValue)
    }
    expect(runtime.injectionTokenCap).toBe(4096)
    expect(runtime.injectionRatio).toBe(0.5)
    expect(runtime.injectionSingleCap).toBe(512)
    expect(runtime.injectionSummaryCap).toBe(512)
    expect(runtime.alwaysOnTokenCap).toBe(2000)
    expect(runtime.warnings).toEqual([])
  })

  it('运行期可覆盖：五项全部按传入值生效（INV-12）', () => {
    const runtime = resolveRuntimeConfig({
      ...validConfig(),
      injectionTokenCap: 2048,
      injectionRatio: 0.3,
      injectionSingleCap: 256,
      injectionSummaryCap: 128,
      alwaysOnTokenCap: 1024,
    })
    expect(runtime.injectionTokenCap).toBe(2048)
    expect(runtime.injectionRatio).toBe(0.3)
    expect(runtime.injectionSingleCap).toBe(256)
    expect(runtime.injectionSummaryCap).toBe(128)
    expect(runtime.alwaysOnTokenCap).toBe(1024)
    expect(runtime.warnings).toEqual([])
  })

  it('四项上限正整数硬校验：0 / 负数 / 非整数 / NaN 抛错', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['injectionTokenCap', 0],
      ['injectionSingleCap', -1],
      ['injectionSummaryCap', 2.5],
      ['alwaysOnTokenCap', Number.NaN],
    ]
    for (const [field, bad] of cases) {
      const cfg = { ...validConfig(), [field]: bad }
      expect(() => resolveRuntimeConfig(cfg), field + '=' + String(bad)).toThrowError(new RegExp(field))
      expect(() => resolveRuntimeConfig(cfg), field + '=' + String(bad)).toThrowError(/≥ 1/)
    }
  })

  it('injectionRatio 为负不抛错：降级语义是「预算 0 + 可见告警」，由 T1 产出 warning', () => {
    expect(resolveRuntimeConfig({ ...validConfig(), injectionRatio: -1 }).injectionRatio).toBe(-1)
  })

  it('五个字段都带 volatile（否则不进 /settings，AD-11）', () => {
    const dict = Config.dict as Record<string, any>
    for (const field of ['injectionTokenCap', 'injectionRatio', 'injectionSingleCap', 'injectionSummaryCap', 'alwaysOnTokenCap']) {
      expect(dict[field]?.meta?.volatile, field).toBe(true)
    }
  })
})

/**
 * Story 11.2 / T2：Persona Spec 开关（AD-38）。
 * 默认关（Spec 正文未经产品负责人批准）、运行期可覆盖（INV-12）、schema 默认与 resolved 兜底同源。
 */
describe('Story 11.2：Persona Spec 开关', () => {
  it('默认关闭，且 schema 默认值与 resolved 兜底同源', () => {
    const schemaResolved = Config({}) as Record<string, any>
    expect(schemaResolved.personaSpecEnabled.get()).toBe(false)
    // 降级 warn 与本字段无关：用全合法配置只钉该字段。
    expect(resolveRuntimeConfig(validConfig()).personaSpecEnabled).toBe(false)
  })

  it('运行期可覆盖（volatile，INV-12）：true 生效', () => {
    expect(resolveRuntimeConfig({ ...validConfig(), personaSpecEnabled: true }).personaSpecEnabled).toBe(true)
  })

  it('volatile 标记存在（否则不进 /settings 表单，AD-11）', () => {
    const dict = Config.dict as Record<string, any>
    expect(dict.personaSpecEnabled?.meta?.volatile).toBe(true)
  })
})

/**
 * Story 11.3 / T5：Self-Knowledge 采集开关（AD-38）。
 * 默认关（关闭时零候选）、运行期可覆盖（INV-12）、schema 默认与 resolved 兜底同源。
 */
describe('Story 11.3：Self-Knowledge 采集开关', () => {
  it('默认关闭，且 schema 默认值与 resolved 兜底同源', () => {
    const schemaResolved = Config({}) as Record<string, any>
    expect(schemaResolved.selfKnowledgeCaptureEnabled.get()).toBe(false)
    expect(resolveRuntimeConfig(validConfig()).selfKnowledgeCaptureEnabled).toBe(false)
  })

  it('运行期可覆盖（volatile，INV-12）：true 生效', () => {
    expect(resolveRuntimeConfig({ ...validConfig(), selfKnowledgeCaptureEnabled: true }).selfKnowledgeCaptureEnabled)
      .toBe(true)
  })

  it('volatile 标记存在（否则不进 /settings 表单，AD-11）', () => {
    const dict = Config.dict as Record<string, any>
    expect(dict.selfKnowledgeCaptureEnabled?.meta?.volatile).toBe(true)
  })
})

/**
 * Story 9.2 / T4、AD-40：本体输入与词表渲染配置。
 *
 * 默认 off（未配置 path）、预算 4000（AD-8 字符域）、allowlist 空 = 不过滤；
 * 预算 ≤ 0 / 非有限 / 非整数、allowlist 非字符串数组、path 非字符串一律 fail-loud
 * （静默关裁剪或静默退化成「不过滤」都会让 prompt 预算失控）。
 */
describe('Story 9.2：本体输入与词表渲染配置', () => {
  it('默认值：未配置 path（off）、空 allowlist、预算 4000', () => {
    const schemaResolved = Config({}) as Record<string, any>
    expect(schemaResolved.ontology.get()).toEqual({
      promptTypes: [],
      promptRelations: [],
      promptCharBudget: 4000,
    })
    expect(resolveRuntimeConfig(validConfig()).ontology).toEqual({
      promptTypes: [],
      promptRelations: [],
      promptCharBudget: 4000,
    })
    // 未配置 path 时对象里没有该键（`off` 的判据是缺键 / 空串，不是 undefined 占位）。
    expect('path' in resolveRuntimeConfig(validConfig()).ontology).toBe(false)
  })

  it('子对象整体 volatile（AD-11）；子字段为 plain（不嵌套 volatile）', () => {
    const dict = Config.dict as Record<string, any>
    expect(dict.ontology?.meta?.volatile).toBe(true)
    for (const key of ['path', 'promptTypes', 'promptRelations', 'promptCharBudget']) {
      expect(dict.ontology.dict[key]?.meta?.volatile, key).toBeUndefined()
    }
  })

  it('path 去空白；空串等价于未配置（off）', () => {
    const filled = resolveRuntimeConfig({
      ...validConfig(),
      ontology: { path: '  memory/ontology.ttl  ' },
    })
    expect(filled.ontology.path).toBe('memory/ontology.ttl')
    expect(resolveRuntimeConfig({ ...validConfig(), ontology: { path: '   ' } }).ontology.path).toBeUndefined()
  })

  it('allowlist 去空白、丢空项并冻结；非数组 / 非字符串 fail-loud', () => {
    const resolved = resolveRuntimeConfig({
      ...validConfig(),
      ontology: { promptTypes: [' https://e.test#Person ', '  '], promptRelations: ['https://e.test#worksAt'] },
    })
    expect(resolved.ontology.promptTypes).toEqual(['https://e.test#Person'])
    expect(resolved.ontology.promptRelations).toEqual(['https://e.test#worksAt'])
    expect(Object.isFrozen(resolved.ontology.promptTypes)).toBe(true)
    expect(() => resolveRuntimeConfig({
      ...validConfig(),
      ontology: { promptTypes: 'https://e.test#Person' as unknown as string[] },
    })).toThrow(/ontology\.promptTypes/)
    expect(() => resolveRuntimeConfig({
      ...validConfig(),
      ontology: { promptRelations: [1 as unknown as string] },
    })).toThrow(/ontology\.promptRelations/)
  })

  it('预算 ≤ 0 / 非有限 / 非整数 / 非字符串 path ⇒ fail-loud（不静默关裁剪，AD-40）', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 4000.5]) {
      expect(() => resolveRuntimeConfig({
        ...validConfig(),
        ontology: { promptCharBudget: bad },
      }), String(bad)).toThrow(/ontology\.promptCharBudget/)
    }
    expect(() => resolveRuntimeConfig({
      ...validConfig(),
      ontology: { path: 42 as unknown as string },
    })).toThrow(/ontology\.path/)
  })

  it('预算运行期可覆盖（volatile，INV-12）', () => {
    expect(resolveRuntimeConfig({
      ...validConfig(),
      ontology: { promptCharBudget: 120 },
    }).ontology.promptCharBudget).toBe(120)
  })
})

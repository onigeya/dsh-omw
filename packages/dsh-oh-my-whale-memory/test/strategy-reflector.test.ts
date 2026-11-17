/**
 * 反思执行器与提炼解析（Story 7.3 第 3 轮）。
 *
 * - 解析侧纯函数：合法 / 夹带说明文字 / 无 refs / 坏 outcome / 空数组 / 非 JSON；
 * - 执行器用假 `extract` + 可控时钟，**不等真实 90 秒**就能验证「空闲后触发」；
 * - 断言生产者的真实效果：候选落库（refs 校验）、`evidence=none` 的裁决、
 *   `maxPendingPerSession` 限额、LLM 失败计入熔断。
 * 开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { createReflectionState, type ReflectionState } from '../src/reflection/state'
import { createReflectionExecutor } from '../src/reflection/executor'
import { DEFAULT_REFLECTION_THRESHOLDS, INITIAL_BREAKER_STATE } from '../src/reflection/trigger'
import { listStrategyCandidates, strategyStats } from '../src/strategy/candidates'
import { countsByState, readSelfKnowledge, recordCandidate, selfKnowledgeId } from '../src/persona/self-knowledge'
import {
  STRATEGY_EXTRACT_INSTRUCTION,
  buildStrategyMessages,
  parseStrategyCandidates,
  type StrategySample,
} from '../src/strategy/extract'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = new Date('2026-06-01T00:00:00.000Z')
const SAMPLES: readonly StrategySample[] = [
  { ref: 'l0:1', text: '用户要求先跑测试再合并，我照做了' },
  { ref: 'l0:2', text: '我跳过了测试直接合并，结果回滚' },
]

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-exec-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('提炼解析（纯函数）', () => {
  it('合法 JSON：保留带 refs 的候选', () => {
    const result = parseStrategyCandidates(
      '{"candidates":[{"text":"改跨包代码前先跑 verify","outcome":"success","sourceRefs":["l0:1"]}]}',
      ['l0:1', 'l0:2'],
    )
    expect(result.candidates).toEqual([
      { text: '改跨包代码前先跑 verify', outcome: 'success', sourceRefs: ['l0:1'] },
    ])
    expect(result.dropped).toEqual([])
  })

  it('夹带说明文字也能解析（取首个 { 到末个 }）', () => {
    const result = parseStrategyCandidates(
      '好的，结果如下：\n{"candidates":[{"text":"先看 diff","outcome":"uncertain","sourceRefs":["l0:2"]}]}\n希望有帮助',
      ['l0:1', 'l0:2'],
    )
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.outcome).toBe('uncertain')
  })

  it('无 refs / refs 不在样本里 / 坏 outcome / 空正文 ⇒ 丢弃并记原因', () => {
    const result = parseStrategyCandidates(
      JSON.stringify({
        candidates: [
          { text: '没有引用', outcome: 'success', sourceRefs: [] },
          { text: '引用不存在', outcome: 'success', sourceRefs: ['l9:9'] },
          { text: '坏 outcome', outcome: 'maybe', sourceRefs: ['l0:1'] },
          { text: '   ', outcome: 'success', sourceRefs: ['l0:1'] },
        ],
      }),
      ['l0:1', 'l0:2'],
    )
    expect(result.candidates).toEqual([])
    expect(result.dropped).toHaveLength(4)
    expect(result.dropped.join(' ')).toContain('no-source-refs')
  })

  it('空数组 ⇒ 0 候选 0 丢弃（「没有可复用经验」是合法结果）', () => {
    expect(parseStrategyCandidates('{"candidates":[]}', ['l0:1'])).toEqual({ candidates: [], dropped: [] })
  })

  it('非 JSON ⇒ dropped=no-json-object / invalid-json', () => {
    expect(parseStrategyCandidates('不是 JSON', ['l0:1']).dropped).toEqual(['no-json-object'])
    expect(parseStrategyCandidates('{bad}', ['l0:1']).dropped).toEqual(['invalid-json'])
  })

  it('消息构造带 sentinel 与样本 ref；超长样本截断', () => {
    const messages = buildStrategyMessages([{ ref: 'l0:1', text: 'x'.repeat(2000) }])
    const first = messages[0]?.content?.[0] as { text?: string } | undefined
    const text = String(first?.text ?? '')
    expect(text).toContain('[l0:1]')
    expect(text).toContain('…')
    expect(STRATEGY_EXTRACT_INSTRUCTION).toContain('Field descriptions are never valid values')
  })
})

/** 可控时钟 + 假定时器：验证「空闲后触发」而不真等 90 秒。 */
function harness(options: {
  readonly samples?: readonly StrategySample[]
  readonly extract?: () => Promise<string>
  readonly maxPendingPerSession?: number
  /** Story 11.3 / T5：可选观察回调（写 Self-Knowledge 候选区）。 */
  readonly onObservation?: (observation: { readonly text: string; readonly sourceRefs: readonly string[] }) => Promise<void> | void
  readonly logger?: { warn(message: string): void }
}) {
  const state: ReflectionState = createReflectionState()
  state.windowScore = DEFAULT_REFLECTION_THRESHOLDS.threshold + 2
  state.breaker = INITIAL_BREAKER_STATE
  const clock = { at: T0.getTime() }
  let timerCallback: (() => void) | null = null
  const executor = createReflectionExecutor({
    connection: () => store.connection,
    collectSamples: async () => options.samples ?? SAMPLES,
    extract: options.extract ?? (async () => '{"candidates":[]}'),
    state,
    thresholds: DEFAULT_REFLECTION_THRESHOLDS,
    gate: {
      minConfidence: 0.6,
      expiryDays: 7,
      maxPendingPerSession: options.maxPendingPerSession ?? 5,
    },
    now: () => new Date(clock.at),
    setTimer: (callback) => {
      timerCallback = callback
      return 1
    },
    clearTimer: () => {
      timerCallback = null
    },
    ...(options.onObservation === undefined ? {} : { onObservation: options.onObservation }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return {
    state,
    executor,
    /** 模拟「turn 刚结束」→ 推进时钟到空闲满足 → 执行一次。 */
    async runAfterIdle(advanceMs = 120_000) {
      executor.scheduleAfterIdle(0)
      clock.at += advanceMs
      return executor.runOnce()
    },
    /** 取出定时器回调（验证 schedule 真的注册了）。 */
    hasTimer: () => timerCallback !== null,
  }
}

describe('执行器：触发与限额（AC:1455-1462、1490）', () => {
  it('窗口分不足 ⇒ not-triggered(threshold)，不写候选', async () => {
    const state = createReflectionState()
    const executor = createReflectionExecutor({
      connection: () => store.connection,
      collectSamples: async () => SAMPLES,
      extract: async () => '{"candidates":[]}',
      state,
      thresholds: DEFAULT_REFLECTION_THRESHOLDS,
      gate: { minConfidence: 0.6, expiryDays: 7, maxPendingPerSession: 5 },
      now: () => T0,
    })
    const result = await executor.runOnce()
    expect(result.outcome).toBe('not-triggered')
    expect(result.reason).toBe('threshold')
  })

  it('达标但空闲不足 ⇒ not-triggered(idle)', async () => {
    const { executor } = harness({})
    const result = await executor.runOnce()
    expect(result.outcome).toBe('not-triggered')
    expect(result.reason).toBe('idle')
  })

  it('空闲足够 ⇒ 触发并落候选（refs 校验通过），空 case 集 ⇒ evidence=none ⇒ 不采纳', async () => {
    const { state, executor, runAfterIdle } = harness({
      extract: async () => JSON.stringify({
        candidates: [{ text: '改跨包代码前先跑 pnpm verify', outcome: 'success', sourceRefs: ['l0:1'] }],
      }),
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('extracted')
    expect(result.candidates).toBe(1)
    // 状态机：窗口清空 + 记录反思时刻
    expect(state.windowScore).toBe(0)
    expect(state.lastReflectionAt).not.toBeNull()
    // 候选落库且因无 case 集被判 rejected（AD-20：不得宣称有效）
    const candidates = await listStrategyCandidates(store.connection, { includeFailure: true })
    const inserted = candidates.find((item) => item.payload === '改跨包代码前先跑 pnpm verify')
    expect(inserted).toBeDefined()
    expect(inserted?.state).toBe('rejected')
    expect(inserted?.reasons).toContain('no-cases')
  })

  it('候选区达 maxPendingPerSession ⇒ throttled（0 ≥ 0 也拦）', async () => {
    const { executor, runAfterIdle } = harness({ maxPendingPerSession: 0 })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('throttled')
    expect(result.reason).toContain('maxPendingPerSession')
  })

  it('LLM 抛错 ⇒ failed 且熔断计数 +1（不丢账）', async () => {
    const { state, executor, runAfterIdle } = harness({
      extract: async () => {
        throw new Error('llm down')
      },
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('failed')
    expect(state.breaker.consecutiveFailures).toBe(1)
  })

  it('无样本 ⇒ no-samples（不编造候选）；schedule 真的注册了定时器', async () => {
    const { executor, runAfterIdle, hasTimer } = harness({ samples: [] })
    executor.scheduleAfterIdle(0)
    expect(hasTimer()).toBe(true)
    const result = await runAfterIdle()
    expect(result.outcome).toBe('no-samples')
  })

  it('候选全部被丢弃（无 refs）⇒ no-candidates 且 dropped 可见', async () => {
    const { executor, runAfterIdle } = harness({
      extract: async () => JSON.stringify({ candidates: [{ text: '无引用', outcome: 'success', sourceRefs: [] }] }),
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('no-candidates')
    expect(result.dropped.join(' ')).toContain('no-source-refs')
    void strategyStats
  })


  it('候选落库时带上 source_refs（AC:1458：可回溯到 L0）', async () => {
    const candidates = await listStrategyCandidates(store.connection, { includeFailure: true })
    const inserted = candidates.find((item) => item.payload === '改跨包代码前先跑 pnpm verify')
    expect(inserted?.sourceRefs).toEqual(['l0:1'])
  })
})

describe('Story 11.3 / T5：反思成功后的自省候选接线', () => {
  it('缺省 onObservation ⇒ 零候选（关闭时 fail-closed）', async () => {
    const before = await countsByState(store.connection)
    const { executor, runAfterIdle } = harness({
      extract: async () => JSON.stringify({
        candidates: [{ text: '缺省不写自省的观察', outcome: 'success', sourceRefs: ['l0:1'] }],
      }),
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('extracted')
    const after = await countsByState(store.connection)
    expect(after.candidate + after.accepted + after.rejected)
      .toBe(before.candidate + before.accepted + before.rejected)
  })

  it('onObservation 收到 {text, sourceRefs} 并写入候选区（source_refs 归一化为 L0 id）', async () => {
    const seen: Array<{ text: string; sourceRefs: readonly string[] }> = []
    const { executor, runAfterIdle } = harness({
      extract: async () => JSON.stringify({
        candidates: [{ text: '反思观察：先看证据再下结论', outcome: 'uncertain', sourceRefs: ['l0:1'] }],
      }),
      onObservation: async (observation) => {
        seen.push(observation)
        await recordCandidate(store.connection, {
          text: observation.text,
          sourceRefs: observation.sourceRefs,
        })
      },
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('extracted')
    expect(seen).toEqual([{ text: '反思观察：先看证据再下结论', sourceRefs: ['l0:1'] }])
    const row = await readSelfKnowledge(store.connection, selfKnowledgeId('反思观察：先看证据再下结论'))
    expect(row?.state).toBe('candidate')
    // `l0:` 前缀归一化为裸 L0 id（与 memory.source_refs 同形态）。
    expect(row?.sourceRefs).toEqual(['1'])
  })

  it('回调失败只 warn：策略候选照常落库、反思状态机记成功', async () => {
    const warn = vi.fn()
    const { state, executor, runAfterIdle } = harness({
      extract: async () => JSON.stringify({
        candidates: [{ text: '回调失败不影响策略候选', outcome: 'success', sourceRefs: ['l0:2'] }],
      }),
      onObservation: async () => {
        throw new Error('self-knowledge write failed')
      },
      logger: { warn },
    })
    const result = await runAfterIdle()
    expect(result.outcome).toBe('extracted')
    expect(state.lastReflectionAt).not.toBeNull()
    const candidates = await listStrategyCandidates(store.connection, { includeFailure: true })
    expect(candidates.some((item) => item.payload === '回调失败不影响策略候选')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('自省候选写入失败')
  })
})

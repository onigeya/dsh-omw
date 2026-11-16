/**
 * 策略候选区（Story 7.3 第 2 轮 / AD-20）。
 *
 * 覆盖：入队/读取、采纳门结果落库（adopted/rejected）、重写次数上限（2 次后抛
 * `strategy_rewrite_exhausted`）、丢弃（outcome=failure 且失败经验隔离）、过期扫描、
 * 元层计数就地累加（不新建版本）、候选区统计（含 evidence=none 计数）。开库预算：1 个库。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { firstGateDecision } from './helpers/gate-fixture'
import {
  MAX_STRATEGY_REWRITES,
  bumpStrategyCounter,
  discardStrategyCandidate,
  expireStrategyCandidates,
  insertStrategyCandidate,
  listStrategyCandidates,
  readStrategyCandidate,
  recordGateResult,
  rewriteStrategyCandidate,
  strategyStats,
} from '../src/strategy/candidates'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-06-01T00:00:00.000Z'
const LATER = '2026-06-10T00:00:00.000Z'

let store: MemoryDatabase

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-strategy-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('候选区：写入与读取（AC:1455-1458）', () => {
  it('落一条 pending 候选并可读回；默认列表含它', async () => {
    await insertStrategyCandidate(store.connection, {
      id: 'cand-1',
      strategyId: 'strat-1',
      payload: '遇到跨包改动时先跑 pnpm verify 再合并',
      outcome: 'success',
      createdAt: T0,
      expiresAt: LATER,
    })
    const candidate = await readStrategyCandidate(store.connection, 'cand-1')
    expect(candidate?.state).toBe('pending')
    expect(candidate?.rewrites).toBe(0)
    expect(candidate?.payload).toContain('pnpm verify')
    const list = await listStrategyCandidates(store.connection)
    expect(list.map((item) => item.id)).toContain('cand-1')
  })
})

describe('采纳门结果（AC:1471、1490）', () => {
  it('adopted=true ⇒ state=adopted 且落 score；adopted=false ⇒ state=rejected 且落 reasons', async () => {
    await insertStrategyCandidate(store.connection, {
      id: 'cand-adopt',
      strategyId: 'strat-adopt',
      payload: '先看 diff 再看测试',
      outcome: 'success',
      createdAt: T0,
      expiresAt: LATER,
    })
    await recordGateResult(store.connection, {
      id: 'cand-adopt',
      adopted: true,
      score: 1,
      reasons: [],
      nowIso: T0,
    })
    expect((await readStrategyCandidate(store.connection, 'cand-adopt'))?.state).toBe('adopted')

    await insertStrategyCandidate(store.connection, {
      id: 'cand-reject',
      strategyId: 'strat-reject',
      payload: '跳过测试直接合并',
      outcome: 'failure',
      createdAt: T0,
      expiresAt: LATER,
    })
    await recordGateResult(store.connection, {
      id: 'cand-reject',
      adopted: false,
      score: 0.2,
      reasons: ['case c1：分数回归'],
      nowIso: T0,
    })
    const rejected = await readStrategyCandidate(store.connection, 'cand-reject')
    expect(rejected?.state).toBe('rejected')
    expect(rejected?.reasons).toContain('c1')
    // 失败经验隔离：默认列表不返回 outcome=failure
    const visible = await listStrategyCandidates(store.connection)
    expect(visible.map((item) => item.id)).not.toContain('cand-reject')
    const withFailure = await listStrategyCandidates(store.connection, { includeFailure: true })
    expect(withFailure.map((item) => item.id)).toContain('cand-reject')
  })

  it('不存在的候选 ⇒ strategy_candidate_not_found', async () => {
    await expect(recordGateResult(store.connection, {
      id: 'nope',
      adopted: true,
      score: 1,
      reasons: [],
      nowIso: T0,
    })).rejects.toMatchObject({ code: 'strategy_candidate_not_found' })
  })
})

describe('两次重写上限（AC:1490）', () => {
  it('允许 2 次重写，第 3 次抛 strategy_rewrite_exhausted', async () => {
    await insertStrategyCandidate(store.connection, {
      id: 'cand-rewrite',
      strategyId: 'strat-rw',
      payload: '初版',
      outcome: 'uncertain',
      createdAt: T0,
      expiresAt: LATER,
    })
    for (let index = 1; index <= MAX_STRATEGY_REWRITES; index += 1) {
      const result = await rewriteStrategyCandidate(store.connection, {
        id: 'cand-rewrite',
        payload: `第 ${String(index)} 版`,
        nowIso: T0,
      })
      expect(result.rewrites).toBe(index)
    }
    expect((await readStrategyCandidate(store.connection, 'cand-rewrite'))?.payload).toBe('第 2 版')
    await expect(rewriteStrategyCandidate(store.connection, {
      id: 'cand-rewrite',
      payload: '第 3 版',
      nowIso: T0,
    })).rejects.toMatchObject({ code: 'strategy_rewrite_exhausted' })
    expect(MAX_STRATEGY_REWRITES).toBe(2)
  })

  it('丢弃 ⇒ rejected + outcome=failure（失败经验保留）', async () => {
    await discardStrategyCandidate(store.connection, {
      id: 'cand-rewrite',
      reason: 'rewrite-exhausted',
      nowIso: T0,
    })
    const candidate = await readStrategyCandidate(store.connection, 'cand-rewrite')
    expect(candidate?.state).toBe('rejected')
    expect(candidate?.outcome).toBe('failure')
    expect(candidate?.reasons).toBe('rewrite-exhausted')
  })
})

describe('过期扫描（strategyGate.expiryDays）', () => {
  it('expires_at < now 且 pending ⇒ expired；已 adopted 的不动', async () => {
    await insertStrategyCandidate(store.connection, {
      id: 'cand-expire',
      strategyId: 'strat-exp',
      payload: '会过期',
      outcome: 'success',
      createdAt: T0,
      expiresAt: '2026-06-02T00:00:00.000Z',
    })
    const expired = await expireStrategyCandidates(store.connection, LATER)
    expect(expired).toBeGreaterThanOrEqual(1)
    expect((await readStrategyCandidate(store.connection, 'cand-expire'))?.state).toBe('expired')
    expect((await readStrategyCandidate(store.connection, 'cand-adopt'))?.state).toBe('adopted')
  })
})

describe('元层计数就地累加（AD-20：不新建版本）', () => {
  it('同一 strategyId 的 usage 累加 3 次后为 3', async () => {
    expect(await bumpStrategyCounter(store.connection, { strategyId: 'strat-1', name: 'usage' })).toBe(1)
    expect(await bumpStrategyCounter(store.connection, { strategyId: 'strat-1', name: 'usage' })).toBe(2)
    expect(await bumpStrategyCounter(store.connection, { strategyId: 'strat-1', name: 'usage' })).toBe(3)
    // 不同计数互不影响
    expect(await bumpStrategyCounter(store.connection, { strategyId: 'strat-1', name: 'adopted' })).toBe(1)
  })
})

describe('候选区统计（AC:1494、1498）', () => {
  it('计数含 pending/adopted/rejected/expired 与 evidence=none', async () => {
    const decision = firstGateDecision()
    await insertStrategyCandidate(store.connection, {
      id: 'cand-noev',
      strategyId: 'strat-noev',
      payload: '无 case 集',
      outcome: 'uncertain',
      createdAt: T0,
      expiresAt: LATER,
    })
    await recordGateResult(store.connection, {
      id: 'cand-noev',
      adopted: decision.adopted,
      score: 0,
      reasons: decision.reasons,
      nowIso: T0,
    })
    const stats = await strategyStats(store.connection)
    expect(stats.candidates).toBeGreaterThanOrEqual(4)
    expect(stats.adopted).toBeGreaterThanOrEqual(1)
    expect(stats.rejected).toBeGreaterThanOrEqual(2)
    expect(stats.expired).toBeGreaterThanOrEqual(1)
    expect(stats.noEvidence).toBe(1)
  })
})

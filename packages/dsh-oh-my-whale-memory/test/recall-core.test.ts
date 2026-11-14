/**
 * 混合检索内核（src/recall/core.ts）真库钉（Story 3.1 / FR-11、FR-12）。
 *
 * 覆盖：双路 RRF 融合排序（只按 rank）、embedding_model_id 与库内 pin 不符排除、
 * 快照四条件排除、degraded 关键词单路（含向量路异常降级，F-01）、层权重（L2 优先 L1）
 * 与 priority=-1 恒置顶、同分稳定次级键（recorded_at 降序 → id 升序）、layer 过滤 /
 * limit 夹紧 / truncated / evidence 标注、FTS 查询串净化（F-03：控制字符剥离 + 限长 +
 * `$q` 绑定下注入被当数据）。
 *
 * 开库次数：本文件 1 次（LadybugDB 每进程约 15 个实例封顶）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as lbug from '@ladybugdb/core'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { upsertMemory } from '../src/db/memory'
import { memoryNodeId } from '../src/db/id'
import { resolveMemoryDbPath } from '../src/db/paths'
import { estimateTokens } from '../src/distill/llm-refine'
import {
  BM25_B,
  BM25_K,
  RECALL_DEFAULT_LIMIT,
  RECALL_FTS_QUERY_MAX_CODE_POINTS,
  RECALL_MAX_LIMIT,
  RECALL_MIN_LIMIT,
  RECALL_TEXT_TOKEN_BUDGET,
  clampRecallLimit,
  runRecallCore,
  sanitizeFtsQuery,
  type RecallCoreInput,
  type RecallCoreResult,
} from '../src/recall/core'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const PAST = '2026-01-01T00:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
const MODEL = 'test-embed'
const OTHER_MODEL = 'other-model'
const LAYER_WEIGHTS = { l2: 0.7, l1: 0.4 }
/** priority 二次加权系数（Config `priorityWeight` 缺省值，spec D4）。 */
const PRIORITY_WEIGHT = 0.5
const A = [1, 0, 0, 0]
const B = [0, 1, 0, 0]
const C = [0, 0, 1, 0]
const D = [0, 0, 0, 1]

let store: MemoryDatabase

const nid = (key: string, layer = 'L1'): string => memoryNodeId(layer, key)

interface SeedOptions {
  readonly layer?: string
  readonly recordedAt?: string
  readonly validAt?: string
  readonly invalidAt?: string | null
  readonly embedding?: readonly number[] | null
  readonly embeddingModelId?: string | null
  readonly priority?: number
  readonly sourceRefs?: readonly string[]
}

async function seed(key: string, options: SeedOptions = {}): Promise<string> {
  const layer = options.layer ?? 'L1'
  const embedding = options.embedding ?? null
  await upsertMemory(store.connection, {
    layer,
    text: key,
    embedding,
    embeddingModelId: embedding === null ? null : (options.embeddingModelId ?? MODEL),
    kind: '',
    priority: options.priority ?? 0,
    validAt: options.validAt ?? PAST,
    recordedAt: options.recordedAt ?? PAST,
    sourceRefs: options.sourceRefs ?? [],
  })
  const id = nid(key, layer)
  if (options.invalidAt !== undefined) {
    const prepared = await store.connection.prepare('MATCH (m:memory {id: $id}) SET m.invalid_at = $invalid_at')
    await store.connection.execute(prepared, { id, invalid_at: options.invalidAt })
  }
  return id
}

/** 统一走内核：默认 NOW/双路配置，按需覆盖。 */
function recall(overrides: Partial<RecallCoreInput> & Pick<RecallCoreInput, 'query' | 'queryVector'>): Promise<RecallCoreResult> {
  return runRecallCore({
    connection: store.connection,
    embeddingModelId: MODEL,
    rrfK: 60,
    retrievalTopK: 50,
    layerWeights: LAYER_WEIGHTS,
    priorityWeight: PRIORITY_WEIGHT,
    limit: RECALL_DEFAULT_LIMIT,
    now: NOW,
    ...overrides,
  })
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-recall-core-')),
    dim: DIM,
    modelId: MODEL,
  })

  // ---- alpha 组：双路命中 + 层权重 + priority=-1 + evidence + 快照排除 ----
  await seed('alpha recall l2 primary', { layer: 'L2', embedding: A, sourceRefs: ['src-l2'] })
  await seed('alpha recall l1 secondary', { embedding: A })
  await seed('alpha pinned rule', { embedding: A, priority: -1, sourceRefs: ['src-pin'] })
  await seed('alpha tombstone excluded', { embedding: A, invalidAt: PAST })
  await seed('alpha future valid excluded', { embedding: A, validAt: FUTURE })
  await seed('alpha future recorded excluded', { embedding: A, recordedAt: FUTURE })

  // ---- 其它关键词/向量节点（参与但不在 alpha 断言内） ----
  await seed('beta only keyword path', { embedding: B })
  await seed('gamma model mismatch', { embedding: C, embeddingModelId: OTHER_MODEL })
  // 超长文本：1200 个拉丁字符 ≈ 300 token（`estimateTokens` 按 4 字符/token 折算）
  // ⇒ 超过 RECALL_TEXT_TOKEN_BUDGET(256)，触发真截断。
  await seed(`omega ${'x'.repeat(1200)}`, { embedding: D })

  // ---- priority 二次加权隔离组（查询串 'boostprio' 只在下面两条出现） ----
  // 词频 3 的噪声条在 weight=0 时靠 BM25 排第一；priority=90 的规则条在 weight=50 时反超。
  await seed('boostprio rule', { priority: 90 })
  await seed('boostprio boostprio boostprio noise')

  // ---- 层权重隔离组（唯一 token + 唯一向量） ----
  await seed('layerweight principle statement', { layer: 'L2', embedding: [0.5, 0.5, 0, 0] })
  await seed('layerweight evidence statement', { embedding: [0.5, 0.5, 0, 0] })

  // ---- 同分稳定次级键：各由单路 rank1 命中 ⇒ rrf 相同 ----
  await seed('zeta keyword only', { recordedAt: '2026-02-01T00:00:00.000Z' })
  await seed('no shared words here', { embedding: [0, 0, 0.5, 0.5], recordedAt: '2026-02-01T00:00:00.000Z' })
  await seed('yota keyword earlier', { recordedAt: '2026-02-01T00:00:00.000Z' })
  await seed('vector side no token', { embedding: [0.25, 0.25, 0.25, 0.25], recordedAt: '2026-03-01T00:00:00.000Z' })
})

afterAll(async () => {
  await store?.close()
  await cleanupTempDirs()
})

describe('纯函数：常量 / 夹紧 / 转义', () => {
  it('limit 夹紧到 [1,20]，缺省 5', () => {
    expect([RECALL_MIN_LIMIT, RECALL_MAX_LIMIT, RECALL_DEFAULT_LIMIT]).toEqual([1, 20, 5])
    expect(clampRecallLimit(undefined)).toBe(5)
    expect(clampRecallLimit(0)).toBe(1)
    expect(clampRecallLimit(99)).toBe(20)
    expect(clampRecallLimit(7)).toBe(7)
  })

  it('BM25 查询期参数取 FR-11 锁定值', () => {
    expect(BM25_K).toBe(1.2)
    expect(BM25_B).toBe(0.75)
  })

  it('FTS 查询串净化（F-03）：剥离 C0 控制字符、空白归一、限长 256 code points', () => {
    // NUL / 控制字符会破坏内联字面量的语句级解析 ⇒ 归一成空格（对 BM25 分词等价）。
    expect(sanitizeFtsQuery('alpha\u0000beta')).toBe('alpha beta')
    expect(sanitizeFtsQuery('alpha\u0001\u001F beta\u007F')).toBe('alpha beta')
    // 空白归一 + trim：行终止符不再需要单独处理。
    expect(sanitizeFtsQuery('  alpha\n\tbeta\r\n')).toBe('alpha beta')
    // 长度上限按 code points 计（不是 UTF-16 code units）：CJK/emoji 不会被切成半个字符。
    expect(RECALL_FTS_QUERY_MAX_CODE_POINTS).toBe(256)
    expect(Array.from(sanitizeFtsQuery('记'.repeat(1000)))).toHaveLength(256)
    expect(Array.from(sanitizeFtsQuery('😀'.repeat(1000)))).toHaveLength(256)
    expect(sanitizeFtsQuery('')).toBe('')
  })
})

describe('runRecallCore：双路融合与层权重', () => {
  it('query=alpha 双路命中：返回 {total>0, results, degraded:false, hint}，字段齐全', async () => {
    const result = await recall({ query: 'alpha', queryVector: A })
    // total = limit 截断前的融合命中总数；results.length = min(limit, total)（spec D6）。
    expect(result.total).toBeGreaterThan(0)
    expect(result.results.length).toBe(Math.min(RECALL_DEFAULT_LIMIT, result.total))
    expect(result.degraded).toBe(false)
    expect(result.hint).toContain('混合检索')

    const target = result.results.find((item) => item.id === nid('alpha recall l2 primary', 'L2'))
    expect(target).toBeDefined()
    expect(target).toMatchObject({
      id: nid('alpha recall l2 primary', 'L2'),
      layer: 'L2',
      kind: '',
      priority: 0,
      text: 'alpha recall l2 primary',
    })
    // evidence 只在 source_refs 非空时出现。
    expect(target!.evidence).toEqual(['src-l2'])
    const secondary = result.results.find((item) => item.id === nid('alpha recall l1 secondary'))
    expect(secondary).toBeDefined()
    expect(secondary!.evidence).toBeUndefined()
  })

  it('L2 层权重 0.7 > L1 层权重 0.4：同 RRF 下 L2 排在 L1 前', async () => {
    const result = await recall({ query: 'layerweight', queryVector: [0.5, 0.5, 0, 0] })
    const ids = result.results.map((item) => item.id)
    const l2 = nid('layerweight principle statement', 'L2')
    const l1 = nid('layerweight evidence statement', 'L1')
    expect(ids).toContain(l2)
    expect(ids).toContain(l1)
    expect(ids.indexOf(l2)).toBeLessThan(ids.indexOf(l1))
  })

  it('priorityWeight 参与二次加权：weight=0 时纯 RRF 序，weight=50 时 priority=90 反超', async () => {
    const neutral = await recall({ query: 'boostprio', queryVector: null, priorityWeight: 0 })
    // weight=0 ⇒ 系数恒 1，排序回到纯 RRF（词频更高的噪声条 rank1）。
    expect(neutral.results[0]?.id).toBe(nid('boostprio boostprio boostprio noise'))
    expect(neutral.results[0]?.priority).toBe(0)

    const boosted = await recall({ query: 'boostprio', queryVector: null, priorityWeight: 50 })
    // weight=50 × priority=90 ⇒ 系数 46，足以让 rank2 的规则条反超（spec D4 的二次加权语义）。
    expect(boosted.results[0]?.id).toBe(nid('boostprio rule'))
    expect(boosted.results[0]?.priority).toBe(90)
    // 结果集不变：priority 只改排序，不筛选节点。
    expect(new Set(boosted.results.map((item) => item.id))).toEqual(new Set(neutral.results.map((item) => item.id)))
  })

  it('priority=-1 恒置顶（即使 RRF 更低）', async () => {
    const result = await recall({ query: 'alpha', queryVector: A })
    expect(result.results[0]?.id).toBe(nid('alpha pinned rule'))
    expect(result.results[0]?.priority).toBe(-1)
  })

  it('快照四条件：墓碑 / 将来生效 / 将来记录 都不出现（双路查询）', async () => {
    const result = await recall({ query: 'alpha', queryVector: A })
    const ids = new Set(result.results.map((item) => item.id))
    expect(ids.has(nid('alpha tombstone excluded'))).toBe(false)
    expect(ids.has(nid('alpha future valid excluded'))).toBe(false)
    expect(ids.has(nid('alpha future recorded excluded'))).toBe(false)
  })

  it('layer 过滤：只返回指定层', async () => {
    const result = await recall({ query: 'alpha', queryVector: A, layer: 'L1' })
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.every((item) => item.layer === 'L1')).toBe(true)
    expect(result.results.some((item) => item.id === nid('alpha recall l2 primary', 'L2'))).toBe(false)
  })

  it('limit 截断：results 只留 limit 条，但 total 是截断前的命中总数（spec D6）', async () => {
    const full = await recall({ query: 'alpha', queryVector: A })
    expect(full.total).toBeGreaterThan(1)
    // 命中数超过缺省 limit ⇒ total 大于 results.length（这正是 total 的信息量所在）。
    expect(full.results.length).toBe(Math.min(RECALL_DEFAULT_LIMIT, full.total))
    const limited = await recall({ query: 'alpha', queryVector: A, limit: 1 })
    expect(limited.results).toHaveLength(1)
    // total 不因 limit 变小：它描述命中规模，results.length 描述本次返回量。
    expect(limited.total).toBe(full.total)
    expect(limited.results.length).toBe(Math.min(1, limited.total))
    expect(limited.results[0]?.id).toBe(full.results[0]?.id)
  })
})

describe('runRecallCore：degraded 与模型 pin', () => {
  it('无查询向量 ⇒ 关键词单路 + degraded:true（快照仍需生效）', async () => {
    const result = await recall({ query: 'alpha', queryVector: null })
    expect(result.degraded).toBe(true)
    expect(result.hint).toContain('降级')
    expect(result.total).toBeGreaterThan(0)
    const ids = new Set(result.results.map((item) => item.id))
    expect(ids.has(nid('alpha recall l1 secondary'))).toBe(true)
    expect(ids.has(nid('alpha tombstone excluded'))).toBe(false)
  })

  it('embedding_model_id 与库内 pin 不符的节点不进向量路', async () => {
    // limit 20：向量路无距离阈值（top-k 粗排），取大一点让 pin 一致的节点都能进结果。
    const result = await recall({ query: 'zzz-no-keyword-hit', queryVector: C, limit: 20 })
    const ids = new Set(result.results.map((item) => item.id))
    expect(ids.has(nid('gamma model mismatch'))).toBe(false)
    // 同一查询确实走了向量路（pin 一致的节点仍在）。
    expect(ids.has(nid('alpha recall l2 primary', 'L2'))).toBe(true)
    expect(result.degraded).toBe(false)
  })

  it('无命中是正常成功值：total 0、results []、hint 说明', async () => {
    // 'qqq' 不与任何播种文本共享 token（FTS 按 token 匹配，'zzz-no-such-token' 会命中 'token'）。
    const result = await recall({ query: 'qqq', queryVector: null })
    expect(result).toEqual({
      total: 0,
      results: [],
      degraded: true,
      hint: '无匹配记忆（embedding 不可用，本次仅关键词单路）。',
    })
  })
})

describe('runRecallCore：稳定次级键与标注', () => {
  it('同分同 recorded_at：按 id 升序（任何进程同一序）', async () => {
    const result = await recall({ query: 'zeta', queryVector: [0, 0, 0.5, 0.5] })
    const keyword = nid('zeta keyword only')
    const vector = nid('no shared words here')
    const positions = new Map(result.results.map((item, index) => [item.id, index]))
    // 两条各由单路 rank1 命中 ⇒ RRF 相同；同层同 priority、同 recorded_at ⇒ id 升序。
    expect(positions.get(keyword)).toBeDefined()
    expect(positions.get(vector)).toBeDefined()
    const expectedFirst = keyword < vector ? keyword : vector
    const expectedSecond = expectedFirst === keyword ? vector : keyword
    expect(positions.get(expectedFirst)!).toBeLessThan(positions.get(expectedSecond)!)
  })

  it('同分不同 recorded_at：按 recorded_at 降序（更晚记录先）', async () => {
    const result = await recall({ query: 'yota', queryVector: [0.25, 0.25, 0.25, 0.25] })
    const earlier = nid('yota keyword earlier')
    const later = nid('vector side no token')
    const positions = new Map(result.results.map((item, index) => [item.id, index]))
    expect(positions.has(earlier)).toBe(true)
    expect(positions.has(later)).toBe(true)
    expect(positions.get(later)).toBeLessThan(positions.get(earlier)!)
  })

  it('超长 text：截断到首段 + … 并标 truncated:true，节点不丢（spec Always 第 6 条）', async () => {
    const longText = `omega ${'x'.repeat(1200)}`
    const result = await recall({ query: 'omega', queryVector: null })
    const hit = result.results.find((item) => item.id === nid(longText))
    // 节点不丢：截断只改 text，命中仍在结果里。
    expect(hit).toBeDefined()
    expect(hit!.truncated).toBe(true)
    expect(estimateTokens(longText)).toBeGreaterThan(RECALL_TEXT_TOKEN_BUDGET)
    // 真截断：不是原文，是「首段 + …」，且首段仍在 256 token 预算内。
    expect(hit!.text).not.toBe(longText)
    expect(hit!.text.endsWith('…')).toBe(true)
    expect(hit!.text.length).toBeLessThan(longText.length)
    const body = hit!.text.slice(0, -1)
    expect(body.startsWith('omega ')).toBe(true)
    expect(estimateTokens(body)).toBeLessThanOrEqual(RECALL_TEXT_TOKEN_BUDGET)
  })

  it('$q 绑定（P2 复测）：带引号/反斜杠的注入尝试不抛错、不放大命中（被当数据）', async () => {
    const all = await recall({ query: 'alpha', queryVector: null })
    const injected = await recall({ query: "alpha' OR 1=1 --", queryVector: null })
    // 绑定形态下注入片段是 FTS 的查询数据：不抛错，命中不放大（仍是 token 匹配的结果）。
    expect(Number.isInteger(injected.total)).toBe(true)
    expect(injected.total).toBeLessThanOrEqual(all.total)
  })

  it('多行 query 不因内联换行解析失败（行终止符归一为空格）', async () => {
    const result = await recall({ query: 'alpha\nbeta', queryVector: null })
    expect(result.total).toBeGreaterThanOrEqual(0)
    // 换行归一不影响 token 命中：与空格分隔的同一查询等价。
    const spaced = await recall({ query: 'alpha beta', queryVector: null })
    expect(result.total).toBe(spaced.total)
  })

  it('含 NUL/控制字符的 query（F-03）：净化后不抛错、与空白分隔同义', async () => {
    // 未净化时内联 NUL 会让语句级解析直接失败——现在先剥离控制字符再内联。
    const result = await recall({ query: 'alpha\u0000beta', queryVector: null })
    const spaced = await recall({ query: 'alpha beta', queryVector: null })
    expect(result.total).toBe(spaced.total)
    expect(result.total).toBeGreaterThanOrEqual(1)
  })

  it('超长 query（F-03）：截断到 256 code points，不抛错、不放大命中', async () => {
    const long = 'alpha' + ' x'.repeat(2000)
    const result = await recall({ query: long, queryVector: null })
    expect(result.total).toBeGreaterThanOrEqual(1)
    // 截断只保留前 256 code points（首 token 仍是 alpha），命中不因截断放大。
    const capped = await recall({ query: 'alpha' + ' x'.repeat(125), queryVector: null })
    expect(result.total).toBe(capped.total)
  })

  it('FTS 语法字符（F-03 补充探针）：* / " / 布尔词 不抛错，结果有界', async () => {
    for (const query of ['alpha*', '"alpha"', 'alpha AND beta', 'alpha OR beta']) {
      const result = await recall({ query, queryVector: null })
      // 语法字符被 FTS 引擎按自身的查询语法处理（不是注入面）：不抛错、命中有界即可；
      // 关键词路任何一次抛错都会让本用例直接红掉（向量路为 null 时无降级可用）。
      expect(Number.isInteger(result.total)).toBe(true)
      expect(result.total).toBeLessThanOrEqual(50)
    }
  })
})

describe('runRecallCore：向量路异常降级（F-01 / spec I/O 矩阵「向量路异常」行）', () => {
  /** 只让向量路语句抛错的连接代理：关键词路原样放行到真库。 */
  function vectorFailingConnection(reason: string): lbug.Connection {
    return {
      async prepare(statement: string) {
        if (statement.includes('QUERY_VECTOR_INDEX')) throw new Error(reason)
        return store.connection.prepare(statement)
      },
      async execute(prepared: unknown, params: unknown) {
        return store.connection.execute(
          prepared as Parameters<typeof store.connection.execute>[0],
          params as Parameters<typeof store.connection.execute>[1],
        )
      },
    } as unknown as lbug.Connection
  }

  it('向量路抛错 ⇒ 降级关键词单路（degraded:true）且 FTS 命中不丢；vectorError 带出原因', async () => {
    const result = await recall({
      query: 'alpha',
      queryVector: A,
      connection: vectorFailingConnection('vector extension not loaded'),
    })
    expect(result.degraded).toBe(true)
    expect(result.hint).toContain('降级')
    expect(result.vectorError).toContain('vector extension not loaded')
    // 关键词路独立预算：本可用的 FTS 命中一条不少（F-01 的核心诉求）。
    const baseline = await recall({ query: 'alpha', queryVector: null })
    expect(result.total).toBe(baseline.total)
    const ids = new Set(result.results.map((item) => item.id))
    expect(ids.has(nid('alpha recall l1 secondary'))).toBe(true)
  })

  it('无向量 + 向量路失败时仍是正常成功值（vectorError 缺省：本路没失败）', async () => {
    const result = await recall({ query: 'alpha', queryVector: null })
    expect(result.degraded).toBe(true)
    expect(result.vectorError).toBeUndefined()
  })

  it('两路都失败才抛：任何一路可用都绝不丢命中', async () => {
    // 关键词路也一并抛错 ⇒ 没有任何可返回结果，原样抛（工具面收敛失败信封）。
    const allFailing = {
      async prepare() {
        throw new Error('prepare failed')
      },
    } as unknown as lbug.Connection
    await expect(
      recall({ query: 'alpha', queryVector: A, connection: allFailing }),
    ).rejects.toThrow('prepare failed')
  })
})


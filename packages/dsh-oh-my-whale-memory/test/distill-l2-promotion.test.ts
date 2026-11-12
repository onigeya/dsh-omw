/**
 * L1→L2 提升与忠实性门的集成钉（Story 2.5 / epics.md:710-755、裁决 U3/U7/U14/U15）。
 *
 * 只有在这一层才看得见的三件事：
 * 1. 三项外部信号的**执行序**——判据①③ 写前（失败即根本不写库）、判据② 写事务内（不过则
 *    连候选带边一起回滚）；
 * 2. 两类失败的分野——调用失败抛 InboxRefineError（条目不标 done、候选留队列重试），判定失败
 *    正常结束（丢弃候选 + 来源 L1 标 gate-fail）；
 * 3. LLM 判定只标注不丢弃（faithful=false ⇒ outcome='uncertain'，节点照常落库）。
 *
 * 真库 dim=4、单库共享（LadybugDB 每进程约 15 个实例封顶，本文件只开 1 次库）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { checkReachableToL0 } from '../src/db/eii'
import { writeEvidenceEdges } from '../src/db/edges'
import { memoryNodeId } from '../src/db/id'
import { queryAll } from '../src/db/memory'
import { l2InboxQueue, type InboxItem } from '../src/inbox/queue'
import { InboxRefineError } from '../src/inbox/consumer'
import { WRITE_EVIDENCE_SKIPPED_ACTION } from '../src/db/audit'
import { EMBEDDING_FAILED_REASON, SEMANTIC_SCAN_DEGRADED_REASON } from '../src/distill/processor'
import {
  L2_INBOX_KIND,
  L2_LAYER,
  buildL2PromotionItemId,
  createL2PromotionProcessor,
} from '../src/distill/promotion'
import {
  createSystemOneClient,
  type SystemOneClient,
  type SystemOneRuntimeState,
} from '../src/distill/system-one'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const NOW = new Date('2026-11-11T00:00:00.000Z')
const ROUTE = { provider: 'test-provider', model: 'test-model' }
const NOW_ISO = NOW.toISOString()

/**
 * 注入点：
 * - 'drop-l2' ⇒ 丢掉终点为 L2 的边（模拟判据② 无法成立）；
 * - 'skip-l2' ⇒ 边照写，但**回报一条 skipped**（评审 P14① T19：edges.skipped>0 的降级审计分支
 *   在真库里需要端点缺失/层序错误才可达，端到端造不稳定，故在返回值上补一条）。
 */
const edgeState = vi.hoisted(() => ({ mode: 'real' as 'real' | 'drop-l2' | 'skip-l2' }))
vi.mock('../src/db/edges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/edges')>()
  return {
    ...actual,
    writeEvidenceEdges: async (connection: never, entries: readonly { toLayer?: string; fromId?: string; toId?: string }[]) => {
      const kept = edgeState.mode === 'drop-l2' ? entries.filter((e) => e.toLayer !== 'L2') : entries
      const result = await actual.writeEvidenceEdges(connection, kept as never)
      if (edgeState.mode !== 'skip-l2') return result
      const first = entries[0]
      return {
        ...result,
        skipped: [...result.skipped, { reason: 'layer-order', fromId: String(first?.fromId ?? ''), toId: String(first?.toId ?? '') }],
      }
    },
  }
})

/** 评审 P14①（T13）：语义去重扫描失败的降级重试（真实 ANN 索引损坏难造 ⇒ 在首调注入）。 */
const dedupState = vi.hoisted(() => ({ scanErrors: 0 }))
vi.mock('../src/db/dedup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/dedup')>()
  return {
    ...actual,
    writeDeduplicatedMemory: async (connection: never, input: never, options: never) => {
      if (dedupState.scanErrors > 0) {
        dedupState.scanErrors -= 1
        throw new actual.SemanticScanError(new Error('Index contains an invalid node offset'))
      }
      return actual.writeDeduplicatedMemory(connection, input, options)
    },
  }
})

let store: MemoryDatabase
let seq = 0

beforeAll(async () => {
  const dir = await makeTempDir('omw-l2promo-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: 'test-embed' })
})

afterAll(async () => {
  try { await store?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

beforeEach(async () => {
  edgeState.mode = 'real'
  dedupState.scanErrors = 0
  // 评审 P18（T44）：判据① 的分级取决于证据回填游标。默认清成「未回填」；
  // 需要终局丢弃的用例自行置 'done'（共享单库 ⇒ 每次必须显式复位）。
  await setEvidenceCursor('')
})

/** 直接改 omw_meta 的证据回填游标（P18 分级用）。 */
async function setEvidenceCursor(value: string): Promise<void> {
  await store.connection.query(
    "MERGE (m:omw_meta {key: 'evidence_backfill_cursor'}) ON CREATE SET m.value = '" + value +
    "' ON MATCH SET m.value = '" + value + "'",
  )
}

/** 假客户端的运行态：评审 P19 后 `runtimeState()` 是接口的一部分（judgeStatement 会先读它）。 */
const IDLE_RUNTIME: SystemOneRuntimeState = {
  enabled: true,
  degraded: false,
  since: null,
  consecutiveFailures: 0,
  lastReason: null,
}

const delta = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text }) as StreamChunk
const finish = (reason: unknown): StreamChunk => ({ type: 'finish', reason }) as StreamChunk

/** 假 llm：按消息文本分流——含「忠实」的走核实 schema，否则走 L2 综合 schema。 */
function makeLlm(options: { readonly refine?: string; readonly verify?: string } = {}) {
  const calls: string[] = []
  const refine = options.refine ?? JSON.stringify({ text: 'L2 综合陈述', kind: 'work_fact', priority: 9 })
  const verify = options.verify ?? JSON.stringify({ faithful: true, conflict: false, reason: null })
  const llm = {
    stream(input: { readonly messages: readonly { readonly content: unknown }[] }) {
      const text = input.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .map((block: { readonly type?: string; readonly text?: string }) => (block.type === 'text' ? String(block.text) : ''))
        .join('')
      calls.push(text)
      const body = text.includes('忠实') ? verify : refine
      return (async function* generate() {
        yield delta(body)
        yield finish({ kind: 'stop' })
      })()
    },
  }
  return { llm: llm as never, calls }
}

/** 造一组 L1：一条 l0_raw + 一条 L1 节点 + L0→L1 的 EVIDENCE 边（判据① 可达）。 */
async function seedL1(
  tag: string,
  options: {
    readonly withEdge?: boolean
    readonly sourceRefs?: string[]
    /** 评审 P14③（T21）：把来源 L0 写成 redact 墓碑（raw_text IS NULL）⇒ 判据① 失败。 */
    readonly tombstoneL0?: boolean
    /** 评审 P14③（T25）：valid_at 走在 NOW 之后 ⇒ checkReachableToL0 判 'not-effective'。 */
    readonly futureValidAt?: boolean
    readonly kind?: string
    readonly priority?: number
  } = {},
) {
  const l0 = 'l0-' + tag + '-' + String(seq++)
  const l1 = 'l1-' + tag + '-' + String(seq++)
  const refs = options.sourceRefs ?? [l0]
  const rawText = options.tombstoneL0 === true ? 'NULL' : "'原文 " + tag + "'"
  const validAt = options.futureValidAt === true ? '2027-01-01T00:00:00.000Z' : NOW_ISO
  await store.connection.query(
    "CREATE (l:l0_raw {id: '" + l0 + "', raw_text: " + rawText + ", recorded_at: '" + NOW_ISO + "', actor: 'system'})",
  )
  await store.connection.query(
    "CREATE (m:memory {id: '" + l1 + "', layer: 'L1', kind: '" + (options.kind ?? 'work_fact') + "', priority: " +
    String(options.priority ?? 3) + ", text: 'L1 事实 " + tag +
    "', valid_at: '" + validAt + "', recorded_at: '" + NOW_ISO + "', source_refs: [" +
    refs.map((ref) => "'" + ref + "'").join(', ') + ']})',
  )
  if (options.withEdge !== false) {
    await writeEvidenceEdges(store.connection, [
      { fromId: l0, fromLayer: 'L0', toId: l1, toLayer: 'L1', reason: 'refine' },
    ])
  }
  return { l0, l1 }
}

/** 入队并取一条 l2_inbox 条目（确定性 id ⇒ 同一条 L1 只入队一次）。 */
async function claimL2(l1Id: string, payload?: string): Promise<InboxItem> {
  const id = buildL2PromotionItemId(l1Id)
  await l2InboxQueue.enqueue(store.connection, {
    id,
    payload: payload ?? JSON.stringify({ l1Ids: [l1Id] }),
    kind: L2_INBOX_KIND,
    sessionId: 'sess-l2',
    now: NOW,
  })
  const item = await l2InboxQueue.claimNext(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== id) throw new Error('夹具取不到自己的队头：' + id)
  return item
}

/** 评审 P14④（T26）：同一来源 L1 需要第二个条目时，id 由调用方给（默认 id 是内容确定的）。 */
async function claimL2As(l1Id: string, itemId: string): Promise<InboxItem> {
  await l2InboxQueue.enqueue(store.connection, {
    id: itemId,
    payload: JSON.stringify({ l1Ids: [l1Id] }),
    kind: L2_INBOX_KIND,
    sessionId: 'sess-l2',
    now: NOW,
  })
  const item = await l2InboxQueue.claimNext(store.connection, { owner: 'test-owner', now: NOW })
  if (!item || item.id !== itemId) throw new Error('夹具取不到自己的队头：' + itemId)
  return item
}

function processor(overrides: Parameters<typeof createL2PromotionProcessor>[0] extends never ? never : Partial<Parameters<typeof createL2PromotionProcessor>[0]> = {}) {
  return createL2PromotionProcessor({
    connection: () => store.connection,
    llm: makeLlm().llm,
    resolveRoute: () => ROUTE,
    now: () => NOW,
    ...overrides,
  })
}

async function memoryRows(id: string) {
  return queryAll(store.connection, "MATCH (m:memory) WHERE m.id = '" + id + "' RETURN m.layer AS layer, m.kind AS kind, m.priority AS priority, m.support AS support, m.source_refs AS refs, m.text AS text")
}

async function l2ByText(text: string) {
  const rows = await queryAll(store.connection, "MATCH (m:memory) WHERE m.layer = '" + L2_LAYER + "' AND m.text = '" + text + "' RETURN m.id AS id, m.kind AS kind, m.priority AS priority, m.support AS support")
  return rows[0] ?? null
}

async function audits(action: string, ref: string) {
  return queryAll(
    store.connection,
    "MATCH (g:generation_log) WHERE g.action = '" + action + "' AND '" + ref + "' IN g.l0_refs " +
    'RETURN g.reason AS reason, g.outcome AS outcome, g.question_key AS qk, g.probability AS p, g.threshold AS t, g.passed AS passed',
  )
}

async function statusOf(id: string) {
  const rows = await queryAll(store.connection, "MATCH (q:l2_inbox) WHERE q.id = '" + id + "' RETURN q.status AS status")
  return rows[0] === undefined ? null : String(rows[0].status)
}

const systemOnePassing = (faithful: number, noConflict: number): SystemOneClient => ({
  runtimeState: () => IDLE_RUNTIME,
  async judge() { return { ok: true, answers: { faithful, 'no-conflict': noConflict } } },
})
const systemOneFailing = (reason: string): SystemOneClient => ({
  runtimeState: () => IDLE_RUNTIME,
  async judge() { return { ok: false, reason, message: 'boom' } },
})

describe('成功路径（AC:723-734）', () => {
  it('L2 落库 + 继承来源 kind/priority + 同事务 EVIDENCE 边 + 判据② 通过 + 审计带四列', async () => {
    const { l1 } = await seedL1('ok')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 ok-' + String(seq++)
    const { llm, calls } = makeLlm({ refine: JSON.stringify({ text: statement, kind: '不采信', priority: 99 }) })
    const run = processor({ llm, systemOne: systemOnePassing(0.9, 0.8) })

    const result = await run(item)
    expect(result).toEqual({ completed: true, kinds: [] })
    // 一次综合 + 一次核实（System One 走 HTTP，不计入 llm.calls）。
    expect(calls).toHaveLength(1)

    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    const l2Id = String(l2!.id)
    // kind/priority 从来源 L1 继承（不采信模型给的 99）。
    expect(l2).toMatchObject({ kind: 'work_fact', priority: 3, support: 1 })
    expect(String((await memoryRows(l2Id))[0]!.refs)).toContain(l1)

    const edges = await queryAll(
      store.connection,
      "MATCH (a:memory {id: '" + l1 + "'})-[e:EVIDENCE]->(b:memory {id: '" + l2Id + "'}) RETURN e.reason AS reason",
    )
    expect(edges).toHaveLength(1)
    expect(edges[0]!.reason).toBe('promote')
    expect((await checkReachableToL0(store.connection, l2Id, NOW_ISO)).pass).toBe(true)

    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows).toHaveLength(1)
    // 最弱那项是 no-conflict(0.8) ⇒ question_key/probability 记它；threshold 是插件侧常量。
    expect(rows[0]).toMatchObject({ outcome: 'success', qk: 'no-conflict', t: 0.5, passed: true })
    expect(Number(rows[0]!.p)).toBeCloseTo(0.8, 5)
  })
})

describe('LLM 判定只标注、不丢弃（AC:662）', () => {
  it('faithful 低于阈值 ⇒ outcome=uncertain，节点照常落库且被 gate-fail 无关', async () => {
    const { l1 } = await seedL1('flag')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 flag-' + String(seq++)
    const run = processor({
      llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm,
      systemOne: systemOnePassing(0.2, 0.9),
    })

    await run(item)
    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]).toMatchObject({ outcome: 'uncertain', passed: false })
    // 只标注，绝不标 gate-fail。
    expect(await audits('gate_fail', l1)).toHaveLength(0)
  })

  it('运行态已降级 ⇒ 整体回落 ctx.llm 单次检查（question_key=ctx-llm）', async () => {
    const { l1 } = await seedL1('degrade')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 degrade-' + String(seq++)
    const { llm, calls } = makeLlm({ refine: JSON.stringify({ text: statement }) })
    // 真客户端 + 必失败的 fetch。降级阈值是 3，故先造 2 次失败；
    // 本候选的这次调用正好是第 3 次 ⇒ 本次即把运行态推进到降级 ⇒ 回落 ctx.llm。
    const failing = createSystemOneClient({
      fetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    const probe = new AbortController().signal
    await failing.judge('s', { faithful: { type: 'noul', instructions: 'x' } }, probe)
    await failing.judge('s', { faithful: { type: 'noul', instructions: 'x' } }, probe)
    const run = processor({ llm, systemOne: failing })

    await run(item)
    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    // 综合 + 核实两次 llm 调用。
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('忠实')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]).toMatchObject({ outcome: 'success', qk: 'ctx-llm' })
  })
})

describe('判据①③ 写前失败 ⇒ 丢弃候选（AC:742-745）', () => {
  it('判据①（L0 引用不可达）⇒ 不写 L2、条目标 done、来源 L1 标 gate-fail、不调 LLM', async () => {
    // 有 L1 节点但**没有** L0→L1 的 EVIDENCE 边 ⇒ checkReachableToL0 失败。
    // 评审 P18（T44）：no-evidence-edge 在「证据回填已跑完」之前是**暂时**的 ⇒ 这里把游标
    // 钉成 'done'，才轮到终局丢弃（暂时那一支另有一条用例）。
    await setEvidenceCursor('done')
    const { l1 } = await seedL1('unreach', { withEdge: false })
    const item = await claimL2(l1)
    const { llm, calls } = makeLlm({ refine: JSON.stringify({ text: '不该被写 ' + String(seq++) }) })
    const run = processor({ llm })

    await run(item)
    expect(calls).toHaveLength(0)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outcome).toBe('failure')
    expect(String(rows[0]!.reason)).toMatch(/no-valid-path-to-l0|no-evidence-edge/)
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })

  // 评审 P18（T44）主路径：2.6 边表之前的 L1 没有边，而回填按 recorded_at ASC 每轮 ≤50，
  // 可能还没跑到它。此时候选**改期重试**（不标 gate-fail、不丢），等回填补上边再提升。
  it('判据① 遇 no-evidence-edge 且回填未跑完 ⇒ 抛 InboxRefineError(fatal:false)、不标 gate-fail', async () => {
    await setEvidenceCursor('2026-11-10T00:00:00.000Z|l1-x')
    const { l1 } = await seedL1('pending-edge', { withEdge: false })
    const item = await claimL2(l1)
    const { llm, calls } = makeLlm({ refine: JSON.stringify({ text: '不该被写 ' + String(seq++) }) })
    const run = processor({ llm })

    await expect(run(item)).rejects.toBeInstanceOf(InboxRefineError)
    expect(calls).toHaveLength(0)
    // 条目留在 processing，交给消费者 failInboxItem 退避重试。
    expect(await statusOf(item.id)).toBe('processing')
    const rows = await audits('l2_promotion', l1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outcome).toBe('uncertain')
    expect(String(rows[0]!.reason)).toContain('no-evidence-edge')
    expect(await audits('gate_fail', l1)).toHaveLength(0)
  })

  // 评审 P18③：source_refs 为空的来源没有「等回填」的余地（它永远不会有边）⇒ 仍然终局丢弃。
  it('判据① 遇 no-evidence-edge 但来源 source_refs 为空 ⇒ 不等待回填、直接丢弃', async () => {
    const { l0, l1 } = await seedL1('no-refs', { withEdge: false })
    await store.connection.query("MATCH (m:memory {id: '" + l1 + "'}) SET m.source_refs = []")
    const item = await claimL2(l1)
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]!.outcome).toBe('failure')
    expect(await audits('gate_fail', l1)).toHaveLength(1)
    void l0
  })

  it('判据③（存活 L0 计数为 0）⇒ 丢弃且 reason=support-below-1', async () => {
    // 边在（判据① 过）但 source_refs 为空 ⇒ support=0。
    const { l1 } = await seedL1('nosupport', { sourceRefs: [] })
    const item = await claimL2(l1)
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]).toMatchObject({ outcome: 'failure' })
    expect(String(rows[0]!.reason)).toContain('support-below-1')
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })
})

describe('判据② 写事务内失败 ⇒ T1 回滚 + T2 账目（U15）', () => {
  it('L1→L2 边缺失使判据② 不成立 ⇒ 候选与边一起消失、条目标 done、来源 L1 标 gate-fail', async () => {
    const { l1 } = await seedL1('rollback')
    const item = await claimL2(l1)
    const statement = 'L2 候选 rollback-' + String(seq++)
    edgeState.mode = 'drop-l2'
    const run = processor({ llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm })

    await run(item)
    // 候选整体回滚：节点不存在，也没有指向它的边。
    expect(await l2ByText(statement)).toBeNull()
    // 节点与指向它的边都必须随 T1 一起回滚（库是共享的 ⇒ 必须按这条候选的 id 精确断言）。
    const candidateId = memoryNodeId(L2_LAYER, statement)
    const leaked = await queryAll(
      store.connection,
      "MATCH (a:memory)-[e:EVIDENCE]->(b:memory {id: '" + candidateId + "'}) RETURN count(e) AS total",
    )
    expect(Number(leaked[0]!.total)).toBe(0)
    expect(await memoryRows(candidateId)).toHaveLength(0)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]!.outcome).toBe('failure')
    expect(String(rows[0]!.reason)).toContain('no-')
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })
})

describe('调用失败 ≠ 判定失败（AD-15 / brief §3.5）', () => {
  it('System One 调用失败且未降级 ⇒ 抛 InboxRefineError、条目不标 done、候选留队列', async () => {
    const { l1 } = await seedL1('callfail')
    const item = await claimL2(l1)
    const statement = 'L2 候选 callfail-' + String(seq++)
    const run = processor({
      llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm,
      systemOne: systemOneFailing('http-503'),
    })

    await expect(run(item)).rejects.toBeInstanceOf(InboxRefineError)
    expect(await l2ByText(statement)).toBeNull()
    expect(await statusOf(item.id)).toBe('processing')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]).toMatchObject({ outcome: 'uncertain' })
    expect(String(rows[0]!.reason)).toBe('http-503')
    // 调用失败绝不标 gate-fail（那是判定失败的记号）。
    expect(await audits('gate_fail', l1)).toHaveLength(0)
  })

  it('路由解析失败 ⇒ 抛 InboxRefineError(no-provider-route)、条目不标 done', async () => {
    const { l1 } = await seedL1('noroute')
    const item = await claimL2(l1)
    const run = processor({ resolveRoute: () => null })

    await expect(run(item)).rejects.toBeInstanceOf(InboxRefineError)
    expect(await statusOf(item.id)).toBe('processing')
    const rows = await audits('l2_promotion', l1)
    expect(String(rows[0]!.reason)).toBe('no-provider-route')
  })
})

describe('payload 与来源校验（丢弃而非重试）', () => {
  it('payload 非法 ⇒ 标 done + bad-payload（无可信来源 ⇒ 不标 gate-fail）', async () => {
    const { l1 } = await seedL1('badpayload')
    const item = await claimL2(l1, 'not-json')
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', item.id)
    expect(String(rows[0]!.reason)).toBe('bad-payload')
    expect(await audits('gate_fail', l1)).toHaveLength(0)
  })

  it('来源 L1 不存在 ⇒ 丢弃 + source-not-found + 该 id 标 gate-fail', async () => {
    const missing = 'l1-missing-' + String(seq++)
    const item = await claimL2(missing)
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', missing)
    expect(String(rows[0]!.reason)).toBe('source-not-found')
    expect(await audits('gate_fail', missing)).toHaveLength(1)
  })
})

describe('评审 P14：降级审计与重试分支（T13/T19/T21/T24/T25/T26）', () => {
  /** 假 embedding 客户端：按脚本回答。 */
  const embedFailing = {
    async embed() { return { ok: false as const, reason: 'http-500', message: 'embed boom' } },
  }

  it('① 语义去重扫描失败 ⇒ 换指纹路径重跑 writeL2，并补一条 scan-degraded 审计', async () => {
    const { l1 } = await seedL1('scanfail')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 scanfail-' + String(seq++)
    dedupState.scanErrors = 1
    const run = processor({ llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm })

    await run(item)
    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.outcome).sort()).toEqual(['success', 'uncertain'])
    const degraded = rows.find((row) => String(row.reason).startsWith('semantic-scan-degraded'))
    expect(degraded).toBeDefined()
  })

  it('② 来源 L0 是 redact 墓碑 ⇒ not-effective/no-valid-path 一类判据① 失败、终局丢弃', async () => {
    const { l1 } = await seedL1('tombstone', { tombstoneL0: true })
    const item = await claimL2(l1)
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]!.outcome).toBe('failure')
    expect(String(rows[0]!.reason)).toMatch(/no-valid-path-to-l0|l0-tombstone|no-evidence-edge/)
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })

  it('③ 来源 L1 的 valid_at 走在 now 之后 ⇒ 判据① 判 not-effective、终局丢弃', async () => {
    const { l1 } = await seedL1('future', { futureValidAt: true })
    const item = await claimL2(l1)
    const run = processor({})

    await run(item)
    expect(await statusOf(item.id)).toBe('done')
    const rows = await audits('l2_promotion', l1)
    expect(String(rows[0]!.reason)).toContain('not-effective')
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })

  it('④ 模型输出不是 JSON ⇒ refineToL2 ok:false、抛 InboxRefineError、条目不标 done', async () => {
    const { l1 } = await seedL1('badjson')
    const item = await claimL2(l1)
    const run = processor({ llm: makeLlm({ refine: '这不是 JSON' }).llm })

    await expect(run(item)).rejects.toBeInstanceOf(InboxRefineError)
    expect(await statusOf(item.id)).toBe('processing')
    const rows = await audits('l2_promotion', l1)
    expect(rows[0]!.outcome).toBe('uncertain')
    expect(String(rows[0]!.reason)).toContain('json-parse-failed')
    expect(await audits('gate_fail', l1)).toHaveLength(0)
  })

  it('⑤ 写时嵌入失败 ⇒ L2 照常落库 + embedding-failed 审计（三列留空）', async () => {
    const { l1 } = await seedL1('embedfail')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 embedfail-' + String(seq++)
    const run = processor({
      llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm,
      embedding: embedFailing as never,
      embeddingModel: 'test-embed',
    })

    await run(item)
    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    const details = await queryAll(
      store.connection,
      "MATCH (m:memory) WHERE m.id = '" + String(l2!.id) + "' RETURN m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim",
    )
    expect(details[0]!.embedding).toBeNull()
    expect(details[0]!.model_id).toBeNull()
    expect(details[0]!.dim).toBeNull()
    const rows = await audits('l2_promotion', l1)
    expect(rows.some((row) => String(row.reason).startsWith('embedding-failed'))).toBe(true)
  })

  it('⑦ EVIDENCE 边被跳过 ⇒ 补一条 write_evidence_skipped 审计（但仍成功落库）', async () => {
    const { l1 } = await seedL1('skipedge')
    const item = await claimL2(l1)
    const statement = 'L2 综合陈述 skipedge-' + String(seq++)
    edgeState.mode = 'skip-l2'
    const run = processor({ llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm })

    await run(item)
    expect(await l2ByText(statement)).not.toBeNull()
    const rows = await queryAll(
      store.connection,
      "MATCH (g:generation_log) WHERE g.action = '" + WRITE_EVIDENCE_SKIPPED_ACTION + "' AND '" + l1 +
      "' IN g.l0_refs RETURN g.outcome AS outcome, g.reason AS reason",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'uncertain' })
    expect(String(rows[0]!.reason)).toContain('skipped=1')
  })

  it('⑧ gate-fail 幂等：同一来源 L1 被两个条目判失败，只留一条 gate_fail 账', async () => {
    await setEvidenceCursor('done')
    const { l1 } = await seedL1('idem', { withEdge: false })
    const run = processor({})

    await run(await claimL2As(l1, 'l2-idem-1'))
    await run(await claimL2As(l1, 'l2-idem-2'))
    expect(await audits('gate_fail', l1)).toHaveLength(1)
  })

  it('⑥ 多来源：support 取并集、kind 取主流、priority 取最大、边逐来源写', async () => {
    const a = await seedL1('multi-a', { kind: 'persona', priority: 9 })
    const b = await seedL1('multi-b', { kind: 'persona', priority: 2 })
    const l1Ids = [a.l1, b.l1]
    const item = await claimL2(a.l1, JSON.stringify({ l1Ids }))
    const statement = 'L2 综合陈述 multi-' + String(seq++)
    const run = processor({ llm: makeLlm({ refine: JSON.stringify({ text: statement }) }).llm })

    await run(item)
    const l2 = await l2ByText(statement)
    expect(l2).not.toBeNull()
    expect(l2).toMatchObject({ kind: 'persona', priority: 9, support: 2 })
    const refs = String((await memoryRows(String(l2!.id)))[0]!.refs)
    expect(refs).toContain(a.l1)
    expect(refs).toContain(b.l1)
    const edges = await queryAll(
      store.connection,
      "MATCH (x:memory)-[e:EVIDENCE]->(y:memory {id: '" + String(l2!.id) + "'}) RETURN count(e) AS total",
    )
    expect(Number(edges[0]!.total)).toBe(2)
    await l2InboxQueue.complete(store.connection, item.id, { now: NOW })
  })
})

describe('as-most-once 守卫', () => {
  it('条目已 done ⇒ 直接返回，不写任何产出', async () => {
    const { l1 } = await seedL1('guard')
    const item = await claimL2(l1)
    await l2InboxQueue.complete(store.connection, item.id, { now: NOW })

    const before = await queryAll(store.connection, "MATCH (m:memory) WHERE m.layer = 'L2' RETURN count(m) AS total")
    const run = processor({})
    expect(await run(item)).toEqual({ completed: true, kinds: [] })
    const after = await queryAll(store.connection, "MATCH (m:memory) WHERE m.layer = 'L2' RETURN count(m) AS total")
    expect(Number(after[0]!.total)).toBe(Number(before[0]!.total))
  })
})

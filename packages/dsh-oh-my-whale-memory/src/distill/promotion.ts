/**
 * L1→L2 提升处理器（Story 2.5 / FR-5、epics.md:710-755）。
 *
 * 一次 process = 一个 l2_inbox 条目 = **一条**源 L1 → 一条 L2 候选（裁决 U3）：
 * 「多条 L1 → 一条 L2」的批量语义由调度方拆成多个条目，这样单次尝试仍在 30s 内完成、
 * lease 60s 依然有效（不引入续租 API）。
 *
 * 质量门（AC:728-734）的执行序（brief §2.3）：
 * - **写前**：判据① 逐引用可达性（checkRefReachableToL0，2.6 原语）+ 判据③ support 计数
 *   （存活 l0_raw 并集去重计数）。两项只读既有节点，失败即根本不写。
 * - **写事务 T1 内**：写 L2 候选（去重原语）→ 写 L1→L2 的 EVIDENCE 边（U15）→
 *   **同事务内**跑判据② checkReachableToL0(candidateId)。不过 ⇒ 抛 L2GateFailure 让 T1
 *   整体回滚（候选与边一起消失 = epics.md:667「丢弃候选」的原子实现）。
 * - **T2（另开事务）**：写候选失败账目 + 每个来源 L1 一条 gate-fail 标注行 + 标 done。
 *
 * 两类失败必须分开（brief §3.5，本文件最容易写错的地方）：
 * - **调用失败**（System One / ctx.llm 网络、5xx、超时、响应畸形）⇒ 抛 InboxRefineError，
 *   交给消费者 failInboxItem（attempts+1 → 退避；第 4 次进死信）。**绝不**标 done：
 *   候选绝不会被静默丢弃（AD-15「调用失败 ≠ 判定失败」）。
 * - **判定失败**（三项外部信号任一不通过）⇒ **不是异常**：丢弃候选 + 来源 L1 标 gate-fail
 *   + outcome='failure' + 标 done（v1 不重试，AC:742-745）。
 * - LLM 的判定**只标注、不丢弃**（AC:662）：faithful=false / conflict=true 只把 outcome
 *   写成 'uncertain'，节点照常落库。
 *
 * 不新增 schema：gate-fail 的连接键是 uuid5 内容键（裁决 U7），核实结果进 generation_log
 * 既有的 question_key / probability / threshold / passed 四列（FR-8，不新增表）。
 */
import type * as lbug from '@ladybugdb/core'
import {
  GATE_FAIL_ACTION,
  L2_PROMOTION_ACTION,
  L2_PROMOTION_POLICY,
  REFINE_KIND,
  WRITE_EVIDENCE_SKIPPED_ACTION,
  buildGateFailLogId,
  insertGenerationLog,
  type GenerationLogOutcome,
} from '../db/audit.js'
import { SemanticScanError, writeDeduplicatedMemory } from '../db/dedup.js'
import { writeEvidenceEdges } from '../db/edges.js'
import { checkReachableToL0, checkRefReachableToL0 } from '../db/eii.js'
import { uuid5 } from '../db/id.js'
import { getMemoryById, type MemoryDetail } from '../db/memory.js'
import { collectRows } from '../db/rows.js'
import { GENERATION_LOG_TABLE, L0_RAW_TABLE } from '../db/schema.js'
import { runInTransaction } from '../db/transaction.js'
import type { EmbedClient } from '../embedding/client.js'
import { InboxRefineError, type InboxProcessResult } from '../inbox/consumer.js'
import { l2InboxQueue, type InboxItem } from '../inbox/queue.js'
import { MEMORY_REMEMBER_LAYER } from '../tools/memory-remember.js'
import type { LlmPort, RefineRoute } from './llm-refine.js'
import { refineToL2, verifyL2Statement, type L2SourceFact } from './l2-refine.js'
import {
  EMBEDDING_FAILED_REASON,
  SEMANTIC_SCAN_DEGRADED_REASON,
  embedTexts,
  isProcessableStatus,
} from './processor.js'
import { SYSTEMONE_NOUL_THRESHOLD, systemOneRuntimeState, type SystemOneClient } from './system-one.js'

/** L2 记忆层值（层枚举只有 L1/L2；L2_INBOX 是**表名**，不是 layer 取值）。 */
export const L2_LAYER = 'L2'

/** l2_inbox 条目的 kind 标签（与 l1_inbox 的来源标签 step|turn|compaction 区分开）。 */
export const L2_INBOX_KIND = 'l2-promotion'

/** 单次 process 的硬上界（与 L1 精炼同一预算，R2「一次尝试 ≤30s」）。 */
export const L2_PROMOTION_TIMEOUT_MS = 30_000

/** LLM 子预算（与 2.3 口径一致：总 30s 里留给 embedding 10s）。 */
export const L2_PROMOTION_LLM_TIMEOUT_MS = 20_000

/**
 * L2 慢循环的轮询间隔（AC:721「以慢循环低频运行，不与 L1 消费者争资源」）：
 * L1 消费者保持 1s 主路径节律，L2 用 30s 慢节律 + claimGuard 给 L1 让路。
 */
export const L2_PROMOTION_INTERVAL_MS = 30_000

/** 丢弃候选时落在来源 L1 身上的标注前缀（AC:745：把来源 L1 标 gate-fail 于 generation log）。 */
export const GATE_FAIL_REASON_PREFIX = 'gate-fail'

/** 写前判据（外部信号①②③）的失败理由，写进审计 reason（Story 7.2 按 outcome 过滤）。 */
export const L2_GATE_REASONS = {
  badPayload: 'bad-payload',
  sourceNotFound: 'source-not-found',
  supportBelowOne: 'support-below-1',
} as const

/** System One 两个 question key（同一 questions 对象里的两项 = 不增加调用轮次，AC:738）。 */
export const SYSTEMONE_FAITHFUL_KEY = 'faithful'
export const SYSTEMONE_CONFLICT_KEY = 'no-conflict'

/**
 * l2_inbox 条目 id（确定性内容键，与决策 U7 的 buildGateFailLogId 同一惯用法）。
 *
 * 同一条 L1 的重复触发算出同一 id；MERGE ON CREATE 只建一次、**不覆盖**既有行的
 * status/attempts ⇒ 已提升或已丢弃过的 L1 不会被重新入队，崩溃重放也不产重条目（AC「v1 不重试」）。
 */
export function buildL2PromotionItemId(l1Id: string): string {
  return uuid5('omw:l2-promote:' + l1Id)
}

/** l2_inbox 条目的 payload 形态。 */
export interface L2PromotionPayload {
  /** 本次要综合的直接前驱 L1 节点 id（v1 只放一条；格式已兼容多条）。 */
  readonly l1Ids: readonly string[]
}

/** 解析 payload；非法一律返回 null（调用方按「丢弃 + 标 done」处理，不做无意义重试）。 */
export function parseL2PromotionPayload(payload: string): readonly string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = Array.isArray(parsed) ? parsed : (parsed as { readonly l1Ids?: unknown }).l1Ids
  if (!Array.isArray(raw) || raw.length === 0) return null
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) return null
    ids.push(item.trim())
  }
  return [...new Set(ids)]
}

/**
 * 判据② 不通过时的信号：让 T1 整体回滚（候选与边一起消失），再由 T2 另开事务写账目。
 * 它是**判定失败**（不是异常），故外壳把它当正常分支处理，绝不抛给消费者当失败重试。
 */
class L2GateFailure extends Error {
  readonly reasons: readonly string[]

  constructor(reasons: readonly string[]) {
    super('L2 结构校验不通过：' + reasons.join('+'))
    this.name = 'L2GateFailure'
    this.reasons = reasons
  }
}

/** 存活 L0 计数：UNWIND 后 MATCH 会丢掉未命中的 ref，故命中数即存活数（并集已去重）。 */
const LIVE_L0_COUNT_STATEMENT = [
  'UNWIND $refs AS ref',
  'MATCH (l:' + L0_RAW_TABLE + ' {id: ref})',
  'WHERE l.raw_text IS NOT NULL',
  'RETURN count(DISTINCT l.id) AS live',
].join('\n')

/** gate-fail 行存在性点查（确定性 id ⇒ O(1) 幂等，崩溃重放不撞主键）。 */
const GATE_FAIL_EXISTS_STATEMENT =
  'MATCH (g:' + GENERATION_LOG_TABLE + ' {id: $id}) RETURN g.id AS id'

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue> = {},
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/**
 * 判据③ support：候选 source_refs[] 在 L0 命中且非墓碑的条数（U16 口径）。
 * L2 的 ref 是直接前驱 L1 ⇒ 取各 L1 的 source_refs（L0 id 集）并集去重后计数（brief §2.4）。
 */
async function countSupport(
  connection: lbug.Connection,
  sources: readonly MemoryDetail[],
): Promise<number> {
  const refs = [...new Set(sources.flatMap((node) => node.sourceRefs.map(String)))]
  if (refs.length === 0) return 0
  const rows = await queryRows(connection, LIVE_L0_COUNT_STATEMENT, { refs })
  return Number(rows[0]?.live ?? 0)
}

/** 来源 L1 的 kind 主流值（并列取先达到者，裁决 U11）；无来源时回落到 L2 自身判定。 */
function dominantKind(sources: readonly MemoryDetail[]): string {
  const counts = new Map<string, number>()
  for (const node of sources) {
    const kind = node.kind
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  let best = ''
  let bestCount = -1
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind
      bestCount = count
    }
  }
  return best
}

/** 来源 L1 的最大 priority（AC:725「priority 取来源最大值」）。 */
function maxPriority(sources: readonly MemoryDetail[]): number {
  let best = Number.NEGATIVE_INFINITY
  for (const node of sources) best = Math.max(best, Number(node.priority ?? 0))
  return Number.isFinite(best) ? best : 0
}

/** 写一行提升 / 门禁审计（不开事务：事务边界由调用方决定，与 2.3 同一纪律）。 */
async function insertL2Audit(
  connection: lbug.Connection,
  refs: readonly string[],
  action: string,
  outcome: GenerationLogOutcome,
  reason: string,
  now: () => Date,
  extra: { readonly questionKey?: string | null, readonly probability?: number | null, readonly threshold?: number | null, readonly passed?: boolean | null } = {},
): Promise<string> {
  return insertGenerationLog(connection, {
    recordedAt: now().toISOString(),
    actor: 'system',
    kind: REFINE_KIND,
    action,
    policy: L2_PROMOTION_POLICY,
    l0Refs: [...refs],
    outcome,
    reason,
    questionKey: extra.questionKey ?? null,
    probability: extra.probability ?? null,
    threshold: extra.threshold ?? null,
    passed: extra.passed ?? null,
  })
}

/**
 * 给来源 L1 落一条 gate-fail 标注行（AC:745）。行 id 是确定性内容键，故先点查存在性再 CREATE
 * ——generation_log 的主键是 id，重复 CREATE 会撞键并让整个事务回滚（append-only，不能 UPsert）。
 * 标注**不改变 L1 的可召回性**（L1 仍有效，只是被标注）。
 */
async function markGateFail(
  connection: lbug.Connection,
  l1Id: string,
  reason: string,
  now: () => Date,
): Promise<void> {
  const id = buildGateFailLogId(l1Id)
  const existing = await queryRows(connection, GATE_FAIL_EXISTS_STATEMENT, { id })
  if (existing.length > 0) return
  await insertGenerationLog(connection, {
    id,
    recordedAt: now().toISOString(),
    actor: 'system',
    kind: REFINE_KIND,
    action: GATE_FAIL_ACTION,
    outcome: 'failure',
    reason: GATE_FAIL_REASON_PREFIX + ': ' + reason,
    l0Refs: [l1Id],
  })
}

/** 一次 LLM 核实的标注结果（只进审计列，不参与丢弃决策）。 */
interface L2Verdict {
  readonly outcome: GenerationLogOutcome
  readonly reason: string
  readonly questionKey: string | null
  readonly probability: number | null
  readonly threshold: number | null
  readonly passed: boolean | null
}

/** System One 判定的 state 文本（陈述 + 来源，同一 questions 对象判两项）。 */
function buildJudgeState(statement: string, facts: readonly L2SourceFact[]): string {
  const sources = facts.map((fact, index) => '[' + String(index + 1) + '] ' + fact.text).join('\n')
  return 'L2 陈述：\n' + statement + '\n\n来源 L1：\n' + sources
}

const PASSED_VERDICT_REASON = 'llm-passed'
const FLAGGED_VERDICT_REASON = 'llm-flagged'

export interface L2PromotionDeps {
  /** 惰性取连接（与两个消费者同一 accessor）。 */
  readonly connection: () => lbug.Connection | null
  /** 宿主 LLM 单通道（apply 期间不得求值，N2）。 */
  readonly llm: LlmPort
  /** 路由解析：Config 优先，缺省从 session 已记录请求目标解析；null ⇒ 不调 LLM（N5）。 */
  readonly resolveRoute: (sessionId: string) => RefineRoute | null
  /**
   * System One 客户端；null = 配置态关闭（systemOne.enabled=false）。
   * 非 null 时仍可能在运行态降级（连续失败达阈值）⇒ 那条候选整体回落 ctx.llm 单次检查。
   */
  readonly systemOne?: SystemOneClient | null
  readonly embedding?: EmbedClient | null
  readonly embeddingModel?: string | null
  readonly embeddingModelId?: string | null
  readonly timeoutMs?: number
  readonly llmTimeoutMs?: number
  readonly now?: () => Date
  readonly logger?: { warn(message: string): void }
}

/**
 * 忠实性核实（AC:736-740 / AD-15）：System One 优先；配置态关闭或运行态降级时整体回落
 * ctx.llm **单次**检查。返回的只是**标注**（不参与丢弃决策）。
 *
 * **调用失败一律抛 InboxRefineError**（AD-15「调用失败 ≠ 判定失败」）⇒ 消费者 failInboxItem
 * 退避重试、候选留在队列里。唯一例外是「本次失败恰好把运行态推进到降级阈值」：那一次按
 * AC:674 整体降级回 ctx.llm，不再抛（否则永远走不到降级分支）。
 */
async function judgeStatement(
  deps: L2PromotionDeps,
  input: {
    readonly statement: string
    readonly facts: readonly L2SourceFact[]
    readonly route: RefineRoute
    readonly signal: AbortSignal
  },
): Promise<L2Verdict> {
  const threshold = SYSTEMONE_NOUL_THRESHOLD
  const client = deps.systemOne ?? null
  if (client !== null) {
    const result = await client.judge(
      buildJudgeState(input.statement, input.facts),
      {
        [SYSTEMONE_FAITHFUL_KEY]: {
          type: 'noul',
          instructions: '该陈述是否完全由给出的来源 L1 支撑（没有臆造、夸大或超出来源的因果）？返回 1 表示完全支撑，0 表示不支撑。',
        },
        [SYSTEMONE_CONFLICT_KEY]: {
          type: 'noul',
          instructions: '该陈述是否与来源 L1 互相矛盾、或与来源中已成立的事实不相容？返回 1 表示不冲突，0 表示冲突。',
        },
      },
      input.signal,
    )
    if (result.ok) {
      const faithful = result.answers[SYSTEMONE_FAITHFUL_KEY] ?? Number.NaN
      const noConflict = result.answers[SYSTEMONE_CONFLICT_KEY] ?? Number.NaN
      const passed = Number.isFinite(faithful) && Number.isFinite(noConflict) &&
        faithful >= threshold && noConflict >= threshold
      const weakestKey = faithful <= noConflict ? SYSTEMONE_FAITHFUL_KEY : SYSTEMONE_CONFLICT_KEY
      const weakest = Math.min(faithful, noConflict)
      return {
        outcome: passed ? 'success' : 'uncertain',
        reason: (passed ? PASSED_VERDICT_REASON : FLAGGED_VERDICT_REASON) +
          ' faithful=' + String(faithful) + ' no-conflict=' + String(noConflict),
        questionKey: weakestKey,
        probability: weakest,
        threshold,
        passed,
      }
    }
    const runtime = systemOneRuntimeState()
    if (!runtime.degraded) {
      throw new InboxRefineError(
        'System One 核实调用失败（' + result.reason + '）：' + result.message,
        { reason: result.reason, fatal: false },
      )
    }
    deps.logger?.warn(
      'System One 运行态降级（连续失败 ' + String(runtime.consecutiveFailures) + ' 次，since=' +
      String(runtime.since) + '），本次改走 ctx.llm 单次检查：' + result.reason,
    )
  }
  const verified = await verifyL2Statement({
    llm: deps.llm,
    route: input.route,
    statement: input.statement,
    facts: input.facts,
    signal: input.signal,
  })
  if (!verified.ok) {
    throw new InboxRefineError(
      'ctx.llm 忠实性检查失败（' + verified.failure.reason + '）：' + verified.failure.message,
      { reason: verified.failure.reason, fatal: !verified.failure.retryable },
    )
  }
  const passed = verified.faithful && !verified.conflict
  return {
    outcome: passed ? 'success' : 'uncertain',
    reason: (passed ? PASSED_VERDICT_REASON : FLAGGED_VERDICT_REASON) +
      ' faithful=' + String(verified.faithful) + ' conflict=' + String(verified.conflict) +
      (verified.reason.length > 0 ? '（' + verified.reason + '）' : ''),
    questionKey: 'ctx-llm',
    probability: null,
    threshold: null,
    passed,
  }
}

/** 调用失败时的失败审计：**另开事务**（调用方事务可能已回滚），且**不**标 done。 */
async function recordPromotionFailure(
  connection: lbug.Connection,
  refs: readonly string[],
  failure: { readonly reason: string, readonly retryable: boolean },
  now: () => Date,
): Promise<void> {
  await runInTransaction(connection, () =>
    insertL2Audit(
      connection,
      refs,
      L2_PROMOTION_ACTION,
      failure.retryable ? 'uncertain' : 'failure',
      failure.reason,
      now,
    ),
  )
}

/**
 * 丢弃候选（外部信号不通过，AC:742-745）：一个事务里标 done + 写候选失败行 +
 * 给每个来源 L1 落 gate-fail 标注行。v1 **不重试**（条目已 done，确定性入队 id 也不会重新入队）。
 */
async function discardCandidate(
  connection: lbug.Connection,
  item: InboxItem,
  /** 审计行的 l0_refs（向下证据引用）：来源 L1 的 id 集。 */
  refs: readonly string[],
  /** 要标 gate-fail 的**来源 L1** id 集；payload 非法等情形传空（没有可信的来源）。 */
  gateFailIds: readonly string[],
  reasons: readonly string[],
  now: () => Date,
): Promise<void> {
  const reason = reasons.length > 0 ? reasons.join('+') : GATE_FAIL_REASON_PREFIX
  await runInTransaction(connection, async () => {
    await l2InboxQueue.markDone(connection, item.id, { now: now() })
    await insertL2Audit(connection, refs.length > 0 ? refs : [item.id], L2_PROMOTION_ACTION, 'failure', reason, now)
    for (const l1Id of gateFailIds) {
      await markGateFail(connection, l1Id, reasons[0] ?? reason, now)
    }
  })
}

/**
 * 组装 L1→L2 提升处理器：交给第二个 {@link createInboxConsumer}（绑 l2_inbox）注入。
 * 返回的处理器已完成全部队列记账；调用方无需再包装。
 */
export function createL2PromotionProcessor(
  deps: L2PromotionDeps,
): (item: InboxItem) => Promise<InboxProcessResult> {
  const now = deps.now ?? (() => new Date())
  const timeoutMs = deps.timeoutMs ?? L2_PROMOTION_TIMEOUT_MS
  const llmTimeoutMs = deps.llmTimeoutMs ?? L2_PROMOTION_LLM_TIMEOUT_MS

  return async (item: InboxItem): Promise<InboxProcessResult> => {
    const connection = deps.connection()
    if (!connection) throw new Error('L2 提升时数据库连接不可用（id=' + item.id + '）')

    // ⓪ 入口状态守卫（与 2.3 同一纪律）：只有还「待处理」的条目才值得干活。
    const status = await l2InboxQueue.readStatus(connection, item.id)
    if (!isProcessableStatus(status)) return { completed: true, kinds: [] }

    const l1Ids = parseL2PromotionPayload(item.payload)
    if (l1Ids === null) {
      await discardCandidate(connection, item, [], [], [L2_GATE_REASONS.badPayload], now)
      return { completed: true, kinds: [] }
    }

    // 来源 L1 必须存在且**是 L1 层**；否则这次提升没有语义基础。
    const sources: MemoryDetail[] = []
    for (const l1Id of l1Ids) {
      const node = await getMemoryById(connection, l1Id)
      if (node === null || node.layer !== MEMORY_REMEMBER_LAYER) {
        await discardCandidate(connection, item, l1Ids, l1Ids, [L2_GATE_REASONS.sourceNotFound], now)
        return { completed: true, kinds: [] }
      }
      sources.push(node)
    }

    const nowIso = now().toISOString()

    // 判据①（写前，AC:730）：候选 source_refs[] 的每个引用都能回溯到非墓碑 L0。
    // L2 的 ref 是直接前驱 L1 ⇒ 委派 checkReachableToL0（2.6 原语，U4 口径）。
    const refFailures: string[] = []
    for (const node of sources) {
      const reach = await checkRefReachableToL0(connection, node.id, nowIso)
      if (!reach.pass) refFailures.push(...reach.failingReasons)
    }
    if (refFailures.length > 0) {
      await discardCandidate(connection, item, l1Ids, l1Ids, refFailures, now)
      return { completed: true, kinds: [] }
    }

    // 判据③（写前，AC:733）：support = 来源 L1 各自存活 L0 集的并集去重计数，必须 ≥1。
    const support = await countSupport(connection, sources)
    if (support < 1) {
      await discardCandidate(connection, item, l1Ids, l1Ids, [L2_GATE_REASONS.supportBelowOne], now)
      return { completed: true, kinds: [] }
    }

    // ① 路由闸门（N5）：解析失败直接降级、不调 LLM；按失败路径记账（队列重试）。
    const route = deps.resolveRoute(item.sessionId)
    if (!route) {
      const failure = { reason: 'no-provider-route', retryable: true }
      await recordPromotionFailure(connection, l1Ids, failure, now)
      throw new InboxRefineError(
        '未解析到可用的 provider/model 路由（session=' + item.sessionId + '）',
        { reason: failure.reason, fatal: false },
      )
    }

    const signal = AbortSignal.timeout(timeoutMs)
    const llmSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, llmTimeoutMs))])

    const facts: L2SourceFact[] = sources.map((node) => ({ id: node.id, text: node.text, kind: node.kind }))
    const refined = await refineToL2({ llm: deps.llm, route, facts, signal: llmSignal })
    if (!refined.ok) {
      await recordPromotionFailure(connection, l1Ids, refined.failure, now)
      throw new InboxRefineError(
        'L2 综合失败（' + refined.failure.reason + '）：' + refined.failure.message,
        { reason: refined.failure.reason, fatal: !refined.failure.retryable },
      )
    }
    const statement = refined.statement.text

    // 写时嵌入在写事务**之前**（AC:755：L2 与 L1 同规则）。失败不阻塞 L2 写入。
    const embedded = await embedTexts(deps.embedding, deps.embeddingModel, [statement], signal)
    const vector = embedded.vectors[0] ?? null
    if (embedded.failure) {
      deps.logger?.warn(
        'L2 写时嵌入失败（id=' + item.id + '，reason=' + embedded.failure.reason + '）：' +
        embedded.failure.message + '——L2 照常写入，embedding 三列留空',
      )
    }

    // 忠实性核实：只标注、不丢弃；调用失败即抛（候选留队列重试）。
    const verdict = await judgeStatement(deps, { statement, facts, route, signal: llmSignal })

    // kind / priority 按 AC:723-726 从来源 L1 **继承**（不采信模型自己的分类）：
    // kind = 来源主流值（并列取先达到者，U11）、priority = 来源最大值。
    const kind = dominantKind(sources)
    const priority = maxPriority(sources)

    let marked = false
    let gateReasons: readonly string[] | null = null
    let scanDegraded: string | null = null

    const writeL2 = async (skipSemanticScan: boolean): Promise<void> => {
      marked = false
      await runInTransaction(connection, async () => {
        marked = await l2InboxQueue.markDone(connection, item.id, { now: now() })
        if (!marked) return
        const written = await writeDeduplicatedMemory(
          connection,
          {
            layer: L2_LAYER,
            text: statement,
            embedding: vector,
            embeddingModelId: vector ? (deps.embeddingModelId ?? null) : null,
            kind,
            priority,
            sourceRefs: [...l1Ids],
            support,
            actor: 'system',
          },
          { now, logger: deps.logger, scanFailure: 'throw', skipSemanticScan },
        )
        // U15：EVIDENCE 边必须与 L2 节点**同事务**写入（不得依赖 backfill 兜底）。
        const edges = await writeEvidenceEdges(
          connection,
          sources.map((node) => ({
            fromId: node.id,
            fromLayer: MEMORY_REMEMBER_LAYER,
            toId: written.id,
            toLayer: L2_LAYER,
            reason: 'promote',
          })),
        )
        // 判据②（同事务内，AC:731）：候选存在至少一条有效且可达的向下路径直到 L0。
        // 不通过 ⇒ 抛出使整个 T1 回滚（候选与边一起消失）。
        const reach = await checkReachableToL0(connection, written.id, now().toISOString())
        if (!reach.pass) throw new L2GateFailure(reach.failingReasons)
        await insertL2Audit(
          connection,
          [...l1Ids, written.id],
          L2_PROMOTION_ACTION,
          verdict.outcome,
          verdict.reason,
          now,
          {
            questionKey: verdict.questionKey,
            probability: verdict.probability,
            threshold: verdict.threshold,
            passed: verdict.passed,
          },
        )
        if (edges.skipped.length > 0) {
          await insertL2Audit(
            connection,
            [...l1Ids, written.id],
            WRITE_EVIDENCE_SKIPPED_ACTION,
            'uncertain',
            'skipped=' + String(edges.skipped.length),
            now,
          )
        }
        if (embedded.failure) {
          await insertL2Audit(
            connection,
            [...l1Ids, written.id],
            L2_PROMOTION_ACTION,
            'uncertain',
            EMBEDDING_FAILED_REASON + ': ' + embedded.failure.reason,
            now,
          )
        }
        if (scanDegraded !== null) {
          await insertL2Audit(
            connection,
            [...l1Ids, written.id],
            L2_PROMOTION_ACTION,
            'uncertain',
            SEMANTIC_SCAN_DEGRADED_REASON + ': ' + scanDegraded,
            now,
          )
        }
      })
    }

    try {
      await writeL2(false)
    } catch (error) {
      if (error instanceof L2GateFailure) {
        gateReasons = error.reasons
      } else if (error instanceof SemanticScanError) {
        // 语义去重不可用（索引失效 / 扩展未装载）：首轮已整体回滚，换一条不碰 ANN 的路重跑。
        scanDegraded = error.message
        deps.logger?.warn('L2 语义去重降级为指纹路径（id=' + item.id + '）：' + error.message)
        try {
          await writeL2(true)
        } catch (retry) {
          if (retry instanceof L2GateFailure) gateReasons = retry.reasons
          else throw retry
        }
      } else {
        throw error
      }
    }

    // 判据② 不通过：丢弃候选 + 标 gate-fail（T2 另开事务，AC:742-745）。
    if (gateReasons !== null) {
      await discardCandidate(connection, item, l1Ids, l1Ids, gateReasons, now)
      return { completed: true, kinds: [] }
    }
    // marked=false：条目已被处理过（at-most-once 命中），本次不写任何产出。
    if (!marked) return { completed: true, kinds: [] }
    // L2 不产生 L1，故不回报 kinds（提升计数只统计 L1，见 consumer 的 recordL1）。
    return { completed: true, kinds: [] }
  }
}

/**
 * 命令面的数据访问装配（Story 1.7–1.9 / 3.1 / 3.2）。
 *
 * 全部是惰性依赖：命令在 profileContext 早退之前注册，闭包到 handler 被调用时才读库句柄。
 * 库未就绪时抛明确错误，由命令层收敛成 `{kind:'error'}`，不静默返回空列表/0 计数。
 * 本单元不做任何注册，只把读/写依赖与 status 快照组装成纯函数对象。
 */
import type { MemoryDatabase } from '../db/database.js'
import { createReadonlyModeError, memoryDatabaseBackendKind } from '../db/database.js'
import { computeAuditGap, countPointerAudits, countUncertainAudits } from '../db/audit.js'
import { computeEvidenceGap } from '../db/eii.js'
import { collectHealthMetrics } from '../db/health.js'
import { forgetMemory as forgetMemoryInDb } from '../db/forget.js'
import { countPendingDecisions, listPendingDecisions, resolvePendingDecision as resolvePendingDecisionInDb } from '../db/pending.js'
import { slowQueueStats } from '../strategy/slow-queue.js'
import { expireStrategyCandidates, strategyStats } from '../strategy/candidates.js'
import { readCompactionStatus, type AttributionSnapshot } from '../context/status.js'
import { compactionModeLabel, resolveCompactionMode } from '../context/compaction-delegate.js'
import type { MemoryContextLedgerView, MemoryReflectionView } from '../command.js'
import { countOntologyDrops } from '../ontology/ledger.js'
import { countEvidenceDegraded } from '../db/redact.js'
import { readDeclaredSchemaVersion } from '../db/migrate.js'
import { TARGET_SCHEMA_VERSION } from '../db/migrations.js'
import {
  countMemoriesByLayer,
  countUnembeddedMemories,
  getMemoryById as readMemoryById,
  listMemories as readMemories,
} from '../db/memory.js'
import {
  INBOX_FAILED_VIEW_LIMIT,
  countInboxByStatus,
  l2InboxQueue,
  listRecentFailedInboxItems,
} from '../inbox/queue.js'
import { MEMORY_REMEMBER_LAYER } from '../tools/memory-remember.js'
import { countRelatedSkips } from '../wiki/relations.js'
import type { MemoryCommandDependencies, MemoryInboxWriteOptions } from '../command.js'
import type { RuntimeConfig } from '../config.js'
import type { InjectionStore } from '../injection/state.js'
import type { SystemOneClient } from '../distill/system-one.js'
import { PERSONA_SPEC, PERSONA_SPEC_APPROVED, personaStatusOf } from '../persona/spec.js'
import { countsByState } from '../persona/self-knowledge.js'

export interface MemoryAccessOptions {
  /** Story 7.2：反思触发状态提供者（缺省 ⇒ status 不渲染 reflection 行）。 */
  readonly reflectionView?: () => MemoryReflectionView
  /** Story 8.1：归因账本快照提供者（缺省 ⇒ 渲染 `n/a（本实例尚未采集）`）。 */
  readonly contextLedgerView?: () => AttributionSnapshot | null
  /** Story 10.1：采集模式提供者（缺省 ⇒ 不渲染 capture_trigger 行）。 */
  readonly captureModeView?: () => { readonly trigger: string, readonly persistence: string } | null
  /** 惰性取库句柄（建库之前为 undefined）。 */
  readonly getDb: () => MemoryDatabase | undefined
  /** apply 时 resolve 的配置（status 的 embeddingMode 与 System One 开关）。 */
  readonly resolved: RuntimeConfig
  /** 本实例自身的只读态（模块级 runtimeState 可能属于另一次 apply，不能读它）。 */
  readonly readonlyState: () => { readonly readonly: boolean; readonly reason?: string }
  readonly getSystemOneClient: () => SystemOneClient | null
  /** Story 3.3：注入观测摘要（进程内；`readLastInjection()` 为 null=未知）。 */
  readonly injectionStore: InjectionStore
}

export interface MemoryAccess {
  /** 库未就绪时 throw（命令层收敛为 error 结果）。 */
  readonly readConnection: () => MemoryDatabase
  readonly writeInbox: MemoryCommandDependencies['writeInbox']
  readonly listMemories: MemoryCommandDependencies['listMemories']
  readonly getMemoryById: MemoryCommandDependencies['getMemoryById']
  readonly getStatus: MemoryCommandDependencies['getStatus']
  /** Story 4.1：软删除 + EII 定序级联（写路径，只读实例必须先拒）。 */
  readonly forgetMemory: MemoryCommandDependencies['forgetMemory']
  /** Story 7.1：裁决待裁决冲突（写路径，只读实例先拒）。 */
  readonly resolvePendingDecision: MemoryCommandDependencies['resolvePendingDecision']
  /** Story 7.3：策略候选区与采纳门计数（只读可查；过期扫描只在非只读实例执行）。 */
  readonly getStrategyStats: MemoryCommandDependencies['getStrategyStats']
}

/** 库未就绪的统一文案：写入与读取各一句，逐字保留命令层既有输出。 */
const DB_NOT_READY_WRITE = '记忆库未就绪：无 profile 归属或建库未完成，当前无法写入 L1'
const DB_NOT_READY_READ = '记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆'

/**
 * Story 11.4 / T5：库声明版本与本插件目标版本不一致时的可见差异。
 *
 * 只读实例**不迁移**（AD-12），旧 schema 仍可打开并读；`schema_version_mismatch` 因此必须
 * 在 status 里可见，而不是把旧库当成当前版本。版本一致 ⇒ 返回 undefined（不追加行）。
 * 版本值非法（库损坏/跨版本写坏）按「未知」报出，不让 status 整体失败。
 */
async function readSchemaVersionMismatch(
  database: MemoryDatabase,
): Promise<{ readonly actual: string | null; readonly expected: string } | undefined> {
  const expected = String(TARGET_SCHEMA_VERSION)
  let actual: number | null
  try {
    actual = await readDeclaredSchemaVersion(database.connection, database.dbPath)
  } catch {
    return { actual: null, expected }
  }
  if (actual === TARGET_SCHEMA_VERSION) return undefined
  return { actual: actual === null ? null : String(actual), expected }
}

export function createMemoryAccess(options: MemoryAccessOptions): MemoryAccess {
  const readConnection = (): MemoryDatabase => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_READ)
    return database
  }

  // Story 1.11（AC2/AC3）：INBOX 采集写路径。层收敛为唯一枚举，写 `L1`
  // （= MEMORY_REMEMBER_LAYER），`L1_INBOX` 从此只是 INBOX 队列标识/表名，不是 memory.layer 取值。
  // 可选分类旗标（kind / priority，含 -1）透传到落库，与 memory_remember 同一条写路径。
  const writeInbox = async (text: string, writeOptions?: MemoryInboxWriteOptions): Promise<void> => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    // 三列 embedding/embedding_model_id/embedding_dim 同落 NULL（不写零向量污染 HNSW cosine 索引）。
    await database.upsertMemory({
      layer: MEMORY_REMEMBER_LAYER,
      text,
      kind: writeOptions?.kind,
      priority: writeOptions?.priority,
      embedding: null,
      embeddingModelId: null,
      actor: 'user',
    })
  }

  const listMemories: MemoryAccess['listMemories'] = (input) =>
    readMemories(readConnection().connection, input)
  const getMemoryById: MemoryAccess['getMemoryById'] = (id) =>
    readMemoryById(readConnection().connection, id)

  // Story 4.1：忘却是写路径。库未就绪与 `writeInbox` 同一句文案；只读实例的拒绝复用 facade
  // 的 `readonly_mode` 错误（同一句话，不新造），命令层 catch 后收敛成 error 结果。
  // Story 4.2：`--redact` 透传成库层的 `{ redact: { actor: 'user' } }`（AC:1050 只允许 user）。
  const forgetMemory: MemoryAccess['forgetMemory'] = async (id, forgetOptions) => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    if (database.readonly) throw createReadonlyModeError(database.dbPath)
    return forgetMemoryInDb(
      database.connection,
      id,
      forgetOptions?.redact === true ? { redact: { actor: 'user' } } : {},
    )
  }

  // Story 7.1：裁决同样是写路径（与 forget 同一只读守卫与同一句文案）。
  const resolvePendingDecision: MemoryAccess['resolvePendingDecision'] = async (id, resolution) => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    if (database.readonly) throw createReadonlyModeError(database.dbPath)
    return resolvePendingDecisionInDb(database.connection, id, resolution)
  }

  // Story 1.9：只读层计数 + 本实例运行态（readonly/reason）+ 配置态（apply 时 resolve 的
  // embeddingMode）。纯读、无 LLM / 网络；库未就绪经 readConnection() 抛错，由命令层收敛。
  const getStatus: MemoryAccess['getStatus'] = async () => {
    const connection = readConnection().connection
    const counts = await countMemoriesByLayer(connection)
    const auditGap = await computeAuditGap(connection)
    // Story 2.2 / AC4：failed 换成 l1_inbox 的真实计数；有条目才读明细（最近 5 条 + stale），
    // 无失败时不追加任何行，status 既有输出逐字不变。队列表缺失照抛（可见错误，不静默报 0）。
    const unembedded = await countUnembeddedMemories(connection)
    // Story 2.6 / F2：边侧差额（EII 违例 + 边↔source_refs 漂移）与关系降级计数。
    // computeEvidenceGap 在边表缺失时返回 null（渲染成未知，不静默报 0）。
    const now = new Date().toISOString()
    const evidenceGap = await computeEvidenceGap(connection, now)
    const relatedSkipped = await countRelatedSkips(connection)
    const inboxCounts = await countInboxByStatus(connection)
    // Story 10.2：指针化采集/精炼的两个可见计数（审计 action 计数；表缺失 = null ⇒ 渲染未知）。
    const pointerAudits = await countPointerAudits(connection)
    // Story 2.5 / U1：L2_INBOX 行从「memory.layer 的历史计数槽」换成 l2_inbox 的真实队列深度
    // （pending + processing = 待提升条目；done/failed 不计入，failed 另有 failed 行）。
    const l2InboxCounts = await l2InboxQueue.countByStatus(connection)
    const failedEntries = inboxCounts.failed > 0
      ? await listRecentFailedInboxItems(connection, { limit: INBOX_FAILED_VIEW_LIMIT })
      : []
    const readonlyState = options.readonlyState()
    return {
      layers: { L1: counts.L1, L2: counts.L2 },
      inboxes: {
        L1: counts.L1_INBOX,
        L2: l2InboxCounts.pending + l2InboxCounts.processing,
      },
      failed: inboxCounts.failed,
      failedEntries,
      embeddingMode: options.resolved.embeddingMode,
      // Story 2.5 / U6 + 评审 P19：配置态优先（enabled=false ⇒ 不构造客户端），
      // 否则读本实例客户端的运行态（端点持续不可达 ⇒ degraded）。
      systemOne: !options.resolved.systemOne.enabled
        ? 'disabled-by-config'
        : (options.getSystemOneClient()?.runtimeState().degraded === true ? 'degraded' : 'enabled'),
      unembedded,
      readonly: readonlyState.readonly,
      readonlyReason: readonlyState.reason,
      auditGap,
      evidenceGap,
      relatedSkipped,
      // Story 4.2 / D-5：证据被授权抹除的有效记忆数（0 不渲染；列缺失 = null 渲染「未知」）。
      evidenceDegraded: await countEvidenceDegraded(connection, now),
      // Story 2.5 / 评审 P8：L2 死信（T8：此前 l2InboxCounts.failed 被整个丢弃 ⇒ L2 死信
      // 在 status 完全不可见）与疑似失效账目（T27：U14 只有写侧、没有读取出口）。
      l2Failed: l2InboxCounts.failed,
      l2FailedEntries: l2InboxCounts.failed > 0
        ? await l2InboxQueue.listRecentFailed(connection, { limit: INBOX_FAILED_VIEW_LIMIT })
        : [],
      // Story 3.3 / B4：注入可见性，进程内 lastInjection（null=未知）+ Config 开关。
      injection: options.injectionStore.readLastInjection() ?? null,
      injectionEnabled: options.resolved.injectOnNewSession,
      // Story 11.2 / T5：Persona Spec 状态（配置开关 + 批准门 + 空正文判据的同一纯函数结果）。
      // null = 未启用 / 未批准 / 空正文 ⇒ status 渲染 disabled(awaiting-approval)。
      persona: personaStatusOf({
        enabled: options.resolved.personaSpecEnabled,
        approved: PERSONA_SPEC_APPROVED,
        spec: PERSONA_SPEC,
      }),
      // Story 4.3：健康指标（积压 / 最近精炼完成）。collectHealthMetrics 自身对每个采集点
      // best-effort，异常与超预算都收敛成该点 `n/a`，绝不让 status 失败（AC:1105-1107）。
      health: await collectHealthMetrics({ connection }),
      // Story 7.1 / D-4：待裁决冲突（条数 + 最新 5 条清单）；表缺失时 count 为 null = 未知。
      pendingConflicts: await countPendingDecisions(connection),
      pendingConflictEntries: await listPendingDecisions(connection, { limit: 5 }),
      // Story 7.2：慢路径队列统计（表缺失时返回全 0，不阻塞 status）。
      slowQueue: await slowQueueStats(connection).catch(() => null),
      reflection: options.reflectionView?.() ?? null,
      // Story 7.3：策略采纳门（AC:1494/1498）；缺表时全 0，不阻塞 status。
      strategyGate: await getStrategyStats().catch(() => null),
      // Story 11.3 / T6：Self-Knowledge 三态计数 + record-only（审计面，不含正文）。
      // 缺表（旧库只读、未迁移 0011）⇒ null = 渲染「未知」，与 auditGap / strategyGate 同一约定。
      selfKnowledge: await countsByState(connection).catch(() => null),
      // Story 9.1 / T7：本体闸门行。off 恒打印 off；只读实例与缺表都渲染 n/a（不静默报 0）。
      ontology: await (async () => {
        const level = options.resolved.ontologyGate.level
        if (level === 'off') return { level, drops: null }
        if (readonlyState.readonly) return { level, drops: null, unavailableReason: '只读实例' }
        const drops = await countOntologyDrops(connection)
        return drops === null ? { level, drops: null } : { level, drops }
      })(),
      // Story 8.1：上下文归因（进程内快照）与压缩运行（落库）。
      contextLedger: mapContextLedger(options.contextLedgerView?.() ?? null),
      compaction: await readCompactionStatus(connection)
        .then((status) => ({
          runs: status.compactionRuns,
          lastCompactionId: status.lastCompaction?.compactionId ?? null,
          lastStartedAt: status.lastCompaction?.startedAt ?? null,
          // Story 8.3 / AC:1683：只读实例的引擎委托 stock（零写），status 必须显式标出来。
          // 写者实例暂不渲染（我们的引擎尚未装配，写 'own' 会是不诚实的）。
          ...(readConnection().readonly
            ? { mode: compactionModeLabel(resolveCompactionMode({ readonly: true, engineInstalled: true })) }
            : {}),
        }))
        .catch(() => null),
      // Story 10.1：采集模式（tokens / steps(degraded)；指针持久化不可用时显式可见）。
      // Story 10.2：同一行块里带指针解析/超限三计数（trigger 即 capture_trigger 行）。
      capture: (() => {
        const view = options.captureModeView?.() ?? null
        return view === null ? null : { ...view, ...pointerAudits }
      })(),
      // Story 5.1 / AC:1171：存储后端可见（native = 纯 Node，wasm = Electron 宿主，AD-32）。
      backend: memoryDatabaseBackendKind(readConnection().dbPath),
      // Story 11.4 / T5：只读实例打开未迁移旧 schema 时，`schema_version_mismatch` 必须可见。
      // 版本一致时不返回该字段（既有逐行输出逐字不变）；读取失败（版本值非法）也按「未知」报出，
      // 不让 status 因一个元数据列整体失败。
      schemaVersionMismatch: await readSchemaVersionMismatch(readConnection()),
      uncertain: await countUncertainAudits(connection),
    }
  }

  /**
   * Story 7.3：候选区计数。先做一次过期扫描（只读实例跳过，因为它是写动作），再统计；
   * 表缺失（旧库未迁移）时返回全 0 而不是抛错 —— status / 命令面不该因缺表整体失败。
   */
  const getStrategyStats: MemoryAccess['getStrategyStats'] = async () => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    if (!database.readonly) {
      await expireStrategyCandidates(database.connection, new Date().toISOString()).catch(() => 0)
    }
    const stats = await strategyStats(database.connection).catch(() => null)
    const gate = options.resolved.strategyGate
    return {
      candidates: stats?.candidates ?? 0,
      pending: stats?.pending ?? 0,
      adopted: stats?.adopted ?? 0,
      rejected: stats?.rejected ?? 0,
      expired: stats?.expired ?? 0,
      noEvidence: stats?.noEvidence ?? 0,
      minConfidence: gate.minConfidence,
      expiryDays: gate.expiryDays,
      maxPendingPerSession: gate.maxPendingPerSession,
    }
  }

  /** 把归因快照摊平成命令层的扁平视图（避开跨层类型依赖）。 */
  const mapContextLedger = (snapshot: AttributionSnapshot | null): MemoryContextLedgerView | null => {    if (snapshot === null) return null
    return {
      system: snapshot.ledger.bySource.system,
      user: snapshot.ledger.bySource.user,
      tool: snapshot.ledger.bySource.tool,
      assistant: snapshot.ledger.bySource.assistant,
      unknown: snapshot.ledger.bySource.unknown,
      total: snapshot.ledger.totalTokens,
      capturedAt: snapshot.capturedAt,
      indexedSeqs: snapshot.indexedSeqs,
    }
  }

  return {
    readConnection,
    writeInbox,
    listMemories,
    getMemoryById,
    getStatus,
    forgetMemory,
    resolvePendingDecision,
    getStrategyStats,
  }
}

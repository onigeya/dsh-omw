/**
 * dsh-oh-my-whale-memory function 插件入口。
 *
 * 命名导出形态由 PRD §14 / postmortem 0001 锁定：Loader 只识别 `name`/`inject`/`Config`/`apply`，
 * default export 会让 Loader 丢弃 function 插件命名空间，本文件禁用 default export。
 *
 * P1-R11：apply 的接线按域搬进 `src/wire/`（access/retrieval/commands/tools/lifecycle/capture/
 * distill/inbox/events + 共享槽 runtime），本文件只留导出、配置解析、依赖构造与 wire 调用。
 * 每个 wire 调用单独隔离，一个单元失败只告警；成功路径的注册顺序、日志与 disposer 数逐字不变。
 *
 * 接线约束：
 * - Story 1.3：inject 含 `'settings'`（AD-11），Config 填全字段（FR-18），apply 分级校验；
 * - Story 1.4/1.5：profile 专属路径建库、embedding 维度 pin、写者锁先定角色再开库（AD-12/AD-14：
 *   LadybugDB 只要有只读句柄，之后同文件读写打开必失败 Error: 33）；
 * - Story 1.6/1.7：工具与命令在 profileContext 早退之前无条件注册，库未就绪时给明确错误；
 * - Story 2.1/2.2：采集钩子与两条 INBOX 消费链，回收挂既有 db effect（closer 数不变）；
 * - Story 3.1/3.2：召回配额按会话键计数，`turn/start` 与 `turn/end` 双点重置。
 *
 * apply 收到的 config 是宿主按 Config schema resolve 出的 volatile 节点对象；resolveRuntimeConfig
 * 用 Getter<T> 读取，兼容普通值与 volatile 节点（便于纯单测传 plain object）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveRuntimeConfig } from './config.js'
import { resolveEmbeddingProfile } from './db/embedding-profile.js'
import { resolveMemoryDbPath, ensureMemoryDbDirectory } from './db/paths.js'
import { openMemoryDatabase, type MemoryDatabase } from './db/database.js'
import { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
import { createIdleGate } from './inbox/idle-gate.js'
import { createMemoryAccess } from './wire/access.js'
import { createReflectionState, readReflectionView, recordTurn } from './reflection/state.js'
import { createReflectionExecutor } from './reflection/executor.js'
import { createCompactionWiring } from './context/compaction-wiring.js'
import { detectCompactionOverlayGap, compactionOverlayGapWarning } from './context/compaction-gap.js'
import { registerHandleWriter, setCompactionReadonly } from './context/handle-writer.js'
import { createAttributionTap, type TokenMeterLike } from './context/attribution-tap.js'
import { writeHandle } from './context/handles.js'
import { foldStream } from './shared/stream-fold.js'
import { queryRows } from './db/rows.js'
import { auditWriter } from './db/audit.js'
import { createRetrievalWiring } from './wire/retrieval.js'
import { wireMemoryCommand } from './wire/commands.js'
import { wireMemoryTools } from './wire/tools.js'
import { wireInjection } from './wire/injection.js'
import { createInjectionStore } from './injection/state.js'
import { wireMemoryLifecycle } from './wire/lifecycle.js'
import { wireCapture } from './wire/capture.js'
import { createDistillWiring } from './wire/distill.js'
import { createPromotionWiring, reclaimInboxOnStartup, startInboxConsumers } from './wire/inbox.js'
import { wireSessionEvents, wireTurnEndCapture } from './wire/events.js'
import { createMemoryRuntimeSlots } from './wire/runtime.js'

export { Config, resolveRuntimeConfig } from './config.js'
export type { RuntimeConfig, ConfigShape } from './config.js'
export { MemoryDbError } from './db/errors.js'
export type { MemoryDbErrorCode } from './db/errors.js'
export { memoryNodeId, normalizeFingerprintText } from './db/id.js'
export { resolveMemoryDbPath } from './db/paths.js'
export { openMemoryDatabase } from './db/database.js'
export type { MemoryDatabase, OpenMemoryDatabaseOptions } from './db/database.js'
export type { UpsertMemoryInput, UpsertMemoryResult } from './db/memory.js'
export { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
export type { MemoryWriterLock } from './db/writer-lock.js'
export {
  MEMORY_COMMAND_NAME,
  MEMORY_COMMAND_USAGE,
  MEMORY_FORGET_SUBCOMMAND,
  MEMORY_FORGET_USAGE,
  MEMORY_LIST_DEFAULT_LIMIT,
  MEMORY_LIST_SUBCOMMAND,
  MEMORY_LIST_USAGE,
  MEMORY_REMEMBER_SUBCOMMAND,
  MEMORY_REMEMBER_USAGE,
  MEMORY_SHOW_SUBCOMMAND,
  MEMORY_SHOW_USAGE,
  MEMORY_STATUS_SUBCOMMAND,
  MEMORY_STATUS_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
} from './command.js'
export type {
  MemoryCommandDefinition,
  MemoryCommandDetail,
  MemoryCommandDependencies,
  MemoryCommandForgetEntry,
  MemoryCommandForgetResult,
  MemoryCommandInvocation,
  MemoryCommandListEntry,
  MemoryCommandParseResult,
  MemoryCommandResult,
  MemoryStatusSnapshot,
} from './command.js'
export {
  MEMORY_FORGET_CONFIRMATION_HINT,
  MEMORY_FORGET_TOOL_DESCRIPTION,
  MEMORY_FORGET_TOOL_NAME,
} from './tools/memory-forget.js'
export type {
  MemoryForgetConfirmation,
  MemoryForgetFailed,
  MemoryForgetPreview,
  MemoryForgetStore,
  MemoryForgetValue,
} from './tools/memory-forget.js'
export {
  MEMORY_KINDS,
  MEMORY_REMEMBER_LAYER,
  MEMORY_REMEMBER_TOOL_DESCRIPTION,
  MEMORY_REMEMBER_TOOL_NAME,
} from './tools/memory-remember.js'
export type {
  MemoryKind,
  MemoryRememberFailed,
  MemoryRememberStore,
  MemoryRememberStored,
  MemoryRememberValue,
} from './tools/memory-remember.js'
export type { MemoryInboxWriteOptions } from './command.js'

/** cordis 模块名（AD-2，永不重命名）；与 settings namespace 一致。 */
export const name = 'dsh-oh-my-whale-memory' as const

/**
 * 本插件向宿主注入的能力清单。
 * `'commands'`：`/memory` 宿主命令（Story 1.7）。
 * `'settings'`：/settings 表单投影与 `/memory status` 的设置读取通道（AD-11）。
 * `'tools'`：工具注册表，memory_remember / memory_recall / memory_related / memory_forget
 * （Story 1.6/3.1/3.2/4.1）。
 * `'sessions'`：turn/end 采集前的持久化屏障 `ctx.sessions.flush(session)`（Story 2.1 / AC③）。
 * `'llm'`：INBOX 精炼的宿主单通道 `ctx.llm`（Story 2.3 / AD-5，显式 provider+model）。
 * `'systemPrompt'`：新会话开局注入的 section + 动态 context（Story 3.3 / FR-9 / AD-23）。
 */
export const inject = ['commands', 'settings', 'tools', 'sessions', 'llm', 'systemPrompt'] as const

/**
 * 记忆库运行态（Story 1.5 / AC2）：只读实例必须能被后续 story 的采集钩子、
 * 精炼消费者、`memory_remember` 工具与 `/memory status` 直接读到，据此禁用写入。
 */
export interface MemoryRuntimeState {
  /** true = 本窗口没拿到写者锁，已降级只读（AC1）。 */
  readonly readonly: boolean
  /** 只读降级原因，取 `READONLY_REASON`（AC2）。 */
  readonly reason?: string
  /** 实际使用的库路径。 */
  readonly dbPath?: string
}

let runtimeState: MemoryRuntimeState = { readonly: false }

/** 最近一次成功 apply 的记忆库运行态；apply 失败时不更新（插件未激活即无运行态）。 */
export function memoryRuntimeState(): MemoryRuntimeState {
  return { ...runtimeState }
}

/**
 * 插件激活函数。分级校验：硬校验失败抛错（仅阻塞本插件，宿主继续运行）；
 * 降级项（embedding token/model 缺失、写者锁被占用）走 warn。
 * config 类型用结构化占位：Loader 在运行时按 Config schema resolve 后传入，
 * 这里保留宽松签名以避免与宿主解析器类型耦合。
 */
export async function apply(
  ctx: Context,
  config: Parameters<typeof resolveRuntimeConfig>[0],
): Promise<void> {
  const resolved = resolveRuntimeConfig(config)
  // warnings 只含字段名与降级说明，不携带凭据值（NFR9）。
  for (const message of resolved.warnings) {
    ctx.logger.warn(message)
  }

  // 单次 apply 的可变装配槽：命令/工具/status 经闭包 getter 读它，teardown 在 dispose 时清回
  // 「未就绪」。不放模块级：同进程第二次 apply 会覆盖前一个实例的运行态（评审 P19）。
  const slots = createMemoryRuntimeSlots()
  const getDb = (): MemoryDatabase | undefined => slots.db
  // Story 8.1：上下文归因账本（AC:1565-1569）。`tokenMeter` 是**可选**服务：用 `ctx.get` 探测，
  // 不进 `inject`（缺了不该阻塞插件激活）；缺失/抛错都只在采集时 warn 一次，快照保持 null。
  // 快照纯进程内存 ⇒ 只读实例同样采集（零写库，INV-7）。
  const attributionTap = createAttributionTap({
    getTokenMeter: () => (ctx.get?.('tokenMeter') ?? undefined) as TokenMeterLike | undefined,
    logger: ctx.logger,
  })
  // Story 3.3：每 apply 一份注入状态（prompt provider / 生成编排 / status 共用；进程内、不持久化）。
  const injectionStore = createInjectionStore()
  const instance: { readonly: boolean; reason: string | undefined } = { readonly: false, reason: undefined }

  // 单元隔离：一个 wire 失败只告警（与项目既有日志同口径），不拖垮其它单元。
  // 成功路径不产生任何告警，entry-exports 钉死 warn 调用次数。
  const wireStep = async <T>(unit: string, step: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await step()
    } catch (error) {
      ctx.logger.warn(
        `记忆插件装配失败（${unit}）：` + (error instanceof Error ? error.message : String(error)),
        error,
      )
      return undefined
    }
  }

  // Story 7.2：反思窗口分与熔断状态只在内存里（重启即冷静），由 status 读取。
  const reflectionState = createReflectionState()
  const access = createMemoryAccess({
    getDb,
    resolved,
    readonlyState: () => instance,
    getSystemOneClient: () => slots.systemOneClient,
    // Story 3.3：status 读注入观测摘要（进程内，null=本实例尚未触发注入）。
    injectionStore,
    // Story 8.1：status 的 context_ledger 行读同一个 tap 快照（null ⇒ n/a）。
    contextLedgerView: () => attributionTap.snapshot(),
    // Story 7.2：reflection 行数据源（窗口分 / 最近决策 / 熔断态）。
    reflectionView: () => {
      const view = readReflectionView(reflectionState)
      return {
        windowScore: view.windowScore,
        lastTurnScore: view.lastTurnScore,
        lastReflectionAt: view.lastReflectionAt,
        trigger: view.lastDecision?.reason ?? null,
        breaker: view.breaker.status,
        consecutiveFailures: view.breaker.consecutiveFailures,
      }
    },
  })
  const retrieval = createRetrievalWiring({
    ctx,
    getDb,
    readConnection: access.readConnection,
    resolved,
  })

  // Story 1.6 / 1.7：命令与工具都在 profileContext 早退之前无条件注册（注册是 effect，
  // 自动挂 disposer），共用同一个闭包库句柄，库未就绪时命令给出明确错误、工具给出
  // db_unavailable，可用性不受 profile/建库问题牵连。
  await wireStep('commands', () => wireMemoryCommand(ctx, {
    writeInbox: access.writeInbox,
    listMemories: access.listMemories,
    getMemoryById: access.getMemoryById,
    getStatus: access.getStatus,
    recallMemories: retrieval.recallMemories,
    relatedMemories: retrieval.relatedMemories,
    // Story 4.1：遗忘（写路径；只读实例在 access 里先拒）。
    forgetMemory: access.forgetMemory,
    // Story 7.1：裁决待裁决冲突（写路径；只读实例在 access 里先拒）。
    resolvePendingDecision: access.resolvePendingDecision,
    // Story 7.3：策略候选区与采纳门计数（只读可查）。
    getStrategyStats: access.getStrategyStats,
  }))
  // teardown 钩子：lifecycle 在 executor 之前注册，所以先用可变 ref 占位，executor 建好后赋值。
  let cancelReflectionTimer: (() => void) | null = null
  let cancelCompactionTimers: (() => void) | null = null
  // Story 3.1：每轮召回配额的双点重置（只读实例也提供召回，故在只读早退之前注册）；
  // `ctx.on` 自动挂 disposer，不新增 ctx.effect（entry-exports 钉死 closer 数）。
  // （赋值在 executor 建好之后：此处只占位，避免 TDZ。）
  await wireStep('recall-quota', retrieval.wireQuotaReset)
  await wireStep('tools', () => wireMemoryTools(ctx, {
    getDb,
    recallStore: retrieval.recallStore,
    relatedStore: retrieval.relatedStore,
    quota: retrieval.quota,
    // Story 8.2：`memory_related` 结果超阈值 ⇒ 折成句柄（全文入图，表面只留句柄）。
    fold: {
      thresholdTokens: resolved.foldThresholdTokens,
      // 惰性：wiring 发生在写者锁之前，此刻 instance.readonly 还没定（INV-7 必须靠运行期判定）。
      readonly: () => instance.readonly,
      write: async (input) => {
        const database = getDb()
        if (database === undefined) throw new Error('db unavailable')
        const record = await writeHandle(database.connection, {
          sessionId: input.sessionId,
          seq: input.seq,
          text: input.text,
          recordedAt: new Date().toISOString(),
          tokens: input.tokens,
        })
        return { id: record.id }
      },
      logger: ctx.logger,
    },
  }))
  // Story 3.3：注入面（section + context）与生成入口（`agent/pre-step`）同样在只读早退之
  // 前注册，写者与只读实例都要有注入面（纯读 + 可选 LLM）。裸 ctx 时整面/监听跳过，
  // 不抛错；注册走宿主 systemPrompt 作用域与 `ctx.on` 的自动 disposer，不新增 ctx.effect
  //（entry-exports 钉死 closer 数 3/4/6）。
  await wireStep('injection', () => wireInjection(ctx, {
    store: injectionStore,
    recallStore: retrieval.recallStore,
    resolved,
  }))

  // AC1：库路径唯一来源是 profile 目录（$DSH_HOME/profiles/<name>），插件不自拼 DSH_HOME。
  // 无 profileContext（单测/裸 Context）时跳过建库，不猜测路径。
  const profile = (ctx.get?.('profileContext') ?? undefined) as { dir?: string } | undefined
  if (!profile?.dir) {
    ctx.logger.warn('未获取 profileContext.dir，跳过记忆库初始化（无 profile 归属时不猜库路径）')
    return
  }

  const dbPath = resolveMemoryDbPath(profile.dir)
  const embedding = resolveEmbeddingProfile(resolved.embedding)
  for (const message of embedding.warnings) {
    ctx.logger.warn(message)
  }

  // AC1/AC3：先抢写者锁再开库，第二个实例拿不到锁就降级只读，不阻断宿主启动；
  // 陈旧锁由 withFileLock 的接管语义处理（waitMs: 0 也不会牺牲它）。
  // 锁文件是 `<dbPath>.lock`，与库同在 `<profile>/memory/`，所以目录必须先存在；
  // 只读实例走到这里说明写者尚未建库，建目录本身不产生库文件（不创建空库）。
  await ensureMemoryDbDirectory(dbPath)
  const lock = await acquireWriterLock(dbPath)
  const readonlyMode = lock.mode === 'readonly'
  // Story 8.3 / AC:1683：压缩引擎是另一个入口（provider），通过这个按 ctx 分槽的标记知道
  // 当前实例是否只读；只读实例的 summarize 一律委托 stock（零折叠 / 零入图 / 零账本）。
  setCompactionReadonly(readonlyMode)
  try {
    // AC5：维度不符在 openMemoryDatabase 内抛 embedding_dim_mismatch，阻塞本插件启动。
    // 工具与命令经闭包读同一句柄：只读实例的 upsertMemory 抛 readonly_mode，
    // 由 memory_remember / `/memory remember` 收敛为 canonical failed（不 throw）。
    slots.db = await openMemoryDatabase({
      dbPath,
      dim: embedding.dim,
      modelId: embedding.modelId,
      readOnly: readonlyMode,
      // F-06：只读实例的扩展装载失败由此记 warn（写者路径用不到该出口）。
      logger: ctx.logger,
    })
  } catch (error) {
    // 开库失败就不该占着写者锁，释放引用后把原始错误抛给宿主。
    await lock.release()
    throw error
  }

  runtimeState = { readonly: readonlyMode, reason: lock.reason, dbPath }
  // 本实例状态与模块级运行态同步；导出 memoryRuntimeState() 的语义不变（仍是最近一次成功 apply）。
  instance.readonly = readonlyMode
  instance.reason = lock.reason

  // Story 8.3 / AC:1709-1711：写者实例把「写句柄」端口交给压缩 provider（子路径入口拿不到这里的
  // 闭包）。只读实例不注册 ⇒ provider 的 T1 分支 fail-open 委托 stock（零写库，INV-7）。
  if (!readonlyMode) {
    registerHandleWriter(async ({ sessionId, seq, text, tokens }) => {
      const db = getDb()
      if (db === undefined) throw new Error('记忆库未就绪，无法写折叠句柄')
      const record = await writeHandle(db.connection, {
        sessionId,
        seq,
        text,
        recordedAt: new Date().toISOString(),
        ...(tokens === undefined ? {} : { tokens }),
      })
      return { id: record.id }
    })
  }

  // Story 8.3 / AC:1675、NFR19：覆盖缺口检测延到微任务，避开「apply 时压缩服务尚未激活」的误报。
  queueMicrotask(() => {
    const warning = compactionOverlayGapWarning(detectCompactionOverlayGap(ctx))
    if (warning !== null) ctx.logger.warn(warning)
  })

  // Story 7.3：反思定时器在 lifecycle 的既有 teardown 里释放（不新增 closer）。
  await wireStep('lifecycle', () => wireMemoryLifecycle({
    ctx,
    dbPath,
    lock,
    slots,
    onTeardown: () => {
      cancelReflectionTimer?.()
      cancelCompactionTimers?.()
      // Story 8.3：实例销毁后 provider 不能再写句柄（同 ctx 槽位清空，回到 fail-open）。
      registerHandleWriter(null)
      setCompactionReadonly(true)
    },
  }))

  if (readonlyMode) {
    // 只读实例不能改写库级 model id：配置与库内记录不一致时必须显式告知，不静默降级
    // （AD-14 的 fail-loud 精神：不匹配的 embedding 模型会让召回结果按错的模型解释）。
    if (slots.db !== undefined && slots.db.modelId !== embedding.modelId) {
      ctx.logger.warn(
        `只读实例的 embedding 模型与库内记录不一致：库内 ${slots.db.modelId}，配置 ${embedding.modelId}；` +
        '只读模式不修改库级元数据，请核对配置或由持有写者锁的窗口改写。',
      )
    }
    // AC2：只读实例的标注必须完整可读，后续 story 的 /memory status 直接复用同一文案。
    ctx.logger.warn(
      `记忆库以只读模式打开（readonly: true, reason: '${READONLY_REASON}'）：${dbPath}；` +
      '本窗口不采集、不精炼、拒绝写入。关闭持有写者锁的窗口后重启本窗口可恢复读写。',
    )
    // Story 8.1 / AC:1581：只读实例**零写库**，但归因账本只占进程内存，仍要采集
    // （否则读窗口的 `/memory status` 永远 n/a）。只装这一个 turn/end 监听器：不接闸门、
    // 不接采集器、不订阅 compaction（INV-7）。
    await wireStep('attribution-events', () =>
      wireTurnEndCapture(ctx, (session) => attributionTap.capture(session)))
    return
  }

  ctx.logger.info(`记忆库就绪：${dbPath}（dim=${embedding.dim}，model=${embedding.modelId}）`)

  // Story 2.2：写者实例的最后一段接线（只读实例在上面已 return，不回收 lease、不启动消费者，AC7）。
  // 空闲闸门由 session/event 的 turn/start~turn/end 驱动（AD-6），消费者与监听器必须共享同一实例。
  const gate = createIdleGate()
  const promotion = createPromotionWiring({ ctx, getDb })
  await wireStep('inbox-reclaim', () => reclaimInboxOnStartup({ ctx, getDb }))
  // Story 2.1：三钩子采集器 + 孤儿快照重放（AC5）。
  // Story 7.2 / AC:1406：每个 turn 落库后计兴趣分并写一条账本行（可检视「为什么触发/没触发」）。
  // 注意：本 seam 只有会话正文，工具调用维度拿不到（记 0）——那部分在 7.3 的反思执行器接 step 事件后补齐；
  // 此处 idle=0（turn 刚结束），因此决策原因通常是 idle，这是对当前时刻的**如实**记录，不是缺陷掩盖。
  const onTurnCaptured = (input: { readonly text: string; readonly recordedAt: Date }): void => {
    const now = input.recordedAt
    const decision = recordTurn(reflectionState, {
      signals: { userChars: input.text.length, toolCalls: 0, distinctTools: 0 },
      idleMs: 0,
      now,
    })
    const connection = getDb()?.connection
    if (connection === undefined) return
    void auditWriter(connection, {
      recordedAt: now.toISOString(),
      actor: 'system',
      kind: 'reflection',
      policy: 'reflection-trigger',
    })({
      action: 'reflection_tick',
      outcome: decision.trigger ? 'success' : 'uncertain',
      reason:
        'score=' + String(reflectionState.lastTurnScore ?? 0) +
        ' window=' + String(reflectionState.windowScore) +
        ' trigger=' + (decision.trigger ? 'yes' : 'no') +
        ' reason=' + decision.reason,
    }).catch((error: unknown) => {
      // 账本写失败不阻塞采集（观测 fire-and-forget，AD-10）。
      ctx.logger.warn('反思计分账本写入失败：' + String(error))
    })
  }
  /**
   * Story 7.3：反思执行器——候选区的**唯一生产者**（评审 R73 的 P1：此前候选区无写入方）。
   *
   * - 取材只读最近 8 条 inline L0（ref = `l0:<id>`，可回溯到 L0，满足 AC:1458）；
   * - LLM 走宿主 `ctx.llm` 单通道（AD-5），provider/model 取 resolved 配置；
   * - 调度：每个 turn 结束都「重置」一个 idleWaitMs 的定时器 —— 新 turn 会把反思推到下一个停顿（AD-37）。
   */
  // teardown 钩子：先声明再赋值（lifecycle 在 executor 创建之前注册）。
  const reflectionExecutor = createReflectionExecutor({
    connection: () => getDb()?.connection ?? null,
    collectSamples: async () => {
      const connection = getDb()?.connection
      if (connection === undefined) return []
      const rows = await queryRows(
        connection,
        [
          'MATCH (l:l0_raw)',
          '  WHERE l.raw_text IS NOT NULL',
          '  RETURN l.id AS id, l.raw_text AS text',
          '  ORDER BY l.recorded_at DESC LIMIT 8',
        ].join('\n'),
      ).catch(() => [])
      return rows.map((row) => ({ ref: 'l0:' + String(row.id), text: String(row.text ?? '') }))
    },
    extract: async (messages) => {
      const provider = resolved.llmProvider
      const model = resolved.llmModel
      if (provider === undefined || model === undefined) {
        // AD-5：插件不自带 key/路由；未配置就明确失败（不编造候选）。
        throw new Error('未配置 llmProvider/llmModel，无法提炼策略候选')
      }
      const folded = await foldStream(ctx.llm.stream({ provider, model, messages, maxTokens: 1200 }))
      if (folded.finish === undefined || folded.finish.kind !== 'stop') {
        throw new Error('策略提炼的 LLM 调用未正常结束：' + String(folded.finish?.kind ?? 'unknown'))
      }
      return folded.text
    },
    state: reflectionState,
    thresholds: resolved.reflection,
    gate: resolved.strategyGate,
    logger: ctx.logger,
  })
  cancelReflectionTimer = () => reflectionExecutor.cancel()

  const capture = await wireStep('capture', () => wireCapture({
    ctx,
    dbPath,
    getDb,
    resolved,
    onTurnCaptured: (input) => {
      onTurnCaptured(input)
      // 新 turn 把反思推到下一个停顿（AD-37：新 turn 会把 review 推到下一个 pause）。
      reflectionExecutor.scheduleAfterIdle()
    },
  }))
  // Story 2.3–2.6：精炼处理器、关系跑者、向量/EVIDENCE 回填（不注册 effect/定时器）。
  const distill = await wireStep('distill', () => createDistillWiring({
    ctx,
    getDb,
    resolved,
    embedding,
    gate,
    slots,
  }))
  if (distill) {
    await wireStep('inbox-consumers', () => startInboxConsumers({
      ctx,
      getDb,
      slots,
      gate,
      promotion,
      l1Processor: distill.l1Processor,
      l2Processor: distill.l2Processor,
      maintenance: distill.maintenance,
    }))
  }
  if (capture) {
    /**
   * Story 8.1：压缩事件接线（INV-7：只读实例不注册——它既不能写 INBOX，也没有压缩动作）。
   */
  // INV-7：只读实例在上面已经早退，走不到这里；因此此处无需再判一次（评审 R81：删掉恒真的判据）。
  const compactionWiring = readonlyMode
    ? null
    : createCompactionWiring({
        getConnection: () => getDb()?.connection ?? null,
        configSnapshot: () => ({
          injectionEnabled: resolved.injectOnNewSession,
          retrievalTopK: resolved.retrievalTopK,
          captureSteps: resolved.captureSteps,
        }),
        orphanTimeoutMs: resolved.compactionOrphanTimeoutMs,
        onOrphan: (info) => {
          // AC:1544 / INV-6：解阻塞必须留账（评审 R81 第 3 条：原先只 warn，注释却说"记一条审计行"）。
          ctx.logger.warn('compaction/start 无配对，已解除阻塞：session=' + info.sessionId + ' turn=' + String(info.turn))
          const connection = getDb()?.connection
          if (connection === undefined) return
          void auditWriter(connection, {
            recordedAt: new Date().toISOString(),
            actor: 'system',
            kind: 'compaction',
            policy: 'compaction-orphan',
          })({
            action: 'compaction_orphan_unblocked',
            outcome: 'uncertain',
            reason: 'session=' + info.sessionId + ' turn=' + String(info.turn) + ' waitedMs=' + String(info.waitedMs),
          }).catch((error: unknown) => {
            ctx.logger.warn('孤儿解阻塞账本写入失败：' + String(error))
          })
        },
        logger: ctx.logger,
      })
  cancelCompactionTimers = () => compactionWiring?.stop()
  await wireStep('session-events', () => wireSessionEvents(ctx, {
    gate,
    promotion,
    capture,
    compaction: compactionWiring ?? undefined,
    // Story 8.1：turn/end 写侧采集之后再采一次归因（纯内存，AC:1565-1569）。
    onTurnEnd: (session) => attributionTap.capture(session),
  }))
  }
}


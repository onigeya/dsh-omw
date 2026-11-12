/**
 * dsh-oh-my-whale-memory function 插件入口。
 *
 * 五件套命名导出形态由 PRD §14 / postmortem 0001 锁定：宿主 Loader 只识别
 * 命名导出 `name`/`inject`/`Config`/`apply`；default export 会让 Loader 丢弃
 * function 插件命名空间——本文件禁用 default export。
 *
 * Story 1.3：inject 加入 `'settings'`（AD-11），Config 填全字段（FR-18），
 * apply 做分级校验（硬校验抛错阻塞本插件 / 可降级项 warn）。
 *
 * Story 1.4：apply 阶段完成记忆库物理地基——在 profile 专属路径建库（AC1）、
 * 创建两张节点表与 HNSW/FTS 索引（AC2/AC4）、把 embedding 维度 pin 进库级元数据
 * （AC2）；维度不符直接抛 `MemoryDbError('embedding_dim_mismatch')` 阻塞启动
 * （AC5/AD-14 fail-loud，绝不静默降级或重建库）。库句柄用 ctx.effect 注册 close，
 * 宿主 dispose→apply 抖动时按绝对路径复用 registry 中的同一句柄。
 *
 * Story 1.5（AD-12）：apply 先申请进程级写者锁，拿到才以读写打开库；拿不到（另一个
 * 存活实例持锁）不抛错，改为 `readOnly: true` 降级打开并记入 `memoryRuntimeState()`
 * （AC1/AC2）。锁用同一个 ctx.effect 注册释放。**先定角色再开库**是硬性顺序：
 * LadybugDB 只要存在只读句柄，之后同文件的读写打开必失败 `Error: 33`。
 * 陈旧锁（前一实例异常退出）由 withFileLock 自身的接管语义处理（AC3）。
 *
 * Story 1.6：注册模型工具 `memory_remember`（直写 L1，不产 embedding）。
 * 工具先于建库注册，闭包 getter 在库未就绪时返回 undefined → 调用得到
 * `db_unavailable`，因此工具可用性不受 profile/建库问题牵连。
 *
 * Story 1.7：注册宿主命令 `/memory`（子命令 `remember`）把文本写入 L1 收件箱；
 * 命令同样在 profileContext 早退之前无条件注册（库未就绪时返回明确错误，AC4），
 * 与工具共用同一个闭包可变量 `db`。
 *
 * Story 1.8：同一命令扩展出 `list [关键词]` 与 `show <id>` 两个**只读**子命令（仍只有
 * 一处 `register`）。两个读 dep 同样惰性绑定 `db.connection`——库未就绪时 throw 明确
 * 错误，由命令层收敛成 `{kind:'error'}`，绝不静默返回空列表。
 *
 * Story 1.9：同一命令再扩展出 `status`（只读、无参）——层计数走 db 层
 * `countMemoriesByLayer`（四条计数一条语句），运行态复用 `memoryRuntimeState()` 的
 * readonly/reason，配置态用闭包捕获的 `resolved.embeddingMode`。仍是同一 definition、
 * 同一 register 点，不新增 `ctx.effect`、不新增网络/LLM 调用（AC5）。
 *
 * 契约说明：apply 收到的 config 是宿主根据 Config schema resolve 出的 volatile
 * 节点对象——顶层每个字段都是 `.get()` 可调用的 volatile 节点。
 * resolveRuntimeConfig 用 Getter<T> 包装读取，兼容普通值与 volatile 节点两种形态
 * （便于纯单测直接传 plain object）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { resolveRuntimeConfig } from './config.js'
import { computeAuditGap } from './db/audit.js'
import { computeEvidenceGap } from './db/eii.js'
import { resolveEmbeddingProfile } from './db/embedding-profile.js'
import { resolveMemoryDbPath, ensureMemoryDbDirectory } from './db/paths.js'
import { openMemoryDatabase, type MemoryDatabase } from './db/database.js'
import { runInTransaction } from './db/transaction.js'
import { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
import {
  countMemoriesByLayer,
  countUnembeddedMemories,
  getMemoryById as readMemoryById,
  listEffectiveMemoryIdsByLayer,
  listMemories as readMemories,
  readL2PromotionCursor,
  writeL2PromotionCursor,
} from './db/memory.js'
import {
  createMemoryCommandDefinition,
  type MemoryCommandDependencies,
  type MemoryCommandsRuntime,
  type MemoryInboxWriteOptions,
  type MemoryStatusSnapshot,
} from './command.js'
import { createMemoryRememberTool, MEMORY_REMEMBER_LAYER } from './tools/memory-remember.js'
import {
  createInboxConsumer,
  drainInboxBackgroundTasks,
  trackInboxBackgroundTask,
  type InboxConsumer,
} from './inbox/consumer.js'
import { createIdleGate } from './inbox/idle-gate.js'
import { L1_PROMOTION_THRESHOLD, createPromotionTracker } from './inbox/promotion-trigger.js'
import { createSessionEventHandler } from './inbox/session-events.js'
import { createCaptureRecorder } from './capture/recorder.js'
import { createEmbeddingBackfill } from './embedding/backfill.js'
import { createEvidenceBackfill } from './wiki/evidence-backfill.js'
import { countRelatedSkips, createRelationRunner } from './wiki/relations.js'
import { createEmbeddingClient } from './embedding/client.js'
import { createInboxProcessor } from './distill/processor.js'
import { routeFromSession } from './distill/session-route.js'
import type { LlmPort, RefineRoute } from './distill/llm-refine.js'
import {
  INBOX_FAILED_VIEW_LIMIT,
  countInboxByStatus,
  l1InboxQueue,
  l2InboxQueue,
  listRecentFailedInboxItems,
  reclaimProcessingInboxItems,
} from './inbox/queue.js'
import {
  L2_INBOX_KIND,
  L2_PROMOTION_INTERVAL_MS,
  buildL2PromotionItemId,
  createL2PromotionProcessor,
  type L2PromotionPayload,
} from './distill/promotion.js'
import {
  createSystemOneClient,
  setSystemOneEnabled,
  systemOneRuntimeState,
} from './distill/system-one.js'

/**
 * `session/event` 宿主事件面（Story 2.2 / AD-6、Story 2.1）。
 *
 * `turn/start` / `turn/end` / `step/end` / `compaction/start` 是宿主全局广播的会话事件
 * （`docs/cookbook/extension-cookbook.md:79`）；事件名不在本 Context 的类型化事件表里，故用一条
 * 具名结构类型显式声明这处接线——不把整个 Context 断言成 any，也便于裸 ctx 单测里降级为不监听。
 * Story 2.1 起 inject 含 `'sessions'`，为 turn/end 采集提供 flush 屏障（AC③）。
 */
interface SessionEventHost {
  on?(event: 'session/event', listener: (session: unknown, event: unknown) => void): unknown
}

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
  MemoryCommandInvocation,
  MemoryCommandListEntry,
  MemoryCommandParseResult,
  MemoryCommandResult,
  MemoryStatusSnapshot,
} from './command.js'
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
 * `'settings'`：/settings 表单投影与后续 /memory status 的设置读取通道（AD-11）。
 * `'tools'`：工具注册表——memory_remember 经 `ctx.tools.register` 注册（Story 1.6）。
 * `'sessions'`：turn/end 采集前的持久化屏障 `ctx.sessions.flush(session)`（Story 2.1 / AC③）。
 * `'llm'`：INBOX 精炼的宿主单通道 `ctx.llm`（Story 2.3 / AD-5，显式 provider+model）。
 */
export const inject = ['commands', 'settings', 'tools', 'sessions', 'llm'] as const

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
 * config 类型用结构化占位——Loader 在运行时按 Config schema resolve 后传入，
 * 这里保留宽松签名以避免与宿主解析器类型耦合。
 */
export async function apply(
  ctx: Context,
  config: Parameters<typeof resolveRuntimeConfig>[0],
): Promise<void> {
  const resolved = resolveRuntimeConfig(config)
  // warnings 只含字段名与降级说明——绝不携带凭据值（NFR9）。
  for (const message of resolved.warnings) {
    ctx.logger.warn(message)
  }
  // Story 2.5 / U6：把配置态同步进 System One 的运行态槽——getStatus 读它渲染
  // systemOne 行（配置关闭时清掉可能残留的运行态降级）。放在所有早退之前，
  // 只读实例也要能正确渲染配置态。
  setSystemOneEnabled(resolved.systemOne.enabled)

  // Story 1.6 / 1.7：命令与工具都在 profileContext 早退之前无条件注册（注册是 effect，
  // 自动挂 disposer），两者共用闭包可变量 `db`——库未就绪时命令给出明确错误、
  // 工具给出 db_unavailable，可用性不受 profile/建库问题牵连。
  let db: MemoryDatabase | undefined
  // Story 1.9：本实例自身的只读态。模块级 `runtimeState` 只表示「最近一次成功 apply」，
  // 同进程再次 apply 会让本实例的命令读到别的实例的锁结果，故 getStatus 只读这份局部值。
  let instanceReadonly = false
  let instanceReadonlyReason: string | undefined
  // Story 2.2：后台 INBOX 消费者（只有写者实例会创建并启动）。声明在两个 ctx.effect 之前——
  // db effect 的 disposer 在 dispose 时先停消费者再关库（不新增 effect，closer 数不变）。
  let inboxConsumer: InboxConsumer | null = null
  // Story 2.5：L2 提升消费者（慢循环）。与 L1 消费者同挂在 db effect 的 disposer 上，
  // 仍是**不新增 ctx.effect**（entry-exports 钉死 closer 数 3/4/6）。
  let l2Consumer: InboxConsumer | null = null
  // Story 1.11（AC2/AC3）：INBOX 采集写路径。层收敛为唯一枚举——写 `L1`
  // （= MEMORY_REMEMBER_LAYER），`L1_INBOX` 从此只是 INBOX 队列标识/表名，不是 memory.layer 取值。
  // 可选分类旗标（kind / priority，含 -1）在此透传到落库，与 memory_remember 同一条写路径。
  const writeL1Inbox = async (text: string, options?: MemoryInboxWriteOptions): Promise<void> => {
    if (!db) {
      throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法写入 L1')
    }
    // Epic 1 无 embedding 客户端：三列 embedding/embedding_model_id/embedding_dim
    // 同落 NULL（不写零向量污染 HNSW cosine 索引），Story 2.3 引入客户端后回填。
    await db.upsertMemory({
      layer: MEMORY_REMEMBER_LAYER,
      text,
      kind: options?.kind,
      priority: options?.priority,
      embedding: null,
      embeddingModelId: null,
      actor: 'user',
    })
  }
  // Story 1.8：读 dep 与写 dep 一样惰性——注册发生在建库之前，闭包在 handler 被调用时
  // 才读 `db`。库未就绪时 throw，由命令层收敛为 error 结果，绝不静默返回空列表。
  const readConnection = (): MemoryDatabase => {
    if (!db) {
      throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法读取记忆')
    }
    return db
  }
  const listMemories = (input: { query?: string; limit: number }) =>
    readMemories(readConnection().connection, input)
  const getMemoryById = (id: string) => readMemoryById(readConnection().connection, id)
  // Story 1.9：只读层计数 + 本实例运行态（readonly/reason）+ 配置态（apply 时 resolve 的
  // embeddingMode）。纯读、无 LLM / 网络；库未就绪经 readConnection() 抛「记忆库未就绪…」，
  // 由命令层收敛为 error 结果，绝不静默返回 0 计数。
  const getStatus = async (): Promise<MemoryStatusSnapshot> => {
    const connection = readConnection().connection
    const counts = await countMemoriesByLayer(connection)
    const auditGap = await computeAuditGap(connection)
    // Story 2.2 / AC4：failed 换成 l1_inbox 的真实计数；有条目才读明细（最近 5 条 + stale），
    // 无失败时不追加任何行，status 既有输出逐字不变。队列表缺失照抛（可见错误，不静默报 0）。
    const unembedded = await countUnembeddedMemories(connection)
    // Story 2.6 / F2：边侧差额（EII 违例 + 边↔source_refs 漂移）与关系降级计数。
    // computeEvidenceGap 在边表缺失时返回 null（渲染成未知，不静默报 0）。
    const evidenceGap = await computeEvidenceGap(connection, new Date().toISOString())
    const relatedSkipped = await countRelatedSkips(connection)
    const inboxCounts = await countInboxByStatus(connection)
    // Story 2.5 / U1：L2_INBOX 行从「memory.layer 的历史计数槽」换成 **l2_inbox 的真实队列深度**
    // （pending + processing = 待提升条目；done/failed 不计入——failed 另有 failed 行）。
    const l2InboxCounts = await l2InboxQueue.countByStatus(connection)
    const failedEntries = inboxCounts.failed > 0
      ? await listRecentFailedInboxItems(connection, { limit: INBOX_FAILED_VIEW_LIMIT })
      : []
    return {
      layers: { L1: counts.L1, L2: counts.L2 },
      inboxes: {
        L1: counts.L1_INBOX,
        L2: l2InboxCounts.pending + l2InboxCounts.processing,
      },
      failed: inboxCounts.failed,
      failedEntries,
      embeddingMode: resolved.embeddingMode,
      // Story 2.5 / U6：配置态（enabled=false）优先于运行态（端点持续不可达 ⇒ degraded）。
      systemOne: resolved.systemOne.enabled
        ? (systemOneRuntimeState().degraded ? 'degraded' : 'enabled')
        : 'disabled-by-config',
      unembedded,
      readonly: instanceReadonly,
      readonlyReason: instanceReadonlyReason,
      auditGap,
      evidenceGap,
      relatedSkipped,
    }
  }
  const commandDependencies: MemoryCommandDependencies = {
    writeInbox: writeL1Inbox,
    listMemories,
    getMemoryById,
    getStatus,
  }
  // 命令的 effect 工厂必须返回可调用 disposer——宿主 commands 服务缺失（裸 ctx）时退化为 no-op。
  ctx.effect(
    () => {
      const commands = ctx.get?.('commands') as MemoryCommandsRuntime | undefined
      return commands?.register(createMemoryCommandDefinition(commandDependencies)) ?? (() => {})
    },
    'omw-memory-command',
  )
  ctx.tools.register(createMemoryRememberTool(() => db))

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

  // AC1/AC3：先抢写者锁再开库——第二个实例拿不到锁就降级只读，不阻断宿主启动；
  // 陈旧锁由 withFileLock 的接管语义处理（waitMs: 0 也不会牺牲它）。
  // 锁文件是 `<dbPath>.lock`，与库同在 `<profile>/memory/`，所以目录必须先存在；
  // 只读实例走到这里说明写者尚未建库，建目录本身不产生库文件（不创建空库）。
  await ensureMemoryDbDirectory(dbPath)
  const lock = await acquireWriterLock(dbPath)
  try {
    // AC5：维度不符在 openMemoryDatabase 内抛 embedding_dim_mismatch，阻塞本插件启动。
    // 工具与命令经闭包读同一句柄：只读实例的 upsertMemory 抛 readonly_mode，
    // 由 memory_remember / `/memory remember` 收敛为 canonical failed（绝不 throw）。
    db = await openMemoryDatabase({
      dbPath,
      dim: embedding.dim,
      modelId: embedding.modelId,
      readOnly: lock.mode === 'readonly',
    })
  } catch (error) {
    // 开库失败就不该占着写者锁——释放引用后把原始错误抛给宿主。
    await lock.release()
    throw error
  }

  const readonlyMode = lock.mode === 'readonly'
  runtimeState = { readonly: readonlyMode, reason: lock.reason, dbPath }
  // 本实例状态与模块级运行态同步；导出 memoryRuntimeState() 的语义不变（仍是最近一次成功 apply）。
  instanceReadonly = readonlyMode
  instanceReadonlyReason = lock.reason

  // 注册都是 effect：自己打开的资源必须挂 disposer 由宿主统一释放。
  // 异步 disposer：宿主/测试都会 await 它（entry-exports.test.ts 逐个 await closers）。
  ctx.effect(() => async () => {
    // dispose 顺序：先停消费者（不再开新轮、清掉待触发定时器），再等**在飞轮次结算完**
    // （drain），最后关库——否则精炼/落库会落在已关闭的连接上。仍只挂一个 effect，
    // closer 数不变（entry-exports 钉死 3 / 4 / 6）。
    inboxConsumer?.stop()
    inboxConsumer = null
    l2Consumer?.stop()
    l2Consumer = null
    await drainInboxBackgroundTasks()
    await db?.close()
  }, 'omw-memory-db')
  ctx.effect(() => () => lock.release(), 'omw-memory-writer-lock')

  if (lock.mode === 'readonly') {
    // 只读实例不能改写库级 model id：配置与库内记录不一致时必须显式告知，不静默降级
    // （AD-14 的 fail-loud 精神：不匹配的 embedding 模型会让召回结果按错的模型解释）。
    if (db.modelId !== embedding.modelId) {
      ctx.logger.warn(
        `只读实例的 embedding 模型与库内记录不一致：库内 ${db.modelId}，配置 ${embedding.modelId}；` +
        '只读模式不修改库级元数据，请核对配置或由持有写者锁的窗口改写。',
      )
    }
    // AC2：只读实例的标注必须完整可读——后续 story 的 /memory status 直接复用同一文案。
    ctx.logger.warn(
      `记忆库以只读模式打开（readonly: true, reason: '${READONLY_REASON}'）：${dbPath}；` +
      '本窗口不采集、不精炼、拒绝写入。关闭持有写者锁的窗口后重启本窗口可恢复读写。',
    )
    return
  }

  ctx.logger.info(`记忆库就绪：${dbPath}（dim=${embedding.dim}，model=${embedding.modelId}）`)

  // Story 2.2：写者实例的最后一段接线（只读实例在上面已 return，不回收 lease、不启动消费者，AC7）。
  // 1) 启动回收：**全部** processing → pending（进程 kill -9 后的自愈，AC3；理由见下方注释）；
  // 2) 空闲闸门由 session/event 的 turn/start~turn/end 驱动（AD-6）；
  // 3) 消费者由本 story 注入精炼处理器（ctx.llm 单通道）；它只在空闲闸门放开时取队头；
  // 4) 生命周期挂在既有 db effect 的 disposer 上，不新增 ctx.effect（entry-exports 钉死 closer 数）。
  const idleGate = createIdleGate()
  /**
   * Story 2.5（U3/U10）：把有效 L1 入 l2_inbox —— 每条 L1 一个条目（一个条目综合一条 L1）。
   *
   * - 条目 id 是确定性内容键（{@link buildL2PromotionItemId}）：MERGE ON CREATE 只建一次、不覆盖
   *   既有行 ⇒ 同一 L1 不会重复入队、崩溃重放不产重条目，**v1 的「丢弃不重试」**由此成立。
   * - 已在队列里的（pending/processing/done/failed）直接跳过：done = 已有结论，failed = 已耗尽
   *   4 次机会。要重试只能改 L1 文本（换指纹）或调阈值重新标定。
   * - sessionId 取触发信号的会话：L2 条目的路由解析靠它（缺省回退到 Config 的显式路由）。
   *
   * 评审 P1（T1）：候选**按 `(recorded_at, id)` 升序游标分页**取（页大小 200），不再把触发阈值
   * 当 LIMIT —— 旧口径每轮只覆盖最新 20 条有效 L1，更早的永久不可达。游标存 omw_meta，
   * 页尾（本页不足一页）回绕到起点，与确定性条目 id + readStatus 跳过共同保证收敛。
   * 评审 P12（T18）：整批入队 + 游标推进在**同一个 runInTransaction** 里完成，且循环内只能用
   * `writeItem`（`enqueue` 自带事务，重入会抛）—— 避免裸语句与 L1 写链交错。
   */
  const enqueuePromotion = async (trigger: { readonly reason: string, readonly sessionId: string }): Promise<number> => {
    const connection = db?.connection
    if (!connection) return 0
    const after = await readL2PromotionCursor(connection)
    const page = await listEffectiveMemoryIdsByLayer(connection, MEMORY_REMEMBER_LAYER, { after })
    const enqueued = await runInTransaction(connection, async () => {
      let written = 0
      for (const l1Id of page.ids) {
        const id = buildL2PromotionItemId(l1Id)
        if (await l2InboxQueue.readStatus(connection, id) !== null) continue
        const payload: L2PromotionPayload = { l1Ids: [l1Id] }
        await l2InboxQueue.writeItem(connection, {
          id,
          sessionId: trigger.sessionId,
          kind: L2_INBOX_KIND,
          payload: JSON.stringify(payload),
        })
        written += 1
      }
      // 游标与入队同一事务：否则崩溃会让游标前进而条目未入队，那批候选永久不可达。
      await writeL2PromotionCursor(connection, page.nextCursor ?? '')
      return written
    })
    if (enqueued > 0) {
      ctx.logger.info(
        `L1→L2 提升入队：${enqueued} 条 L1 进 l2_inbox（原因 ${trigger.reason}）`,
      )
    }
    return enqueued
  }
  const promotionTracker = createPromotionTracker({
    // AC:721「后台 FIFO 消费者」：触发信号在这里转成入队动作。onTrigger 是同步回调，
    // 故入队 fire-and-forget —— 挂模块级 Set 持强引用（§14），失败只告警不抛（信号不该拖垮采集）。
    onTrigger: (trigger) => {
      void trackInboxBackgroundTask(
        enqueuePromotion(trigger).catch((error: unknown) => {
          ctx.logger.warn(
            'L1→L2 提升入队失败：' + (error instanceof Error ? error.message : String(error)),
          )
          return 0
        }),
      )
    },
  })
  // 启动回收用「全部 processing 回 pending」，而不是只回收过期 lease（U7）：AD-12 的写者锁保证
  // 同一库同一时刻只有一个写进程，故本进程刚启动时看到的任何 processing 行都属于已死进程。
  // 只回收过期条目会让「T 崩溃、T+20s 重启（lease 到 T+60）」的条目卡到**下一次**重启才自愈。
  const reclaimed = await reclaimProcessingInboxItems(db.connection)
  if (reclaimed > 0) {
    ctx.logger.info(`INBOX 启动回收：${reclaimed} 条 processing 回 pending（单写者下必属已死进程）`)
  }
  // Story 2.5：L2 队列的启动回收与 L1 同口径（U7：单写者下 processing 必属已死进程）。
  const reclaimedL2 = await l2InboxQueue.reclaimProcessing(db.connection)
  if (reclaimedL2 > 0) {
    ctx.logger.info(`L2 INBOX 启动回收：${reclaimedL2} 条 processing 回 pending（单写者下必属已死进程）`)
  }
  // Story 2.1：三钩子采集器。只读实例已在上面 return，所以这里必然是写者实例（AD-12）。
  // 快照目录与库同父（<profile>/memory/capture/）；文件是「事务未提交」的崩溃标记。
  const captureRecorder = createCaptureRecorder({
    connection: () => db?.connection ?? null,
    captureSteps: resolved.captureSteps,
    snapshotDir: join(dirname(dbPath), 'capture'),
    logger: ctx.logger,
    // AC③：turn/end 采集前显式 await flush（宿主不在 turn 边界 flush；session.md:741）。
    // 裸 ctx（单测）没有 sessions 服务时缺省 no-op。
    flush: (session) => {
      const sessions = (ctx as unknown as {
        sessions?: { flush?: (value: unknown) => Promise<unknown> }
      }).sessions
      return typeof sessions?.flush === 'function'
        ? Promise.resolve(sessions.flush(session))
        : Promise.resolve()
    },
  })
  // AC5：启动扫描孤儿快照（有 .snap 文件 = 上一次进程在事务提交前崩溃）并重放入 INBOX。
  const replayedSnapshots = await captureRecorder.replayOrphanSnapshots()
  if (replayedSnapshots > 0) {
    ctx.logger.info(`孤儿快照重放：${replayedSnapshots} 条已重放入 INBOX`)
  }
  // Story 2.3：精炼处理器接线（R4）。
  // - embedding 客户端只在配置齐全时构造（FR-18 降级）；它的失败只记审计、不阻塞 L1 写入（N4）；
  // - 路由：Config 的 llmProvider/llmModel 优先，缺省从 session 的已记录请求目标解析（AC:567）；
  // - N2：apply 期间**不得求值** ctx.llm —— 用惰性端口，真正取用发生在消费轮次里；
  //   裸 ctx（单测）没有 llm/sessions 时也不会在 apply 阶段抛错。
  const embeddingClient = resolved.embeddingMode === 'enabled' && resolved.embedding.endpoint
    ? createEmbeddingClient({
      endpoint: resolved.embedding.endpoint,
      token: resolved.embedding.token ?? '',
      dim: embedding.dim,
    })
    : null
  const llmPort: LlmPort = {
    stream: (options) => (ctx as unknown as { llm: LlmPort }).llm.stream(options),
  }
  const configuredRoute: RefineRoute | null =
    resolved.llmProvider && resolved.llmModel
      ? { provider: resolved.llmProvider, model: resolved.llmModel }
      : null
  // 回退链与解析规则在 distill/session-route.ts（纯函数，评审 T21 要求可单测）。
  const sessionRoute = (sessionId: string): RefineRoute | null => {
    const sessions = (ctx as unknown as {
      sessions?: { get?: (id: string) => unknown }
    }).sessions
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    return routeFromSession(session)
  }
  // Story 2.6：关系维护跑者——在每个新 L1 节点上跑一次 KNN + 一次 ctx.llm 识别 + 应用层
  // 校验 + 写 RELATED 边。调用点在精炼事务之外（AC:779-782：关系失败不影响记忆进库）。
  // embedding 禁用 ⇒ 整体跳过 RELATED（记忆照常进库）并落一条 skip 审计供 status 可见。
  const relationRunner = createRelationRunner({
    connection: () => db?.connection ?? null,
    llm: llmPort,
    embeddingEnabled: embeddingClient !== null,
    logger: ctx.logger,
  })
  const inboxProcessor = createInboxProcessor({
    connection: () => db?.connection ?? null,
    llm: llmPort,
    relations: relationRunner,
    resolveRoute: (sessionId) => configuredRoute ?? sessionRoute(sessionId),
    embedding: embeddingClient,
    embeddingModel: resolved.embedding.model ?? null,
    embeddingModelId: embedding.modelId,
    logger: ctx.logger,
  })
  // Story 2.4 / U5：NULL 向量有界回填——只在 embedding 客户端存在时接线，挂消费者的
  // maintenance 钩子（空闲窗口、每轮 ≤50、不新增 ctx.effect/定时器；dispose 由既有 drain 覆盖）。
  const embeddingBackfill = embeddingClient
    ? createEmbeddingBackfill({
      connection: () => db?.connection ?? null,
      gate: idleGate,
      client: embeddingClient,
      model: resolved.embedding.model ?? '',
      modelId: embedding.modelId,
      logger: ctx.logger,
    })
    : null
  // Story 2.6 / X1：EVIDENCE 边历史回填（建表前的 L1/L2 没有边）——与向量回填共用同一个
  // maintenance 钩子与空闲闸门，不新增 ctx.effect/定时器。
  const evidenceBackfill = createEvidenceBackfill({
    connection: () => db?.connection ?? null,
    gate: idleGate,
    logger: ctx.logger,
  })
  inboxConsumer = createInboxConsumer({
    connection: () => db?.connection ?? null,
    gate: idleGate,
    promotion: promotionTracker,
    process: inboxProcessor,
    // 评审 P18a（T19）：**串行**跑两个回填。两者都在事务外做裸 prepare/execute，
    // 并发会在同一条连接上交错（语句可能落进对方未结算的连接级事务）。串行代价可忽略
    // （每轮各 ≤1 批），与 P7 的「游标进事务」是双保险。
    maintenance: async () => {
      const embedded = embeddingBackfill ? await embeddingBackfill.runOnce() : 0
      const evidenced = await evidenceBackfill.runOnce()
      return embedded + evidenced
    },
    logger: ctx.logger,
  })
  inboxConsumer.start()
  // Story 2.5：L1→L2 提升的第二条消费链。
  // - System One 客户端只在配置开启时构造（U9：端点/模型是模块常量，不扩 Config）；
  //   配置关闭时就整体回落 ctx.llm 单次检查（AC:674）。
  // - 慢循环：intervalMs 调到 30s（AC:721），并用 claimGuard 给 L1 主路径让路（L1 待处理时本轮不取件）。
  const systemOneClient = resolved.systemOne.enabled ? createSystemOneClient() : null
  const l2PromotionProcessor = createL2PromotionProcessor({
    connection: () => db?.connection ?? null,
    llm: llmPort,
    resolveRoute: (sessionId) => configuredRoute ?? sessionRoute(sessionId),
    systemOne: systemOneClient,
    embedding: embeddingClient,
    embeddingModel: resolved.embedding.model ?? null,
    embeddingModelId: embedding.modelId,
    logger: ctx.logger,
  })
  l2Consumer = createInboxConsumer({
    connection: () => db?.connection ?? null,
    gate: idleGate,
    intervalMs: L2_PROMOTION_INTERVAL_MS,
    queue: l2InboxQueue,
    process: l2PromotionProcessor,
    // 让路规则（brief §5.4）：L1 队列还有待处理条目就跳过本轮，慢路径不抢主路径。
    claimGuard: async () => (await l1InboxQueue.countByStatus(db!.connection)).pending === 0,
    logger: ctx.logger,
  })
  l2Consumer.start()
  // 裸 ctx（单测）没有 `on`：可选调用降级为不监听（消费者因闸门恒空闲而空转，无副作用）。
  // 映射本体在 session-events.ts（可单测；写反了宿主级测试看不出来）。
  const sessionEvents = ctx as unknown as SessionEventHost
  sessionEvents.on?.(
    'session/event',
    createSessionEventHandler({ gate: idleGate, promotion: promotionTracker, capture: captureRecorder }),
  )
}

/**
 * dsh-oh-my-whale-memory function 插件入口。
 *
 * 五件套命名导出形态由 PRD §14 / postmortem 0001 锁定：宿主 Loader 只识别命名导出
 * `name`/`inject`/`Config`/`apply`；default export 会让 Loader 丢弃 function 插件命名空间
 * ——本文件禁用 default export。
 *
 * P1-R11 装配拆分：apply 的接线按域搬进 `src/wire/`（访问面 `access`、检索/配额 `retrieval`、
 * 命令 `commands`、工具 `tools`、库与写者锁回收 `lifecycle`、三钩子采集 `capture`、精炼处理器
 * 与回填 `distill`、INBOX 消费链 `inbox`、宿主事件 `events`，共享槽 `runtime`）。本文件只留
 * 导出、配置解析、依赖构造与对 wire 单元的调用。每个 wire 调用单独隔离：一个单元失败只告警，
 * 不拖垮其它单元；成功路径的注册顺序、日志与 disposer 数逐字不变。
 *
 * 既有 story 的接线约束（原样保留）：
 * - Story 1.3：inject 含 `'settings'`（AD-11），Config 填全字段（FR-18），apply 分级校验。
 * - Story 1.4/1.5：profile 专属路径建库、embedding 维度 pin、写者锁**先定角色再开库**
 *   （AD-12/AD-14；LadybugDB 只要存在只读句柄，之后同文件读写打开必失败 Error: 33）。
 * - Story 1.6/1.7：工具与命令在 profileContext 早退之前无条件注册，库未就绪时给明确错误。
 * - Story 2.1/2.2：写者实例的采集钩子与两条 INBOX 消费链；回收挂既有 db effect（closer 数不变）。
 * - Story 3.1/3.2：召回配额按会话键计数，`turn/start` 与 `turn/end` 双点重置。
 *
 * 契约说明：apply 收到的 config 是宿主按 Config schema resolve 出的 volatile 节点对象——顶层
 * 每个字段都是 `.get()` 可调用的 volatile 节点。resolveRuntimeConfig 用 Getter<T> 包装读取，
 * 兼容普通值与 volatile 节点两种形态（便于纯单测直接传 plain object）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveRuntimeConfig } from './config.js'
import { resolveEmbeddingProfile } from './db/embedding-profile.js'
import { resolveMemoryDbPath, ensureMemoryDbDirectory } from './db/paths.js'
import { openMemoryDatabase, type MemoryDatabase } from './db/database.js'
import { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
import { createIdleGate } from './inbox/idle-gate.js'
import { createMemoryAccess } from './wire/access.js'
import { createRetrievalWiring } from './wire/retrieval.js'
import { wireMemoryCommand } from './wire/commands.js'
import { wireMemoryTools } from './wire/tools.js'
import { wireMemoryLifecycle } from './wire/lifecycle.js'
import { wireCapture } from './wire/capture.js'
import { createDistillWiring } from './wire/distill.js'
import { createPromotionWiring, reclaimInboxOnStartup, startInboxConsumers } from './wire/inbox.js'
import { wireSessionEvents } from './wire/events.js'
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
 * `'settings'`：/settings 表单投影与 `/memory status` 的设置读取通道（AD-11）。
 * `'tools'`：工具注册表——memory_remember / memory_recall / memory_related（Story 1.6/3.1/3.2）。
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

  // 单次 apply 的可变装配槽：命令/工具/status 经闭包 getter 读它，teardown 在 dispose 时清回
  // 「未就绪」。绝不放模块级——同进程第二次 apply 会覆盖前一个实例的运行态（评审 P19）。
  const slots = createMemoryRuntimeSlots()
  const getDb = (): MemoryDatabase | undefined => slots.db
  const instance: { readonly: boolean; reason: string | undefined } = { readonly: false, reason: undefined }

  // 单元隔离：一个 wire 失败只告警（与项目既有日志同口径），不拖垮其它单元。
  // 成功路径不产生任何告警——entry-exports 钉死 warn 调用次数。
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

  const access = createMemoryAccess({
    getDb,
    resolved,
    readonlyState: () => instance,
    getSystemOneClient: () => slots.systemOneClient,
  })
  const retrieval = createRetrievalWiring({
    ctx,
    getDb,
    readConnection: access.readConnection,
    resolved,
  })

  // Story 1.6 / 1.7：命令与工具都在 profileContext 早退之前无条件注册（注册是 effect，
  // 自动挂 disposer），共用同一个闭包库句柄——库未就绪时命令给出明确错误、工具给出
  // db_unavailable，可用性不受 profile/建库问题牵连。
  await wireStep('commands', () => wireMemoryCommand(ctx, {
    writeInbox: access.writeInbox,
    listMemories: access.listMemories,
    getMemoryById: access.getMemoryById,
    getStatus: access.getStatus,
    recallMemories: retrieval.recallMemories,
    relatedMemories: retrieval.relatedMemories,
  }))
  // Story 3.1：每轮召回配额的双点重置（只读实例也提供召回，故在只读早退之前注册）；
  // `ctx.on` 自动挂 disposer，**不新增 ctx.effect**（entry-exports 钉死 closer 数）。
  await wireStep('recall-quota', retrieval.wireQuotaReset)
  await wireStep('tools', () => wireMemoryTools(ctx, {
    getDb,
    recallStore: retrieval.recallStore,
    relatedStore: retrieval.relatedStore,
    quota: retrieval.quota,
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
    slots.db = await openMemoryDatabase({
      dbPath,
      dim: embedding.dim,
      modelId: embedding.modelId,
      readOnly: lock.mode === 'readonly',
      // F-06：只读实例的扩展装载失败由此记 warn（写者路径用不到该出口）。
      logger: ctx.logger,
    })
  } catch (error) {
    // 开库失败就不该占着写者锁——释放引用后把原始错误抛给宿主。
    await lock.release()
    throw error
  }

  const readonlyMode = lock.mode === 'readonly'
  runtimeState = { readonly: readonlyMode, reason: lock.reason, dbPath }
  // 本实例状态与模块级运行态同步；导出 memoryRuntimeState() 的语义不变（仍是最近一次成功 apply）。
  instance.readonly = readonlyMode
  instance.reason = lock.reason

  await wireStep('lifecycle', () => wireMemoryLifecycle({ ctx, dbPath, lock, slots }))

  if (readonlyMode) {
    // 只读实例不能改写库级 model id：配置与库内记录不一致时必须显式告知，不静默降级
    // （AD-14 的 fail-loud 精神：不匹配的 embedding 模型会让召回结果按错的模型解释）。
    if (slots.db !== undefined && slots.db.modelId !== embedding.modelId) {
      ctx.logger.warn(
        `只读实例的 embedding 模型与库内记录不一致：库内 ${slots.db.modelId}，配置 ${embedding.modelId}；` +
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
  // 空闲闸门由 session/event 的 turn/start~turn/end 驱动（AD-6），消费者与监听器必须共享同一实例。
  const gate = createIdleGate()
  const promotion = createPromotionWiring({ ctx, getDb })
  await wireStep('inbox-reclaim', () => reclaimInboxOnStartup({ ctx, getDb }))
  // Story 2.1：三钩子采集器 + 孤儿快照重放（AC5）。
  const capture = await wireStep('capture', () => wireCapture({ ctx, dbPath, getDb, resolved }))
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
    await wireStep('session-events', () => wireSessionEvents(ctx, { gate, promotion, capture }))
  }
}

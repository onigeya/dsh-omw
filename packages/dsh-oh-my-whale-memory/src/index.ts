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
import { resolveRuntimeConfig } from './config.js'
import { computeAuditGap } from './db/audit.js'
import { resolveEmbeddingProfile } from './db/embedding-profile.js'
import { resolveMemoryDbPath, ensureMemoryDbDirectory } from './db/paths.js'
import { openMemoryDatabase, type MemoryDatabase } from './db/database.js'
import { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
import { countMemoriesByLayer, getMemoryById as readMemoryById, listMemories as readMemories } from './db/memory.js'
import {
  createMemoryCommandDefinition,
  type MemoryCommandDependencies,
  type MemoryCommandsRuntime,
  type MemoryInboxWriteOptions,
  type MemoryStatusSnapshot,
} from './command.js'
import { createMemoryRememberTool, MEMORY_REMEMBER_LAYER } from './tools/memory-remember.js'

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
 */
export const inject = ['commands', 'settings', 'tools'] as const

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

  // Story 1.6 / 1.7：命令与工具都在 profileContext 早退之前无条件注册（注册是 effect，
  // 自动挂 disposer），两者共用闭包可变量 `db`——库未就绪时命令给出明确错误、
  // 工具给出 db_unavailable，可用性不受 profile/建库问题牵连。
  let db: MemoryDatabase | undefined
  // Story 1.9：本实例自身的只读态。模块级 `runtimeState` 只表示「最近一次成功 apply」，
  // 同进程再次 apply 会让本实例的命令读到别的实例的锁结果，故 getStatus 只读这份局部值。
  let instanceReadonly = false
  let instanceReadonlyReason: string | undefined
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
    const counts = await countMemoriesByLayer(readConnection().connection)
    const auditGap = await computeAuditGap(readConnection().connection)
    return {
      layers: { L1: counts.L1, L2: counts.L2 },
      inboxes: { L1: counts.L1_INBOX, L2: counts.L2_INBOX },
      failed: 0,
      embeddingMode: resolved.embeddingMode,
      readonly: instanceReadonly,
      readonlyReason: instanceReadonlyReason,
      auditGap,
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
  ctx.effect(() => () => db?.close(), 'omw-memory-db')
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
}

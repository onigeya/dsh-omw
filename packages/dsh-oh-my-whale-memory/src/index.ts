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
 * Story 1.7：apply 注册宿主命令 `/memory`（子命令 `remember`）把文本写入 L1 收件箱；
 * 命令在 profileContext 早退之前无条件注册（库未就绪时返回明确错误，AC4），`db`
 * 经闭包可变量交给 handler。
 *
 * 契约说明：apply 收到的 config 是宿主根据 Config schema resolve 出的 volatile
 * 节点对象——顶层每个字段都是 `.get()` 可调用的 volatile 节点。
 * resolveRuntimeConfig 用 Getter<T> 包装读取，兼容普通值与 volatile 节点两种形态
 * （便于纯单测直接传 plain object）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveRuntimeConfig } from './config.js'
import { resolveEmbeddingProfile } from './db/embedding-profile.js'
import { resolveMemoryDbPath, ensureMemoryDbDirectory } from './db/paths.js'
import { openMemoryDatabase, type MemoryDatabase } from './db/database.js'
import { acquireWriterLock, READONLY_REASON } from './db/writer-lock.js'
import { createMemoryRememberDefinition, type MemoryCommandsRuntime } from './command.js'

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
  MEMORY_REMEMBER_SUBCOMMAND,
  MEMORY_REMEMBER_USAGE,
  createMemoryRememberDefinition,
  parseRememberInput,
} from './command.js'
export type {
  MemoryCommandDefinition,
  MemoryCommandInvocation,
  MemoryCommandResult,
  MemoryRememberDependencies,
} from './command.js'

/** cordis 模块名（AD-2，永不重命名）；与 settings namespace 一致。 */
export const name = 'dsh-oh-my-whale-memory' as const

/**
 * 本插件向宿主注入的能力清单。
 * `'commands'`：`/memory` 宿主命令（Story 1.7）。
 * `'settings'`：/settings 表单投影与后续 /memory status 的设置读取通道（AD-11）。
 */
export const inject = ['commands', 'settings'] as const

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

  // Story 1.7：命令无条件注册（早于 profileContext 早退），库未就绪时给出明确错误
  // 而非静默"命令不存在"（AC4 可观测性）。facade 经闭包可变量取当前 db；
  // effect 工厂必须返回可调用 disposer——宿主 commands 服务缺失（裸 ctx）时退化为 no-op。
  let db: MemoryDatabase | undefined
  const writeL1Inbox = async (text: string): Promise<void> => {
    if (!db) {
      throw new Error('记忆库未就绪：无 profile 归属或建库未完成，当前无法写入 L1_INBOX')
    }
    // Epic 1 无 embedding 客户端：三列 embedding/embedding_model_id/embedding_dim
    // 同落 NULL（不写零向量污染 HNSW cosine 索引），Story 2.3 引入客户端后回填。
    await db.upsertMemory({ layer: 'L1_INBOX', text, embedding: null, embeddingModelId: null })
  }
  ctx.effect(
    () => {
      const commands = ctx.get?.('commands') as MemoryCommandsRuntime | undefined
      return commands?.register(createMemoryRememberDefinition({ writeInbox: writeL1Inbox })) ?? (() => {})
    },
    'omw-memory-command',
  )

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
  let opened: MemoryDatabase
  try {
    // AC5：维度不符在 openMemoryDatabase 内抛 embedding_dim_mismatch，阻塞本插件启动。
    opened = await openMemoryDatabase({
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

  runtimeState = { readonly: lock.mode === 'readonly', reason: lock.reason, dbPath }

  // 注册都是 effect：自己打开的资源必须挂 disposer 由宿主统一释放。
  ctx.effect(() => () => opened.close(), 'omw-memory-db')
  ctx.effect(() => () => lock.release(), 'omw-memory-writer-lock')

  // Story 1.7：建库成功才把 facade 交给命令闭包；此前 `/memory remember` 得到"记忆库未就绪"。
  // 只读实例同样赋值——写入由 facade 抛 readonly_mode，命令 handler 转成明确错误（Story 1.5 / AC2）。
  db = opened

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

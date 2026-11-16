/**
 * 模型工具注册（Story 1.6 / 3.1 / 3.2 / 4.1 / 8.2）。
 *
 * 五个工具都在建库之前注册，闭包 getter 在库未就绪时返回 undefined → 调用得到
 * `db_unavailable`，因此工具可用性不受 profile / 建库问题牵连。
 *
 * 注册顺序被 `test/entry-exports.test.ts` 钉死：remember → recall → related → forget → expand
 * （Story 8.2 追加在末尾，不改既有顺序）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDatabase } from '../db/database.js'
import { getMemoryById } from '../db/memory.js'
import { createMemoryRememberTool } from '../tools/memory-remember.js'
import { createMemoryRecallTool, type MemoryRecallStore } from '../tools/memory-recall.js'
import { createMemoryRelatedTool, type MemoryRelatedStore } from '../tools/memory-related.js'
import { createMemoryForgetTool } from '../tools/memory-forget.js'
import { createMemoryExpandTool } from '../tools/memory-expand.js'
import type { RecallQuota } from '../tools/recall-quota.js'

export interface MemoryToolsOptions {
  readonly getDb: () => MemoryDatabase | undefined
  readonly recallStore: MemoryRecallStore
  readonly relatedStore: MemoryRelatedStore
  /** 召回族（recall + related + expand）共享的每轮配额实例。 */
  readonly quota: RecallQuota
  /** Story 8.2：当前会话 id（用于句柄的 `session_mismatch` 判定）；缺省不判越权。 */
  readonly sessionId?: () => string
  /** Story 8.2：结果折叠配置（缺省 = 不折叠）。 */
  readonly fold?: {
    readonly thresholdTokens: number
    readonly readonly: boolean
    readonly write: (input: {
      readonly sessionId: string
      readonly seq: number
      readonly text: string
      readonly tokens: number
    }) => Promise<{ readonly id: string }>
    readonly logger?: { warn(message: string): void }
  }
}

export function wireMemoryTools(ctx: Context, options: MemoryToolsOptions): void {
  const { getDb } = options
  ctx.tools.register(createMemoryRememberTool(() => getDb()))
  ctx.tools.register(createMemoryRecallTool({
    // 库未就绪（无 profile / 建库未完成）⇒ undefined ⇒ db_unavailable 失败信封。
    getRecallStore: () => (getDb() === undefined ? undefined : options.recallStore),
    quota: options.quota,
  }))
  ctx.tools.register(createMemoryRelatedTool({
    // 只读实例的遍历是纯读路径，照样可用；库未就绪时同样返回 db_unavailable。
    getRelatedStore: () => (getDb() === undefined ? undefined : options.relatedStore),
    quota: options.quota,
    // Story 8.2：结果超阈值 ⇒ 折成句柄（readOnly 由 foldToolResult 内部判定）。
    fold: options.fold,
  }))
  ctx.tools.register(createMemoryForgetTool({
    // 遗忘工具不写库：它只把 id 解析成预览并请求用户确认（执行通道不存在，Story 4.1）。
    // 只读态由 facade 的运行态直接给出，工具层据此在查库之前拒掉。
    getForgetStore: () => {
      const database = getDb()
      if (database === undefined) return undefined
      return {
        readonly: database.readonly,
        preview: async (id) => {
          const detail = await getMemoryById(database.connection, id)
          return detail === null ? null : { id: detail.id, layer: detail.layer, text: detail.text }
        },
      }
    },
  }))
  // Story 8.2：`memory_expand` 与 recall / related 共享同一配额实例（FR-10 合计 ≤3/轮）。
  // 只读实例照常可用：它只读句柄节点，不写任何东西（INV-7）。
  ctx.tools.register(createMemoryExpandTool({
    getDb: () => getDb(),
    quota: options.quota,
    sessionId: options.sessionId,
  }))
}

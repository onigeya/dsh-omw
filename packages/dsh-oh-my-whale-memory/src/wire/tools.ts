/**
 * 模型工具注册（Story 1.6 / 3.1 / 3.2）。
 *
 * 三个工具都在建库**之前**注册，闭包 getter 在库未就绪时返回 undefined → 调用得到
 * `db_unavailable`，因此工具可用性不受 profile/建库问题牵连。
 * 注册顺序被 `test/entry-exports.test.ts` 钉死：remember → recall → related。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDatabase } from '../db/database.js'
import { createMemoryRememberTool } from '../tools/memory-remember.js'
import { createMemoryRecallTool, type MemoryRecallStore } from '../tools/memory-recall.js'
import { createMemoryRelatedTool, type MemoryRelatedStore } from '../tools/memory-related.js'
import type { RecallQuota } from '../tools/recall-quota.js'

export interface MemoryToolsOptions {
  readonly getDb: () => MemoryDatabase | undefined
  readonly recallStore: MemoryRecallStore
  readonly relatedStore: MemoryRelatedStore
  /** 召回族（recall + related）共享的每轮配额实例。 */
  readonly quota: RecallQuota
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
  }))
}

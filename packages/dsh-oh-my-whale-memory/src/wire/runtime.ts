/**
 * 单次 apply 的可变装配槽：wire 单元之间唯一共享的可变状态。
 *
 * 为什么不做成模块级：Story 2.5 / 评审 P19 的教训——同进程第二次 apply 会重新同步配置，
 * 模块级的运行态会被新实例覆盖（第一实例的候选收到新配置的 disabled-by-config）。
 * 所以每个 apply 一份 slots，命令/工具/状态经闭包 getter 读它，teardown 在 dispose 时
 * 把它清回「未就绪」，而不是留一个已关闭句柄上的半可用连接。
 */
import type { MemoryDatabase } from '../db/database.js'
import type { InboxConsumer } from '../inbox/consumer.js'
import type { SystemOneClient } from '../distill/system-one.js'

export interface MemoryRuntimeSlots {
  /** 库句柄：openMemoryDatabase 成功后写入，teardown 清空。 */
  db: MemoryDatabase | undefined
  /** System One 客户端：只读实例保持 null（状态按配置渲染）。 */
  systemOneClient: SystemOneClient | null
  /** L1 主路径消费者（只有写者实例创建并启动）。 */
  inboxConsumer: InboxConsumer | null
  /** L2 提升慢循环消费者（与 L1 同挂 db effect 的 disposer）。 */
  l2Consumer: InboxConsumer | null
}

export function createMemoryRuntimeSlots(): MemoryRuntimeSlots {
  return { db: undefined, systemOneClient: null, inboxConsumer: null, l2Consumer: null }
}

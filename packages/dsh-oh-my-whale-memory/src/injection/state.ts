/**
 * 新会话注入的**每会话状态机骨架**（Story 3.3 / B1；完整生成在 B2）。
 *
 * 状态语义（spec D3）：
 * - `pending`：已识别到该会话的首条真人消息、摘要生成进行中（或待 B2 接线）；
 * - `ready`：可注入文本已就绪（空串 = 生成成功但无可注入内容/命中为空）；
 * - `skipped`：本会话不注入（Config 关闭 / 非真人首条 / 无 llm 路由等降级终态）。
 *
 * 键复用 `inboxSessionKey`（与配额/采集同一套会话键）。纯内存、不落盘（AC:916「不缓存」：
 * 进程内一次性状态，重启即新会话）。B1 只提供最小读写面，不做生成。
 */

/** 注入状态（spec D3 的三态最小形态）。 */
export type InjectionStatus = 'pending' | 'ready' | 'skipped'

/** 单会话注入记录。 */
export interface InjectionRecord {
  readonly status: InjectionStatus
  /** 可注入文本；仅 `ready` 时可能非空。 */
  readonly text: string
}

/** 每会话注入状态存储（B2 的生成器写入、`prompt.ts` 的 provider 读取）。 */
export interface InjectionStore {
  /** 读记录；未识别过的会话返回 undefined。 */
  read(sessionKey: string): InjectionRecord | undefined
  /** 标记「已识别的首条真人消息、生成进行中」；重复调用幂等（不覆盖已有 ready）。 */
  markPending(sessionKey: string): void
  /** 生成完成（`text` 可为空串 = 无可注入内容）。 */
  markReady(sessionKey: string, text: string): void
  /** 本会话不注入（配置关闭/降级终态）。 */
  markSkipped(sessionKey: string): void
  /** provider 用：当前可注入文本；非 ready 或空串一律返回 ''（宿主对空文本不产消息）。 */
  textFor(sessionKey: string): string
  /** 清理会话（`session/disposed` 时调用，有界内存；B1 只提供原语）。 */
  reset(sessionKey: string): void
}

/** 构造每会话注入状态存储（进程内 Map；键数受活跃/历史会话数约束）。 */
export function createInjectionStore(): InjectionStore {
  const records = new Map<string, InjectionRecord>()
  return {
    read(sessionKey) {
      return records.get(sessionKey)
    },
    markPending(sessionKey) {
      // 已有终态（ready/skipped）时不回退——「每会话一次」由状态机保证（AC:916）。
      if (records.has(sessionKey)) return
      records.set(sessionKey, { status: 'pending', text: '' })
    },
    markReady(sessionKey, text) {
      records.set(sessionKey, { status: 'ready', text })
    },
    markSkipped(sessionKey) {
      records.set(sessionKey, { status: 'skipped', text: '' })
    },
    textFor(sessionKey) {
      const record = records.get(sessionKey)
      return record?.status === 'ready' ? record.text : ''
    },
    reset(sessionKey) {
      records.delete(sessionKey)
    },
  }
}

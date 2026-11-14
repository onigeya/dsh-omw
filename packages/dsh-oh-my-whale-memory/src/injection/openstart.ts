/**
 * 新会话开局注入的**生成编排**（Story 3.3 / B2）：首条真人消息 → recall(top-8) → 摘要 LLM →
 * 注入状态。降级阶梯见 spec D2；本模块不含预算裁剪（B3）与 `/memory status` 标注（B4）。
 *
 * 关键纪律：
 * - **LLM 单通道**：只经 `ctx.llm.stream()`（AD-5），显式 provider+model（Config 优先，
 *   否则 `routeFromSession` 回退链）；**单次尝试不重试**（3s 预算 + 有降级路径，§14）；
 * - **prompt 与输出 schema 同文件**（§14，sentinel preamble）；输出 `{summary, evidence_ids}`，
 *   evidence_ids 只允许取本次召回候选的 id（不信任模型）；
 * - **不写库**：生成过程纯读 + 内存状态（spec Never：注入热路径不同步写库/不写 generation_log）；
 * - **每会话一次**：进入前查 `InjectionStore`，pending/ready/skipped 一律短路（AC:916）。
 */
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { routeFromSession } from '../distill/session-route.js'
import { foldStream } from '../distill/stream-fold.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import type { RecallCoreResult, RecallResultItem } from '../recall/core.js'
import {
  applyInjectionBudget,
  isInviolableItem,
  type InjectionBudgetResult,
  type InjectionDraft,
} from './budget.js'
import type { InjectionStore, LastInjectionSummary } from './state.js'

/** 摘要输入的召回条数（AC:915：输入为 recall(top-K=8)）。 */
export const OPENSTART_RECALL_TOP_K = 8
/** 首条真人消息参与检索的最大字符数（超长消息只取前缀，避免把整段对话当查询）。 */
export const OPENSTART_MAX_QUERY_CHARS = 1000
/** 摘要生成硬上限（AC:934 / NFR1；超时即降级，不阻塞首响应）。 */
export const OPENSTART_LLM_TIMEOUT_MS = 3000
/** 摘要输出 token 上限（AC:916：摘要 ≤ 512 tokens）。 */
export const OPENSTART_MAX_OUTPUT_TOKENS = 512
/** 结构化输出 sentinel preamble（§14）。 */
export const OPENSTART_SENTINEL_PREAMBLE = 'Field descriptions are never valid values; set them to null'

/** 输出 schema（与 prompt 同文件保存；改 prompt 必须同步改 schema，§14）。 */
export const OPENSTART_OUTPUT_SCHEMA = JSON.stringify({
  summary: 'string — 原则优先的开局摘要（≤512 tokens）；候选无关时给空串',
  evidence_ids: 'string[] — 只能取候选列表里的 id；无证据给空数组',
})

/** 指令文本（与 schema 同文件；sentinel 在首行）。 */
export const OPENSTART_INSTRUCTION = [
  OPENSTART_SENTINEL_PREAMBLE,
  '',
  '你是记忆开局摘要器。输入：用户本会话的首条消息 + 从长期记忆召回的候选（L2 原则在前、L1 证据在后）。',
  '任务：产出一段帮助 Agent 开局的摘要。要求：',
  '- summary：原则优先（用户偏好/既往决策/硬约束在前），再给必要细节；不编造候选之外的内容；候选与该消息无关时给空串；',
  '- evidence_ids：引用到的候选 id（只能来自候选列表，不得编造）；',
  '- 只输出 JSON，形如 {"summary": string, "evidence_ids": string[]}。',
  '',
  '输出 JSON schema：',
  OPENSTART_OUTPUT_SCHEMA,
].join('\n')

/** 召回端口（结构声明，与 `MemoryRecallStore` 同形；单测注入假实现）。 */
export interface OpenstartRecallPort {
  readonly embeddingEnabled: boolean
  embedQuery(query: string, signal?: AbortSignal): Promise<readonly number[] | null>
  recall(input: {
    readonly query: string
    readonly queryVector: readonly number[] | null
    readonly limit: number
  }): Promise<RecallCoreResult>
}

/** LLM 端口（只用到 ctx.llm.stream 的结构端口；运行期不 import 宿主值）。 */
export interface OpenstartLlmPort {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: RequestMessage[]
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

export interface OpenstartRoute {
  readonly provider: string
  readonly model: string
}

/** pre-step payload 的最小结构视图（只取 messages/agent.session）。 */
export interface OpenstartMessageLike {
  readonly role?: string
  readonly source?: { readonly kind?: unknown }
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

export interface OpenstartPreStepPayload {
  readonly messages?: readonly OpenstartMessageLike[]
  readonly agent?: { readonly session?: unknown }
}

export interface OpenstartGeneratorOptions {
  readonly store: InjectionStore
  readonly recall: OpenstartRecallPort
  /** 惰性取 ctx.llm（apply 期间不求值，N2）；缺失 ⇒ 本会话 skipped（零 LLM）。 */
  readonly getLlm: () => OpenstartLlmPort | undefined
  /** Config 开关 `injectOnNewSession`；false ⇒ 完全跳过（零 recall、零 LLM，AC:945-947）。 */
  readonly enabled: () => boolean
  /** 路由：Config 的 llmProvider/llmModel 优先，缺省 `routeFromSession` 回退链（AC:567）。 */
  readonly resolveRoute?: (session: unknown) => OpenstartRoute | null
  readonly logger?: {
    warn(message: string): void
    /** 结构化观测单行（fire-and-forget；注入完成时调用，B4）。 */
    info?(message: string): void
  }
  /** 覆盖默认超时/条数（测试注入）。 */
  readonly timeoutMs?: number
  readonly topK?: number
  /** 时钟（观测用：`at` / `elapsedMs`；测试注入固定时间）。 */
  readonly now?: () => Date
}

/** 摘要输出解析结果。 */
export interface OpenstartSummary {
  readonly summary: string
  readonly evidenceIds: readonly string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取消息的纯文本（block 里的 text 拼接）。 */
function messageText(message: OpenstartMessageLike): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
    .join('\n')
}

/** 候选 → prompt 文本（**确定性**：沿用召回顺序；id 与 layer 明示）。 */
export function formatCandidates(results: readonly RecallResultItem[]): string {
  return results.map((item) => `- [${item.layer}] ${item.id}: ${item.text}`).join('\n')
}

/** 组装 LLM 消息（prompt 与 schema 同文件，§14）。 */
export function buildOpenstartMessages(query: string, results: readonly RecallResultItem[]): RequestMessage[] {
  const instruction = [
    OPENSTART_INSTRUCTION,
    '',
    '用户首条消息：',
    query,
    '',
    '召回候选：',
    formatCandidates(results),
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 解析模型输出；非 JSON / summary 空 / 结构不符 ⇒ null（调用方走 L1 降级）。 */
export function parseOpenstartOutput(text: string, allowedIds: ReadonlySet<string>): OpenstartSummary | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const record = parsed as { summary?: unknown; evidence_ids?: unknown } | null
  const summary = typeof record?.summary === 'string' ? record.summary.trim() : ''
  if (summary === '') return null
  const ids = Array.isArray(record?.evidence_ids) ? record.evidence_ids : []
  // 不信任模型：只保留本次真实召回到的 id（去重、保序）。
  const evidenceIds: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !allowedIds.has(id) || evidenceIds.includes(id)) continue
    evidenceIds.push(id)
  }
  return { summary, evidenceIds }
}

/**
 * 结构化注入草稿（B3：先产出结构，再由 `budget.ts` 唯一裁剪并渲染）。
 * - `inviolable`（INV-2）：`priority === -1` 或 `kind === 'instruction'`，不受任何预算裁剪；
 * - `evidence`：非不可删的 L2（原则/综合陈述）；
 * - `l1`：非不可删的 L1（证据原文）。
 */
export function buildInjectionDraft(args: {
  readonly results: readonly RecallResultItem[]
  readonly summary?: string
}): InjectionDraft {
  const inviolable = args.results.filter(isInviolableItem)
  const rest = args.results.filter((item) => !isInviolableItem(item))
  return {
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    evidence: rest.filter((item) => item.layer === 'L2'),
    l1: rest.filter((item) => item.layer === 'L1'),
    inviolable,
  }
}

/** 单次摘要 LLM 调用；任何失败（超时/异常/不可解析）返回 null（不重试）。 */
async function generateSummary(args: {
  readonly llm: OpenstartLlmPort
  readonly route: OpenstartRoute
  readonly messages: RequestMessage[]
  readonly allowedIds: ReadonlySet<string>
  readonly timeoutMs: number
}): Promise<OpenstartSummary | null> {
  const signal = AbortSignal.timeout(args.timeoutMs)
  try {
    const folded = await foldStream(args.llm.stream({
      provider: args.route.provider,
      model: args.route.model,
      messages: args.messages,
      maxTokens: OPENSTART_MAX_OUTPUT_TOKENS,
      signal,
    }))
    return parseOpenstartOutput(folded.text.trim(), args.allowedIds)
  } catch {
    return null
  }
}

/**
 * 构造 pre-step 监听器：`(payload) => Promise<void>`（宿主 waterfall 会 await，故 3s 预算是
 * 「首个请求前最多等 3s」，超时即降级；详见 spec D2）。
 */
export function createOpenstartGenerator(
  options: OpenstartGeneratorOptions,
): (payload: OpenstartPreStepPayload) => Promise<void> {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? OPENSTART_LLM_TIMEOUT_MS))
  const topK = Math.max(1, Math.trunc(options.topK ?? OPENSTART_RECALL_TOP_K))
  const now = options.now ?? (() => new Date())

  /**
   * 收尾：预算裁剪（唯一裁剪点 `budget.ts`）→ 写 ready → 记录 `lastInjection` 观测摘要
   * （进程内、不持久化；B4 的 `/memory status` 读取）→ 结构化观测单行。文本为空 ⇒ 视为零注入 skipped。
   */
  const finalize = (key: string, draft: InjectionDraft, degraded: boolean, startedAt: Date): void => {
    const budget: InjectionBudgetResult = applyInjectionBudget(draft)
    if (budget.text === '') {
      options.store.markSkipped(key)
      return
    }
    options.store.markReady(key, budget.text)
    const finishedAt = now()
    const summary = {
      sessionKey: key,
      items: budget.items.length,
      chars: budget.chars,
      degraded,
      truncated: budget.truncated,
      overBudget: budget.overBudget,
      keptInviolable: budget.keptInviolable,
      unit: 'chars' as const,
      elapsedMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      at: finishedAt.toISOString(),
    }
    options.store.setLastInjection(summary)
    // Story 3.3 / B4b：观测事件——结构化单行，fire-and-forget（**不**写 generation_log、
    // 不含原文/凭据、不阻塞主路径）。logger 自身抛错只吞掉，绝不影响已完成的注入结果。
    try {
      options.logger?.info?.(
        'injection: ' +
        `items=${summary.items} chars=${summary.chars} degraded=${String(summary.degraded)} ` +
        `truncated=${String(summary.truncated)} overBudget=${String(summary.overBudget)} ` +
        `keptInviolable=${summary.keptInviolable} elapsedMs=${summary.elapsedMs} unit=${summary.unit}`,
      )
    } catch {
      // 观测是 best-effort（NFR8）：失败不影响注入结果，也不冒泡。
    }
  }

  return async (payload) => {
    const messages = payload.messages ?? []
    // 只认白名单 'user'（合成来源如 'runtime-context' 不算首条真人消息；来源表 merge-extensible）。
    const human = messages.find((message) => message.source?.kind === 'user')
    if (human === undefined) return

    const key = inboxSessionKey(payload.agent?.session)
    // 每会话一次：pending（生成中）/ready/skipped 一律短路（AC:916）。
    if (options.store.read(key) !== undefined) return
    options.store.markPending(key)
    const startedAt = now()

    // Config 关闭 ⇒ 零 recall、零 LLM（AC:945-947）。
    if (!options.enabled()) {
      options.store.markSkipped(key)
      return
    }

    const query = messageText(human).trim().slice(0, OPENSTART_MAX_QUERY_CHARS)
    if (query === '') {
      options.store.markSkipped(key)
      return
    }

    // recall：不重写检索，直接复用 3.1 的内核；embedding 不可用/失败 ⇒ 关键词单路仍可用。
    // F-03 顺序（AC:937-939 / I/O 矩阵 / D12）：Config 关闭 → skip；否则先 recall，
    // **只有召回命中为空才零注入**；无 llm/无路由属于「摘要生成失败」，走仅 L1 降级。
    let recalled: RecallCoreResult
    try {
      let queryVector: readonly number[] | null = null
      if (options.recall.embeddingEnabled) {
        try {
          queryVector = await options.recall.embedQuery(query)
        } catch {
          queryVector = null
        }
      }
      recalled = await options.recall.recall({ query, queryVector, limit: topK })
    } catch (error) {
      options.logger?.warn(`开局注入跳过：召回失败（${errorMessage(error)}）`)
      options.store.markSkipped(key)
      return
    }

    const results = recalled.results
    if (results.length === 0) {
      // 召回命中为空 ⇒ 零注入（AC:928-930；唯一允许零注入的路径）。
      options.store.markSkipped(key)
      return
    }
    const draft = buildInjectionDraft({ results })
    const l1 = results.filter((item) => item.layer === 'L1')
    const hasL2 = results.some((item) => item.layer === 'L2')
    if (!hasL2) {
      // 无 L2 命中 ⇒ 降级仅 L1（AC:924-926）；不调 LLM（预算仍走唯一裁剪点）。
      finalize(key, { ...draft, evidence: [] }, true, startedAt)
      return
    }

    // F-03：无 ctx.llm / 无路由（Config 未配且 session 无已记录目标）不是「跳过」，而是
    // 「摘要生成失败」——直接走仅 L1 降级（不调 LLM、不报错），与超时/失败同一阶梯。
    const llm = options.getLlm()
    const route = llm === undefined
      ? null
      : (options.resolveRoute?.(payload.agent?.session) ?? routeFromSession(payload.agent?.session))
    if (llm === undefined || route === null) {
      if (llm !== undefined) {
        options.logger?.warn('开局注入摘要降级：无法解析 LLM 路由（无 Config llmProvider/llmModel，session 也无已记录请求目标），仅注入 L1 原文')
      }
      if (l1.length === 0) {
        options.logger?.warn('开局注入跳过：摘要不可用且无 L1 证据可降级')
        options.store.markSkipped(key)
        return
      }
      finalize(key, { ...buildInjectionDraft({ results }), evidence: [] }, true, startedAt)
      return
    }

    const summary = await generateSummary({
      llm,
      route,
      messages: buildOpenstartMessages(query, results),
      allowedIds: new Set(results.map((item) => item.id)),
      timeoutMs,
    })
    if (summary !== null) {
      finalize(key, buildInjectionDraft({ results, summary: summary.summary }), false, startedAt)
      return
    }
    // 摘要失败/超时/不可解析 ⇒ 阶梯降级：仅 L1 原文；L1 也为空 ⇒ 无注入（AC:937-939）。
    if (l1.length === 0) {
      options.logger?.warn('开局注入跳过：摘要生成失败且无 L1 证据可降级')
      options.store.markSkipped(key)
      return
    }
    finalize(key, { ...buildInjectionDraft({ results }), evidence: [] }, true, startedAt)
  }
}

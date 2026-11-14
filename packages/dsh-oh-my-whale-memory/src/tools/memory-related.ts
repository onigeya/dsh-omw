/**
 * memory_related 工具（Story 3.2 / FR-12 图遍历召回）。
 *
 * 契约：
 * - 参数 `id`（必填 string）/ `depth`（可选 integer；缺省 2、夹紧 [1,3]，AC:875）；
 * - 成功值 `{ id, depth, total, results:[{id,layer,hops,edge_type,reason?,text,truncated?,invalid?,invalid_at?,expired_at?}], hint?, partial? }`；
 * - 失败值 `{ action:'failed', error:{code,message,retryable} }`——**绝不 throw**（宿主把 throw 渲染成 isError）；
 * - execute 顺序：空白 id 参数错误（不耗配额）→ 判库（db_unavailable，不耗配额）→ 配额（与
 *   memory_recall 同一实例/同一桶）→ 遍历（含 depth=1 超时降级）→ 失败信封。
 *
 * hint 语义（spec D4/D5/D8）：
 * - 起点不存在 ⇒ 成功值空结果 + `hint:'未找到该记忆。'`（AC:882-884）；
 * - 结果非空但**所有**邻居 `pathValid=false` ⇒ 空结果 + `hint:'evidence expired'`（AC:889）；
 * - 超时后 depth=1 重试成功 ⇒ `partial:true` + `hint:'partial'`（AC:891-893）；
 * - 起点自身失效 ⇒ hint 追加「起点已失效」（spec D5 ②，不拦截遍历）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  clampRelatedDepth,
  RelatedTraversalTimeoutError,
  type RelatedTraversalItem,
  type RelatedTraversalResult,
} from '../db/edges.js'
import { MemoryDbError } from '../db/errors.js'
import { truncateRecallText } from '../recall/core.js'
import { summarizeMemoryText } from '../summarize.js'
import { failedEnvelope, quotaOwnerOf, type ToolFailure } from './recall-shared.js'
import type { RecallQuota } from './recall-quota.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_RELATED_TOOL_NAME = 'memory_related'

/**
 * 单次遍历预算（spec D8：300ms 观测口径，非硬 SLA）。
 * depth=1 重试使用**独立预算**（同一 timeoutMs）⇒ 最坏总预算 ≤ 2×本值。
 */
export const RELATED_TRAVERSAL_TIMEOUT_MS = 300

export const MEMORY_RELATED_TOOL_DESCRIPTION = [
  '沿证据链与语义关系网遍历一条记忆的邻居（EVIDENCE + RELATED 无向 BFS，原生 openCypher 变长路径）。',
  'id 传已知记忆的 id（可从 memory_recall 结果取）；depth 可选，缺省 2、上限 3。',
  '返回按跳数升序的邻居（上限 20 条），每条含 id/layer/hops/edge_type/reason/text；单条超 256 token 时截断并标 truncated=true。',
  '失效节点可被穿过并出现在结果里（标 invalid），但默认只在有效邻居不足 20 条时补入；全无有效路径时返回 evidence expired 空结果。',
  '同一回合召回族工具合计最多 3 次（与 memory_recall 共享额度），超出返回 quota_exceeded；遍历超时会降级为 1 跳并标 partial。',
].join('\n')

/**
 * 遍历能力端口（结构声明，单测注入假实现；生产实现见 src/index.ts 的 store）：
 * `traverse` 直接转发 `db/edges.ts` 的 `traverseRelated`。
 */
export interface MemoryRelatedStore {
  traverse(input: {
    readonly id: string
    readonly depth?: number
    readonly timeoutMs?: number
  }): Promise<RelatedTraversalResult>
}

export interface MemoryRelatedToolOptions {
  /** 取当前遍历能力（闭包 getter：apply 先注册工具再建库，未就绪返回 undefined）。 */
  readonly getRelatedStore: () => MemoryRelatedStore | undefined
  /** 每轮配额（与 memory_recall 同一实例；`turn/start`/`turn/end` 双点重置）。 */
  readonly quota: RecallQuota
}

/** 成功值里的一条邻居（字段名与 AC:880 对齐：edge_type 用 snake_case）。 */
export interface MemoryRelatedResultEntry {
  readonly id: string
  readonly layer: string
  readonly hops: number
  readonly edge_type: 'EVIDENCE' | 'RELATED'
  readonly reason?: string
  readonly text: string
  readonly truncated?: boolean
  readonly invalid?: boolean
  readonly invalid_at?: string
  readonly expired_at?: string
}

export interface MemoryRelatedSucceeded {
  readonly id: string
  readonly depth: number
  /** 去重归并后（20 条截断前）的邻居总数；evidence expired 空结果时为 0。 */
  readonly total: number
  results: MemoryRelatedResultEntry[]
  readonly hint?: string
  /** true = 遍历超时后以 depth=1 返回的部分结果（AC:891-893）。 */
  readonly partial?: boolean
}

/** 失败分支的 canonical 形态与 memory_recall 同源（tools/recall-shared.ts）。 */
export type MemoryRelatedFailed = ToolFailure

export type MemoryRelatedValue = MemoryRelatedSucceeded | MemoryRelatedFailed

/** 类型守卫：成功分支没有 `action` 字段。 */
function isRelatedFailed(value: MemoryRelatedValue): value is MemoryRelatedFailed {
  return (value as { readonly action?: unknown }).action === 'failed'
}

const PARAMETERS = {
  id: {
    type: 'string',
    required: true,
    description: '起点记忆的 id（uuid5；可从 memory_recall 的结果里取）。',
  },
  depth: {
    type: 'integer',
    description: '遍历跳数 1..3，缺省 2；越界自动夹紧。',
  },
} as const satisfies ParameterSchemaSpec

/** 输出 schema：oneOf 钉死成功/失败两个 canonical 形态（照 memory-recall）。 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        id: { type: 'string', required: true, description: '起点记忆 id（回显）' },
        depth: { type: 'integer', required: true, description: '实际使用的跳数（夹紧后）' },
        total: { type: 'integer', required: true, description: '去重归并后（20 条截断前）的邻居总数' },
        results: {
          type: 'array',
          required: true,
          description: '邻居记忆，按跳数升序（上限 20；失效节点仅在有效不足时补入）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '邻居记忆 id' },
              layer: { type: 'string', required: true, description: '记忆层（L1 / L2）' },
              hops: { type: 'integer', required: true, description: '从起点到该邻居的跳数（1..depth）' },
              edge_type: { type: 'string', required: true, description: '最后一跳的边类型：EVIDENCE 或 RELATED' },
              reason: { type: 'string', description: '最后一跳边上的 reason（无则省略）' },
              text: { type: 'string', required: true, description: '记忆原文（超长时已截断为摘要预览）' },
              truncated: { type: 'boolean', description: 'true = 原文超 256 token，已截断（按 id 可另查全文）' },
              invalid: { type: 'boolean', description: 'true = 该邻居自身已失效（invalid_at/expired_at 非空）' },
              invalid_at: { type: 'string', description: '失效时间（仅 invalid=true 时出现）' },
              expired_at: { type: 'string', description: '过期时间（仅 expired=true 时出现）' },
            },
          },
        },
        hint: { type: 'string', description: '说明：未找到该记忆 / evidence expired / partial / 起点已失效' },
        partial: { type: 'boolean', description: 'true = 遍历超时，已降级为 depth=1 的部分结果' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'failed', required: true, description: '遍历失败' },
        error: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            code: { type: 'string', required: true, description: '封闭错误码：invalid_query、quota_exceeded、db_read_failed、db_unavailable 或其它 db 层码' },
            message: { type: 'string', required: true, description: '诊断信息，不含凭据' },
            retryable: { type: 'boolean', required: true, description: '是否值得重试' },
          },
        },
      },
      additionalProperties: false,
    },
  ],
} as const satisfies ValueSchemaSpec

/** 空结果 hint：起点不存在（AC:882-884）。 */
export const RELATED_HINT_START_MISSING = '未找到该记忆。'
/** 无有效证据链（AC:889）。 */
export const RELATED_HINT_EVIDENCE_EXPIRED = 'evidence expired'
/** 超时降级（AC:891-893）。 */
export const RELATED_HINT_PARTIAL = 'partial'
/** 起点自身失效的附加说明（spec D5 ②）。 */
export const RELATED_HINT_START_INVALID = '起点已失效，结果为邻居记忆'

/** 内核条目 → canonical 条目（text 复用 3.1 的 256-token 截断；失效标记按需出现）。 */
function toResultEntry(item: RelatedTraversalItem): MemoryRelatedResultEntry {
  const text = truncateRecallText(item.text)
  return {
    id: item.id,
    layer: item.layer,
    hops: item.hops,
    edge_type: item.edgeType,
    ...(item.reason === null ? {} : { reason: item.reason }),
    text: text.text,
    ...(text.truncated ? { truncated: true } : {}),
    ...(item.invalid ? { invalid: true } : {}),
    ...(item.invalidAt === null ? {} : { invalid_at: item.invalidAt }),
    ...(item.expiredAt === null ? {} : { expired_at: item.expiredAt }),
  }
}

/** 组装 hint（部分降级 > 起点失效；正常时省略）。 */
function relatedHint(partial: boolean, startInvalid: boolean): string | undefined {
  const parts: string[] = []
  if (partial) parts.push(RELATED_HINT_PARTIAL)
  if (startInvalid) parts.push(RELATED_HINT_START_INVALID)
  return parts.length === 0 ? undefined : parts.join('；')
}

/** 成功值组装（含 AC:889 的空结果判定与 D5 起点语义）。 */
function toSucceeded(result: RelatedTraversalResult, partial: boolean): MemoryRelatedSucceeded {
  if (!result.startFound) {
    return { id: result.id, depth: result.depth, total: 0, results: [], hint: RELATED_HINT_START_MISSING }
  }
  // AC:889：结果非空但没有任何邻居存在全有效路径 ⇒ 空结果 + evidence expired。
  if (result.results.length > 0 && result.results.every((item) => !item.pathValid)) {
    return { id: result.id, depth: result.depth, total: 0, results: [], hint: RELATED_HINT_EVIDENCE_EXPIRED }
  }
  const hint = relatedHint(partial, result.start.invalid)
  return {
    id: result.id,
    depth: result.depth,
    total: result.total,
    results: result.results.map(toResultEntry),
    ...(hint === undefined ? {} : { hint }),
    ...(partial ? { partial: true } : {}),
  }
}

/** 失败值里透传 MemoryDbError 的 code/retryable，其它兜底 db_read_failed。 */
function toFailure(error: unknown): MemoryRelatedFailed {
  if (error instanceof MemoryDbError) {
    return failedEnvelope(error.code, error.message, error.retryable)
  }
  return failedEnvelope('db_read_failed', error instanceof Error ? error.message : String(error))
}

/**
 * 建工具定义。
 * @param options.getRelatedStore 取当前遍历能力——apply 先注册工具再建库，故必须是 getter。
 * @param options.quota          与 memory_recall 共享的每轮配额。
 */
export function createMemoryRelatedTool(options: MemoryRelatedToolOptions) {
  return defineTool({
    name: MEMORY_RELATED_TOOL_NAME,
    description: MEMORY_RELATED_TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // presenter 必须纯（无 I/O / 时钟 / 随机）。
        const result = value as MemoryRelatedValue
        if (isRelatedFailed(result)) {
          return [
            {
              type: 'text',
              text: `记忆关联失败：${result.error.code}（retryable=${result.error.retryable}）——${result.error.message}`,
            },
          ]
        }
        if (result.results.length === 0) {
          return [{ type: 'text', text: result.hint ?? '无匹配记忆。' }]
        }
        const lines = [
          `记忆关联（共 ${result.total} 条，显示 ${result.results.length} 条）：`,
          ...result.results.map((item) => {
            const mark = item.invalid === true ? '（已失效）' : ''
            return `- ${item.id} ${item.hops}跳 [${item.edge_type}] ${summarizeMemoryText(item.text)}${mark}`
          }),
        ]
        if (result.hint !== undefined && result.hint !== '') lines.push(result.hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      // 1) 空白 id 是参数错误：不耗配额、不遍历（与 memory_recall 的空白 query 同口径）。
      const id = args.id.trim()
      if (id === '') {
        return failedEnvelope('invalid_query', 'id 不能为空白：请给出要展开的起点记忆 id。')
      }
      // 2) 库未就绪先判：db_unavailable 不消耗配额。
      const store = options.getRelatedStore()
      if (!store) {
        return failedEnvelope('db_unavailable', '记忆库未就绪（无 profile 归属或库句柄缺失），本次未遍历。')
      }
      // 3) 配额（与 memory_recall 同一实例/同一桶；命令面不计）。
      if (!options.quota.consume(quotaOwnerOf(exec))) {
        return failedEnvelope(
          'quota_exceeded',
          '本轮召回配额已用尽（每轮召回族工具合计最多 3 次）；回合边界（turn/start、turn/end）后自动恢复，或改用 /memory related 手动遍历。',
        )
      }
      const depth = clampRelatedDepth(args.depth)
      try {
        let result: RelatedTraversalResult
        let partial = false
        try {
          result = await store.traverse({ id, depth, timeoutMs: RELATED_TRAVERSAL_TIMEOUT_MS })
        } catch (error) {
          if (!(error instanceof RelatedTraversalTimeoutError)) throw error
          // AC:891-893 / spec D8：超时 → depth=1 另发一次（**独立预算**，总 ≤2×timeoutMs）。
          partial = true
          result = await store.traverse({ id, depth: 1, timeoutMs: RELATED_TRAVERSAL_TIMEOUT_MS })
          if (result.results.length === 0) {
            return failedEnvelope('db_read_failed', '关联遍历超时，depth=1 重试后仍无结果。')
          }
        }
        return toSucceeded(result, partial)
      } catch (error) {
        return toFailure(error)
      }
    },
  })
}

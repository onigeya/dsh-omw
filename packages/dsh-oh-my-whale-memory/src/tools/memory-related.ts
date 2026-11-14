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
 * hint 语义（spec D4/D5/D8；判定与文案统一在 tools/related-shared.ts）：
 * - 起点不存在 ⇒ 成功值空结果 + `hint:'未找到该记忆。'`（AC:882-884）；
 * - 截断前没有任何邻居存在有效路径（`anyValidPath=false`）⇒ 空结果 + `hint:'evidence expired'`（AC:889 / F-02）；
 * - 超时后 depth=1 重试成功 ⇒ `partial:true` + `hint:'partial'`（AC:891-893）；
 * - 起点自身失效但仍有有效邻居 ⇒ hint 追加「起点已失效」（spec D5 ②，起点不参与证据链判定）。
 */
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  clampRelatedDepth,
  RelatedTraversalTimeoutError,
  type RelatedTraversalResult,
} from '../db/edges.js'
import { MemoryDbError } from '../db/errors.js'
import { summarizeMemoryText } from '../shared/summarize.js'
import { failedEnvelope, quotaOwnerOf, toolSignalOf, type ToolFailure } from './recall-shared.js'
import { toRelatedSuccessView, type RelatedViewEntry } from './related-shared.js'
import type { RecallQuota } from './recall-quota.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_RELATED_TOOL_NAME = 'memory_related'

/**
 * 单次遍历预算（spec D8 / NFR6：300ms 为**软目标**观测口径，非硬 SLA）。
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
              expired_at: { type: 'string', description: '过期时间（仅当节点已过期、该列非空时出现）' },
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

/** 内核视图条目 → 输出条目（AC:880 的 snake_case 边界；判定/截断都已在共享件完成）。 */
function toOutputEntry(entry: RelatedViewEntry): MemoryRelatedResultEntry {
  return {
    id: entry.id,
    layer: entry.layer,
    hops: entry.hops,
    edge_type: entry.edgeType,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    text: entry.text,
    ...(entry.truncated === true ? { truncated: true } : {}),
    ...(entry.invalid === true ? { invalid: true } : {}),
    ...(entry.invalidAt === undefined ? {} : { invalid_at: entry.invalidAt }),
    ...(entry.expiredAt === undefined ? {} : { expired_at: entry.expiredAt }),
  }
}

/** 成功值组装：D4/D5 判定、hint 与 256-token 截断全部走共享件（F-02/F-04/F-05）。 */
function toSucceeded(result: RelatedTraversalResult, partial: boolean): MemoryRelatedSucceeded {
  const view = toRelatedSuccessView(result, { partial })
  return {
    id: view.id,
    depth: view.depth,
    total: view.total,
    results: view.results.map(toOutputEntry),
    ...(view.hint === undefined ? {} : { hint: view.hint }),
    ...(view.partial === true ? { partial: true } : {}),
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
      // 2) 调用前已取消（用户中断 / turn 终止）⇒ 直接失败信封：不遍历、不耗配额
      //    （F-03：与 memory_recall 同口径）。
      if (toolSignalOf(exec)?.aborted === true) {
        return failedEnvelope('db_read_failed', '关联遍历已取消（调用前收到中止信号），未执行遍历。')
      }
      // 3) 库未就绪先判：db_unavailable 不消耗配额。
      const store = options.getRelatedStore()
      if (!store) {
        return failedEnvelope('db_unavailable', '记忆库未就绪（无 profile 归属或库句柄缺失），本次未遍历。')
      }
      // 4) 配额（与 memory_recall 同一实例/同一桶；命令面不计）。
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

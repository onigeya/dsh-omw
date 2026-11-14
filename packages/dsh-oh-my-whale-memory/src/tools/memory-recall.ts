/**
 * memory_recall 工具（Story 3.1 / FR-12 第一召回通道）。
 *
 * 契约（spec 3.1）：
 * - 参数 `query`（必填）/ `limit`（可选 integer，夹紧 [1,20]，缺省 5）/
 *   `layer`（可选，枚举只含 L1/L2——L3 已退役，宿主侧 parameters schema 拒绝其它值）；
 * - 成功值 `{ query, total, results, hint, degraded? }`（degraded 仅在降级检索时出现）；
 * - 失败值 `{ action: 'failed', error: { code, message, retryable } }`——工具**绝不 throw**，
 *   出错/配额超限/库不可用一律走失败信封（宿主把 throw 渲染成 isError）；
 * - execute 顺序：先判库（未就绪 ⇒ `db_unavailable`，**不消耗**配额——探测性调用不该吃掉
 *   整轮配额，也避免配额把根因盖住），再 `consume()` 配额（同轮召回族工具合计 3 次，
 *   超出即拒），然后 embed 查询向量（失败/不可用 ⇒ 降级为关键词单路，degraded: true），
 *   最后调 src/recall/core.ts 的混合检索内核；
 * - 只读：本工具不写库、不改任何节点（召回只读）。
 *
 * 工具先于建库注册（闭包 `getRecallStore`），库未就绪时返回 `db_unavailable`，
 * 插件可用性不受 profile/建库问题牵连。假 store 可注入（单测照 memory-remember 范本）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { MemoryDbError, type MemoryDbErrorCode } from '../db/errors.js'
import { inboxSessionKey } from '../inbox/idle-gate.js'
import { clampRecallLimit, type RecallCoreResult, type RecallResultItem } from '../recall/core.js'
import type { RecallQuota } from './recall-quota.js'
import { summarizeMemoryText } from '../summarize.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_RECALL_TOOL_NAME = 'memory_recall'

/** `layer` 参数的合法枚举（L3 已退役，AD-17；宿主侧拒绝其它值）。 */
export const MEMORY_RECALL_LAYERS = ['L1', 'L2'] as const

export const MEMORY_RECALL_TOOL_DESCRIPTION = [
  '从记忆库召回与查询相关的长期记忆（混合检索：语义向量路 + 关键词路，应用层 RRF 融合排序）。',
  'query 写你要找的内容：用户偏好与习惯、既往决策及其理由、硬约束与禁令、路径/端点/版本号/ID、可复用结论。',
  '只返回当前快照节点（已生效、未失效、未过期），每条含 id/layer/kind/priority/text；单条超 256 token 时截断为首段并标 truncated=true（节点不丢，可按 id 另查全文）。',
  'limit 可选（缺省 5，上限 20）；layer 可选（L1/L2，省略时 L2 优先于 L1）。',
  '同一回合内召回族工具合计最多 3 次，超出返回 quota_exceeded；embedding 不可用时自动降级为关键词单路并标 degraded。',
  '空白 query 直接返回 invalid_query（参数错误，不消耗配额、不检索）。',
].join('\n')

/**
 * 检索能力端口（结构声明，单测注入假实现；生产实现见 src/index.ts 的闭包 store）：
 * - `embeddingEnabled`：配置是否齐全（endpoint/token/model）；
 * - `embedQuery`：对查询文本取向量，失败/不可用返回 null（降级关键词单路）；
 * - `recall`：调混合检索内核（connection/config/embedding model 由 store 内部取）。
 */
export interface MemoryRecallStore {
  readonly embeddingEnabled: boolean
  embedQuery(query: string): Promise<readonly number[] | null>
  recall(input: {
    readonly query: string
    readonly queryVector: readonly number[] | null
    readonly limit: number
    readonly layer?: string
  }): Promise<RecallCoreResult>
}

export interface MemoryRecallToolOptions {
  /** 取当前检索能力（闭包 getter：apply 先注册工具再建库，未就绪返回 undefined）。 */
  readonly getRecallStore: () => MemoryRecallStore | undefined
  /** 每轮配额（按会话键计数；`turn/start` 与 `turn/end` 双点重置）。 */
  readonly quota: RecallQuota
}

/** 成功值：results[i] 是当前快照节点（id/layer/kind/priority/text [+truncated/evidence]）。 */
export interface MemoryRecallResultEntry {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly priority: number
  readonly text: string
  readonly truncated?: boolean
  readonly evidence?: string[]
}

export interface MemoryRecallSucceeded {
  readonly query: string
  readonly total: number
  results: MemoryRecallResultEntry[]
  readonly hint: string
  /** true = 关键词单路降级（embedding 不可用或查询 embed 失败）。 */
  readonly degraded?: boolean
}

export interface MemoryRecallFailed {
  action: 'failed'
  error: {
    code: MemoryDbErrorCode
    message: string
    retryable: boolean
  }
}

export type MemoryRecallValue = MemoryRecallSucceeded | MemoryRecallFailed

/** 类型守卫：成功分支没有 `action` 字段（spec 形态），故用显式判据而非属性收窄。 */
function isRecallFailed(value: MemoryRecallValue): value is MemoryRecallFailed {
  return (value as { readonly action?: unknown }).action === 'failed'
}

const PARAMETERS = {
  query: {
    type: 'string',
    required: true,
    description: '检索文本。支持语义与关键词双路混合；召回用户偏好、决策、约束、标识与结论。',
  },
  limit: {
    type: 'integer',
    description: '返回条数，缺省 5、上限 20、下限 1；越界自动夹紧。',
  },
  layer: {
    type: 'string',
    enum: MEMORY_RECALL_LAYERS,
    description: '只召回该层（L1 原子记忆 / L2 综合陈述）；省略时两层都参与、L2 优先。',
  },
} as const satisfies ParameterSchemaSpec

/** 输出 schema 用 oneOf 把成功/失败两个 canonical 形态钉死（照 memory-remember 范本）。 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        query: { type: 'string', required: true, description: '原始检索文本（回显）' },
        total: { type: 'integer', required: true, description: '融合命中总数（limit 截断前）；results.length = min(limit, total)' },
        results: {
          type: 'array',
          required: true,
          description: '命中记忆，按 RRF 融合分排序（priority=-1 恒置顶）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '记忆节点 id（uuid5，同指纹稳定）' },
              layer: { type: 'string', required: true, description: '记忆层（L1 / L2）' },
              kind: { type: 'string', required: true, description: 'FR-15 七类分类；未分类为空串' },
              priority: { type: 'integer', required: true, description: '优先级 -1..100；-1 = 全局强规则' },
              text: { type: 'string', required: true, description: '记忆原文' },
              truncated: { type: 'boolean', description: 'true = 原文超长（约 256 tokens），建议按 id 用详情查看' },
              evidence: { type: 'array', items: { type: 'string' }, description: '非空 source_refs（来源引用）' },
            },
          },
        },
        hint: { type: 'string', required: true, description: '本次检索的说明（降级/无命中等）' },
        degraded: { type: 'boolean', description: 'true = embedding 不可用，仅关键词单路（降级检索）' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'failed', required: true, description: '检索失败' },
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

/**
 * 配额 owner（spec D7）：`ToolRunContext` 自身无 session 字段，但 `exec.agent.session` 存在
 * （宿主 filesystem.md:316 的同源用法）。经 `inboxSessionKey` 取会话键——与 turn 边界
 * `session/event` 监听器（recall-quota.ts）落到**同一个键**，两边才能对上同一只桶。
 * 缺 session 身份时归 `'unknown'` 桶（保守拒绝）。结构窄化而不引 dsh-agent/dsh-session 类型
 * （本包未依赖它们，与 dsh-tool-fs 的 actor 处理同一形态）。
 */
function quotaOwnerOf(exec: unknown): string {
  const session = (exec as { readonly agent?: { readonly session?: unknown } } | null | undefined)?.agent?.session
  return inboxSessionKey(session)
}

/** 组装 canonical failed 值（错误码锁回封闭联合，编译期防任意文本外发）。 */
function failed(code: MemoryDbErrorCode, message: string, retryable = false): MemoryRecallFailed {
  return { action: 'failed', error: { code, message, retryable } }
}

/**
 * 建工具定义。
 * @param options.getRecallStore 取当前检索能力——apply 先注册工具再建库，故必须是 getter；
 *                              返回 undefined 表示库未就绪（execute 返回 db_unavailable）。
 * @param options.quota         每轮配额；由 index.ts 创建并在 `turn/start` 重置（两种模式都注册）。
 */
export function createMemoryRecallTool(options: MemoryRecallToolOptions) {
  return defineTool({
    name: MEMORY_RECALL_TOOL_NAME,
    description: MEMORY_RECALL_TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // presenter 必须纯（无 I/O / 时钟 / 随机）；成功分支没有 action 字段，
        // 经类型守卫判别后再取字段。
        const result = value as MemoryRecallValue
        if (isRecallFailed(result)) {
          return [
            {
              type: 'text',
              text: `记忆召回失败：${result.error.code}（retryable=${result.error.retryable}）——${result.error.message}`,
            },
          ]
        }
        if (result.total === 0 || result.results.length === 0) {
          // 降级/无命中的措辞只由内核 hint 承载（F-07：两个渲染面不再各拼一份文案）。
          return [{ type: 'text', text: result.hint }]
        }
        const lines = [
          `记忆召回（共 ${result.total} 条，显示 ${result.results.length} 条，按 RRF 排序）：`,
          ...result.results.map((item) => `- ${item.id} [${item.layer}] ${summarizeMemoryText(item.text)}`),
        ]
        if (result.hint !== '') lines.push(result.hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      // 0) F-13：空白 query 是**参数错误**，不是「无匹配」——向量路会拿空白文本取向量
      //    并返回任意近邻，且照常吃掉配额。先拒：不耗配额、不检索、不 embed。
      if (args.query.trim() === '') {
        return failed(
          'invalid_query',
          'query 不能为空白：请给出要检索的内容（空白查询会让向量路返回任意近邻，不是「无匹配」）。',
        )
      }
      // 1) 库未就绪先判：db_unavailable 不消耗配额（探测性调用不该吃掉整轮配额，
      //    也避免配额耗尽把根因盖成 quota_exceeded）。
      const store = options.getRecallStore()
      if (!store) {
        return failed('db_unavailable', '记忆库未就绪（无 profile 归属或库句柄缺失），本次未检索')
      }
      // 2) 配额消耗（按会话键计数；同轮召回族工具共享，本工具 + 后续 memory_related/expand）。
      if (!options.quota.consume(quotaOwnerOf(exec))) {
        return failed(
          'quota_exceeded',
          '本轮召回配额已用尽（每轮召回族工具合计最多 3 次）；回合边界（turn/start、turn/end）后自动恢复，或改用 /memory recall 手动检索。',
        )
      }
      // 3) 查询向量：配置齐全才 embed；失败/异常一律降级为关键词单路（degraded: true），
      //    绝不因网络错误让整次检索失败（spec I/O 矩阵「召回查询 embed 失败」行）。
      const limit = clampRecallLimit(args.limit)
      let queryVector: readonly number[] | null = null
      if (store.embeddingEnabled) {
        try {
          queryVector = await store.embedQuery(args.query)
        } catch {
          queryVector = null
        }
      }
      // 4) 调内核；检索错误收敛为失败信封（绝不 throw）。
      try {
        const core = await store.recall({ query: args.query, queryVector, limit, layer: args.layer })
        const results = core.results.map(toResultEntry)
        const succeeded: MemoryRecallSucceeded = {
          query: args.query,
          total: core.total,
          results,
          hint: core.hint,
          ...(core.degraded ? { degraded: true } : {}),
        }
        return succeeded
      } catch (error) {
        if (error instanceof MemoryDbError) {
          return failed(error.code, error.message, error.retryable)
        }
        return failed('db_read_failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

/** 内核条目 → 工具输出条目（readonly → 可变数组形态，evidence 只在非空时出现）。 */
function toResultEntry(item: RecallResultItem): MemoryRecallResultEntry {
  return {
    id: item.id,
    layer: item.layer,
    kind: item.kind,
    priority: item.priority,
    text: item.text,
    ...(item.truncated === true ? { truncated: true } : {}),
    ...(item.evidence !== undefined ? { evidence: [...item.evidence] } : {}),
  }
}

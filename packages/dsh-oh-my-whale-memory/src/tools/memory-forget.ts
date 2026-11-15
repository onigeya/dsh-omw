/**
 * memory_forget 工具（Story 4.1 / FR-14、FR-15 / AC:1035-1040）。
 *
 * 契约（刻意不对称）：本工具**只**返回 `confirmation_required`，不留任何执行通道。
 * `memory_forget` 的执行路径不存在 —— 遗忘是不可逆的语义裁决，确认只能由用户的斜杠命令
 * `/memory forget <id>` 完成（AC:1039「确认后自动执行」的通道被显式禁止）。
 *
 * 因此 agent 面能做的只有三件：把 id 解析成一条可读预览（layer + 摘要）、告诉用户怎么确认、
 * 以及在库不可用/只读/查不到时给出 canonical 失败信封。本文件不 import `db/forget.ts`：
 * 「工具不会遗忘」这条不变量由依赖方向保证，而不是靠约定。
 */
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { MemoryDbError } from '../db/errors.js'
import { summarizeMemoryText } from '../shared/summarize.js'
import { failedEnvelope, type ToolFailure } from './recall-shared.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_FORGET_TOOL_NAME = 'memory_forget'

export const MEMORY_FORGET_TOOL_DESCRIPTION = [
  '请求用户确认遗忘一条记忆。本工具不会执行遗忘：它只返回 confirmation_required 与一条预览。',
  '遗忘是不可逆的语义裁决，必须由用户亲自执行斜杠命令 /memory forget <id> 确认。',
  'id 传已知记忆的 id（可从 memory_recall / memory_related 的结果取）。',
  '库不可用时返回 db_unavailable，只读实例返回 readonly_mode，id 不存在返回 memory_not_found。',
].join('\n')

/** 成功值里的提示文案（spec 钉死，逐字）。 */
export const MEMORY_FORGET_CONFIRMATION_HINT =
  '确认必须由用户的斜杠命令完成：/memory forget <id>。Agent 侧没有确认后自动执行的通道。'

/** 预览的一条记忆：足够让用户认出是哪条，不携带向量与证据引用的体积。 */
export interface MemoryForgetPreview {
  readonly id: string
  readonly layer: string
  readonly text: string
}

/**
 * 遗忘能力端口（结构声明，单测注入假实现；生产实现见 `wire/tools.ts`）：
 * - `readonly`：本实例是否降级只读（只读实例不判断 id 是否存在，直接拒）；
 * - `preview`：按 id 取一条记忆；不存在返回 null（不抛错）。
 */
export interface MemoryForgetStore {
  readonly readonly: boolean
  preview(id: string): Promise<MemoryForgetPreview | null>
}

export interface MemoryForgetToolOptions {
  /** 取当前端口（闭包 getter：apply 先注册工具再建库，未就绪返回 undefined）。 */
  readonly getForgetStore: () => MemoryForgetStore | undefined
}

/** 成功值（唯一成功分支）：请求用户确认。 */
export interface MemoryForgetConfirmation {
  readonly action: 'confirmation_required'
  readonly id: string
  readonly layer: string
  /** 摘要（`summarizeMemoryText`），不是全文。 */
  readonly text: string
  readonly hint: string
}

/** 失败分支的 canonical 形态与召回族工具同源（tools/recall-shared.ts）。 */
export type MemoryForgetFailed = ToolFailure

export type MemoryForgetValue = MemoryForgetConfirmation | MemoryForgetFailed

/** 类型守卫：失败分支带 `action: 'failed'`。 */
function isForgetFailed(value: MemoryForgetValue): value is MemoryForgetFailed {
  return value.action === 'failed'
}

const PARAMETERS = {
  id: {
    type: 'string',
    required: true,
    description: '要遗忘的记忆 id（uuid5；可从 memory_recall / memory_related 的结果里取）。',
  },
} as const satisfies ParameterSchemaSpec

/** 输出 schema：oneOf 钉死 confirmation_required 与 failed 两个 canonical 形态。 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          const: 'confirmation_required',
          required: true,
          description: '需要用户确认：本次没有执行遗忘',
        },
        id: { type: 'string', required: true, description: '目标记忆 id（回显）' },
        layer: { type: 'string', required: true, description: '记忆层（L1 / L2）' },
        text: { type: 'string', required: true, description: '记忆文本摘要（已折叠空白并截断）' },
        hint: { type: 'string', required: true, description: '如何确认：由用户执行 /memory forget <id>' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'failed', required: true, description: '请求失败' },
        error: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            code: { type: 'string', required: true, description: '封闭错误码：invalid_query、db_unavailable、readonly_mode 或 memory_not_found' },
            message: { type: 'string', required: true, description: '诊断信息，不含凭据' },
            retryable: { type: 'boolean', required: true, description: '是否值得重试' },
          },
        },
      },
      additionalProperties: false,
    },
  ],
} as const satisfies ValueSchemaSpec

/** 失败值里透传 MemoryDbError 的 code/retryable，其它兜底 db_read_failed。 */
function toFailure(error: unknown): MemoryForgetFailed {
  if (error instanceof MemoryDbError) {
    return failedEnvelope(error.code, error.message, error.retryable)
  }
  return failedEnvelope('db_read_failed', error instanceof Error ? error.message : String(error))
}

/**
 * 建工具定义。
 * @param options.getForgetStore 取当前端口，apply 先注册工具再建库，故必须是 getter。
 */
export function createMemoryForgetTool(options: MemoryForgetToolOptions) {
  return defineTool({
    name: MEMORY_FORGET_TOOL_NAME,
    description: MEMORY_FORGET_TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // presenter 必须纯（无 I/O / 时钟 / 随机）。
        const result = value as MemoryForgetValue
        if (isForgetFailed(result)) {
          return [
            {
              type: 'text',
              text: `记忆遗忘失败：${result.error.code}（retryable=${result.error.retryable}）——${result.error.message}`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: [
              `记忆遗忘需要确认：${result.id} [${result.layer}] ${result.text}`,
              result.hint,
            ].join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      // 1) 空白 id 是参数错误：不查库、不判断库状态（与 memory_related 的空白 id 同口径）。
      const id = args.id.trim()
      if (id === '') {
        return failedEnvelope('invalid_query', 'id 不能为空白：请给出要遗忘的记忆 id。')
      }
      // 2) 库未就绪先判：db_unavailable 不查库。
      const store = options.getForgetStore()
      if (store === undefined) {
        return failedEnvelope('db_unavailable', '记忆库未就绪（无 profile 归属或库句柄缺失），本次未遗忘。')
      }
      // 3) 只读实例不判断 id 是否存在，直接拒（AC:1035-1037）：本工具本来就不写库，
      //    这里拒的是「把确认请求发给一个根本没法执行它的窗口」。
      if (store.readonly) {
        return failedEnvelope(
          'readonly_mode',
          '记忆库处于只读模式（本窗口不是写者实例），拒绝遗忘：请关闭持有写者锁的窗口后重启本窗口，' +
          '或在该写者窗口中执行 /memory forget。',
        )
      }
      try {
        const preview = await store.preview(id)
        if (preview === null) {
          return failedEnvelope('memory_not_found', `未找到 id 为 ${id} 的记忆。`)
        }
        const confirmation: MemoryForgetConfirmation = {
          action: 'confirmation_required',
          id: preview.id,
          layer: preview.layer,
          text: summarizeMemoryText(preview.text),
          hint: MEMORY_FORGET_CONFIRMATION_HINT,
        }
        return confirmation
      } catch (error) {
        return toFailure(error)
      }
    },
  })
}

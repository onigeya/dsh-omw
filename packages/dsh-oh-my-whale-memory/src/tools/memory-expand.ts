/**
 * `memory_expand(handle)` 工具（Story 8.2 / FR-23、AC:1615-1622、NFR18、INV-3）。
 *
 * 契约要点：
 * - 签名 `memory_expand(handle)`；成功返回 `{handle,total,text,restored:true,bytes,...}`；
 * - 失败返回 `{restored:false,error:{code,message,retryable}}`，**永不 throw**（fail-open，INV-3）；
 * - 与 `memory_recall` / `memory_related` **共享**每轮 ≤3 次配额（FR-10）；
 * - 只读实例照常可用（纯读路径，INV-7），库未就绪 ⇒ `db_unavailable`。
 *
 * execute 顺序（与 memory_related 同一纪律）：非法 handle（不耗配额）→ 判库（不耗配额）→
 * 配额（耗配额）→ 查句柄 → 成功/失败信封。配额只在真正要查库时消耗，手抄错不该吃掉额度。
 */
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { MemoryDatabase } from '../db/database.js'
import { resolveHandleInput } from '../context/handle.js'
import { classifyHandle, readHandle } from '../context/handles.js'
import { expandFailure, expandSuccess, type ExpandResult } from '../context/expand-result.js'
import { quotaOwnerOf } from './recall-shared.js'
import type { RecallQuota } from './recall-quota.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_EXPAND_TOOL_NAME = 'memory_expand'

export const MEMORY_EXPAND_TOOL_DESCRIPTION = [
  '把一个折叠句柄还原成逐字原文（100% 还原，不截断）。',
  'handle 传表面里的句柄块（形如 [omw:handle=<id> ~<n> tokens]）或其中的 id。',
  '句柄不存在 / 已失效 / 属于其它会话时返回 restored:false 与 error.code；本工具不抛异常、不删除任何内容。',
  '与 memory_recall / memory_related 共享每轮 3 次调用配额。',
].join('\n')

const PARAMETERS = {
  handle: {
    type: 'string',
    required: true,
    description: '折叠句柄（整段 [omw:handle=...] 或其中的 id）。',
  },
} as const satisfies ParameterSchemaSpec

/** 输出 schema：oneOf 钉死成功与失败两个 canonical 形态（与 memory_forget 同一写法）。 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        handle: { type: 'string', required: true, description: '句柄 id（回显）' },
        total: { type: 'number', required: true, description: '还原文本的字符数' },
        text: { type: 'string', required: true, description: '逐字原文（不截断）' },
        restored: { type: 'boolean', required: true, description: '固定 true' },
        bytes: { type: 'number', required: true, description: 'UTF-8 字节数' },
        expandCount: { type: 'number', description: '该句柄累计展开次数（可选）' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        restored: { type: 'boolean', required: true, description: '固定 false' },
        error: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            code: {
              type: 'string',
              required: true,
              description:
                '封闭错误码：handle_not_found、handle_expired、session_mismatch、db_unavailable 或 quota_exceeded',
            },
            message: { type: 'string', required: true, description: '诊断信息，不含凭据' },
            retryable: { type: 'boolean', required: true, description: '是否值得重试' },
          },
        },
      },
      additionalProperties: false,
    },
  ],
} as const satisfies ValueSchemaSpec

export interface MemoryExpandOptions {
  /** 惰性取库：undefined = 未就绪（返回 db_unavailable，**不耗配额**）。 */
  readonly getDb: () => MemoryDatabase | undefined
  /** 与 recall / related 共享的每轮配额。 */
  readonly quota: RecallQuota

}

export function createMemoryExpandTool(options: MemoryExpandOptions) {
  return defineTool({
    name: MEMORY_EXPAND_TOOL_NAME,
    description: MEMORY_EXPAND_TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // presenter 必须纯（无 I/O / 时钟 / 随机）。
        const result = value as ExpandResult
        if (result.restored) {
          return [
            {
              type: 'text',
              text: '已还原 ' + String(result.total) + ' 字符（' + String(result.bytes) + ' 字节）：\n' + result.text,
            },
          ]
        }
        return [
          {
            type: 'text',
            text:
              '句柄还原失败：' + result.error.code + '（retryable=' + String(result.error.retryable) + '）——' + result.error.message,
          },
        ]
      },
    },
    async execute(args, exec): Promise<ExpandResult> {
      const handle = resolveHandleInput(typeof args.handle === 'string' ? args.handle : '')
      // ① 入参就不像句柄：不耗配额（手抄错不该吃掉本轮额度）。
      if (handle === null) return expandFailure('handle_not_found', '入参不是合法句柄')

      // ② 库未就绪：不耗配额。
      const database = options.getDb()
      if (database === undefined) return expandFailure('db_unavailable')

      // ③ 配额（与 recall/related 同一桶）。
      const owner = quotaOwnerOf(exec)
      if (!options.quota.consume(owner)) return expandFailure('quota_exceeded')

      // ④ 查句柄并归因（readHandle 内部已 catch，不存在 ⇒ null）。
      // 会话键取自**当次调用**（与配额同源；装配期静态 id 在多会话下是错的）。
      const record = await readHandle(database.connection, handle)
      const verdict = classifyHandle(record, owner)
      if (verdict.ok) return expandSuccess(verdict.record)
      return expandFailure(verdict.failure)
    },
  })
}

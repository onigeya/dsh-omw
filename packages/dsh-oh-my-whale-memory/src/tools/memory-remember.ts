/**
 * memory_remember 工具（Story 1.6 / FR-1 第一写入通道）。
 *
 * 契约（spec 1.6）：
 * - 工具名 `memory_remember`，参数 `content`（必填）/ `context`（可选，来源引用）；
 * - Story 1.11：新增 `kind`（七类分类）与 `priority`（-1..100）两个可选入参，
 *   透传到写路径（FR-20 分类写路径）；缺省保持 kind=''/priority=0；
 * - 固定写 layer='L1'（不是 'L1_INBOX'——spine 的层枚举是 L0|L1|L2|L3，
 *   Epic 2 才引入 INBOX 精炼流水线；Story 1.11 把全仓写路径收敛为 'L1'）；
 * - 不产 embedding：三列向量保持 NULL（绝不写零向量），向量由 Epic 2 补齐；
 * - 节点 id / 归一化 / 合并语义全部复用 src/db/id.ts + src/db/memory.ts，
 *   本文件不复制第二份指纹逻辑；
 * - execute 绝不 throw：宿主把 throw 渲染成 isError，工具层失败必须走
 *   canonical 返回值 `{ action: 'failed', error: { code, message, retryable } }`。
 *
 * 工具在 apply 阶段先于建库注册（闭包 `getDb`），因此库未就绪时插件仍能加载，
 * 调用返回 `db_unavailable` 而不是让整个插件启动失败。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { MemoryDbError, type MemoryDbErrorCode } from '../db/errors.js'
import type { UpsertMemoryResult } from '../db/memory.js'
import type { MemoryActor } from '../db/audit.js'

/** 工具名（模型可见；宿主内唯一）。 */
export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember'

/** 直写层：L1（Epic 2 之前没有 INBOX 分拣，写入即 L1 原子记忆）。 */
export const MEMORY_REMEMBER_LAYER = 'L1'

/**
 * FR-15 七类记忆分类（PRD prd.md:72 / prd.md:298，SPINE:274-275 的同名列枚举）。
 * 写路径（工具参数 / 命令旗标）的合法 kind 取值就是这个集合；缺省为空串。
 */
export const MEMORY_KINDS = [
  'persona',
  'episodic',
  'instruction',
  'work_fact',
  'work_task',
  'work_method',
  'work_artifact',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * 模型可见描述——既是能力说明，也是 FR-1 的写入护栏：
 * 只收长期有价值的事实，明确排除 ephemeral/transient 内容。
 */
export const MEMORY_REMEMBER_TOOL_DESCRIPTION = [
  '把一条值得长期记住的事实写入记忆库（L1 原子记忆层）。',
  '只记跨会话仍然成立的内容：用户偏好与习惯、已确定的决策及其理由、硬约束与禁令、稳定的标识（路径/端点/版本号/ID）、可复用的结论。',
  '不要记录 ephemeral / transient content：当前任务的进度、一次性中间结果、临时变量、闲聊与寒暄都不是长期记忆，不要写入。',
  'content 写记忆原文，保留用户原始措辞与关键参数；同一内容重复调用会命中同一节点（幂等，不会产生重复记忆）。',
  'context 可选，填来源消息 id 或卡片 id，用于溯源；省略则不记来源。',
  'kind 可选，取七类之一：persona / episodic / instruction / work_fact / work_task / work_method / work_artifact；'
  + 'priority 可选，取 -1..100 的整数，-1 表示全局强规则（恒置顶）。两者省略时 kind 为空、priority 为 0；'
  + '同一内容重复写入命中同一节点，分类以最新一次写入为准。',
].join('\n')

/**
 * 工具只需要"按层写入"这一能力，因此按结构声明依赖端口，
 * 单测可注入假实现，生产实现是 MemoryDatabase。
 */
export interface MemoryRememberStore {
  upsertMemory(input: {
    layer: string
    text: string
    sourceRefs?: readonly string[]
    actor?: MemoryActor
    /** FR-15 分类（七类之一）；缺省不传 → 落库空串。 */
    kind?: string
    /** 优先级 -1..100（-1 = 全局强规则/恒置顶）；缺省不传 → 落库 0。 */
    priority?: number
  }): Promise<UpsertMemoryResult>
}

/** 写入成功：节点 id（uuid5，天然幂等）。 */
export interface MemoryRememberStored {
  action: 'stored'
  id: string
}

/** 写入失败：错误信封 { code, message, retryable }，与 MemoryDbError 同一契约面。 */
export interface MemoryRememberFailed {
  action: 'failed'
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

export type MemoryRememberValue = MemoryRememberStored | MemoryRememberFailed

const PARAMETERS = {
  content: {
    type: 'string',
    required: true,
    description: '记忆原文。写长期有效的事实，不要写临时性/一次性内容。同一内容重复写入命中同一节点。',
  },
  context: {
    type: 'string',
    description: '来源引用（消息 id 或卡片 id），可选；省略则不记来源。',
  },
  kind: {
    type: 'string',
    enum: MEMORY_KINDS,
    description: '记忆分类（FR-15 七类），可选；省略时落库为空串。',
  },
  priority: {
    type: 'integer',
    description: '优先级，取 -1..100 的整数，-1 表示全局强规则（恒置顶）；可选，省略时落库 0。',
  },
} as const satisfies ParameterSchemaSpec

/**
 * 输出 schema 用 oneOf 把两个 canonical 形态钉死（不是自由文本）：
 * 模型因此能稳定区分"已写入"与"写入失败 + 可机读错误码"。
 */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'stored', required: true, description: '写入成功' },
        id: { type: 'string', required: true, description: '记忆节点 id（uuid5，同指纹稳定）' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'failed', required: true, description: '写入失败' },
        error: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            code: { type: 'string', required: true, description: '错误码：标识失败原因的稳定枚举值，如 db_unavailable、db_write_failed、empty_fingerprint_text' },
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
 * 组装 canonical failed 值。code 锁回封闭错误码类型——这里出现新字符串时
 * 编译期即报错，不会把任意文本当成错误码广播给模型。
 */
function failed(code: MemoryDbErrorCode, message: string): MemoryRememberFailed {
  // retryable 恒 false：写入失败是语义错误（空指纹、维度不符、库缺失），重试不会变好。
  return { action: 'failed', error: { code, message, retryable: false } }
}

/**
 * 建工具定义。
 * @param getDb 取当前库句柄——apply 先注册工具再建库，因此这里必须是 getter 而不是句柄。
 *              返回 undefined 表示库未就绪（无 profile 归属或初始化失败）。
 */
export function createMemoryRememberTool(getDb: () => MemoryRememberStore | undefined) {
  return defineTool({
    name: MEMORY_REMEMBER_TOOL_NAME,
    description: MEMORY_REMEMBER_TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        if (value.action === 'stored') {
          return [{ type: 'text', text: `已写入记忆（id=${value.id}）` }]
        }
        return [
          {
            type: 'text',
            text: `记忆写入失败：${value.error.code}（retryable=${value.error.retryable}）——${value.error.message}`,
          },
        ]
      },
    },
    async execute(args) {
      try {
        // 空文本自查：纯空白在这里拦下；纯标点在归一化层抛 empty_fingerprint_text，
        // 由下面的 catch 统一转成 canonical failed 值。
        if (args.content.trim().length === 0) {
          return failed('empty_fingerprint_text', '记忆文本为空或只含空白，拒绝建节点')
        }
        const store = getDb()
        if (!store) {
          return failed('db_unavailable', '记忆库未就绪（无 profile 归属或库句柄缺失），本次未写入')
        }
        // context 缺省、或 trim 后为空 → []；非空取 trim 后的单元素数组，
        // 避免把空串/纯空白写进 source_refs 永久驻留 ['']。
        const context = args.context?.trim()
        const result = await store.upsertMemory({
          layer: MEMORY_REMEMBER_LAYER,
          actor: 'agent',
          text: args.content,
          sourceRefs: context === undefined || context.length === 0 ? [] : [context],
          // Story 1.11 / FR-20：分类与优先级必须真的到达写路径——缺省仍由 db 层
          // 的 `?? ''` / `?? 0` 兜底，因此 undefined 透传等价于"未分类"。
          kind: args.kind,
          priority: args.priority,
        })
        const stored: MemoryRememberStored = { action: 'stored', id: result.id }
        return stored
      } catch (error) {
        if (error instanceof MemoryDbError) {
          return failed(error.code, error.message)
        }
        // 底层驱动错误：兜底成 db_write_failed，保留原始诊断但绝不携带凭据（此路径无凭据）。
        return failed('db_write_failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

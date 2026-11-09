/**
 * `/memory` 宿主命令（Story 1.7 / AC1-AC4）。
 *
 * 命令定义是可脱离宿主单测的纯工厂：解析与错误收敛不依赖 ctx。handler 只读
 * `invocation.rawInput`，把任何写库异常收敛为 `{ kind: 'error', text }`——命令
 * 永不抛出（宿主契约：thrown handler 会以 `kind: 'error'` 收尾，见 commands.md:172）。
 *
 * 写入层固定 `layer='L1_INBOX'`；Epic 1 无 embedding 客户端，embedding /
 * embedding_model_id / embedding_dim 三列一并以 NULL 写入（Story 2.3 的既定状态，
 * 供后续重嵌入任务识别），绝不写零向量污染 HNSW。
 *
 * `@deepseek-ai/dsh-commands` 在本工作区不可解析，故这里只用本地结构化类型描述
 * 命令定义 / 调用 / 结果——运行时形态与宿主 `CommandDefinition` / `CommandInvocation` /
 * `CommandResult` 一致（D:\workspace\deepseek-harness\docs\subsystems\commands.md）。
 */

/** 宿主命令名（小写、无前导斜杠）。 */
export const MEMORY_COMMAND_NAME = 'memory'
/** `remember` 子命令：`rawInput` 的首个 token。 */
export const MEMORY_REMEMBER_SUBCOMMAND = 'remember'
/** 子命令 / payload 缺失、未知子命令时的 usage 提示。 */
export const MEMORY_REMEMBER_USAGE = [
  '用法：/memory remember <内容>',
  '',
  '把一条事实写入记忆（L1_INBOX 收件箱）。示例：/memory remember 我偏好 ESM 不要 CJS',
].join('\n')

/** 命令调用（宿主实际传入完整对象，本命令只消费 `rawInput`）。 */
export interface MemoryCommandInvocation {
  /** 命令名之后的原文，含分隔空白。 */
  readonly rawInput: string
}

/** 命令结果（宿主直接渲染给 UI，永不抛出）。 */
export interface MemoryCommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** 本插件消费的宿主命令运行时切片（结构化，避免依赖不可解析的 dsh-commands）。 */
export interface MemoryCommandsRuntime {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
    readonly handler: (invocation: MemoryCommandInvocation) => Promise<MemoryCommandResult>
  }): () => void
}

/** 命令定义（交给 `ctx.commands.register` 的对象）。 */
export type MemoryCommandDefinition = Parameters<MemoryCommandsRuntime['register']>[0]

export interface MemoryRememberDependencies {
  /** 把一条文本写入 L1_INBOX；抛错由 handler 收敛为 error 结果。 */
  writeInbox(text: string): Promise<void>
}

/**
 * 解析 `rawInput`：trim 起始空白取首 token。
 * - 首个 token 为 `remember` → 其余 trim 后为 payload；payload 为空仍算 invalid。
 * - 其它 token / 空 `rawInput` / `remember` 无 payload 一律 invalid。
 * 保留 payload 的内部空白（只 trim 首尾）。
 */
export function parseRememberInput(
  rawInput: string,
): { kind: 'remember', text: string } | { kind: 'invalid' } {
  const trimmedStart = rawInput.trimStart()
  if (!trimmedStart) return { kind: 'invalid' }
  const firstWhitespace = trimmedStart.search(/\s+/)
  const subcommand = firstWhitespace === -1 ? trimmedStart : trimmedStart.slice(0, firstWhitespace)
  if (subcommand !== MEMORY_REMEMBER_SUBCOMMAND) return { kind: 'invalid' }
  const payload = firstWhitespace === -1 ? '' : trimmedStart.slice(firstWhitespace).trim()
  if (!payload) return { kind: 'invalid' }
  return { kind: 'remember', text: payload }
}

/** 异常转可读文本：Error 取 message，其它取字符串。绝不携带凭据（只含用法/字段名）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 构造 `/memory remember` 命令定义。纯工厂：不读 ctx、不持有 db。 */
export function createMemoryRememberDefinition(deps: MemoryRememberDependencies): MemoryCommandDefinition {
  return {
    name: MEMORY_COMMAND_NAME,
    description: '记录一条长期记忆（写入 L1 收件箱，后续精炼进知识图谱）',
    input: { hint: '/memory remember <内容>' },
    handler: async (invocation): Promise<MemoryCommandResult> => {
      try {
        const parsed = parseRememberInput(invocation.rawInput)
        if (parsed.kind === 'invalid') {
          return { kind: 'error', text: MEMORY_REMEMBER_USAGE }
        }
        await deps.writeInbox(parsed.text)
        return { kind: 'success', text: `已记住：${parsed.text}` }
      } catch (error) {
        return { kind: 'error', text: errorText(error) }
      }
    },
  }
}

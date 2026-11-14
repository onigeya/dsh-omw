/**
 * 宿主 `/memory` 命令注册（Story 1.7–1.9 / 3.1 / 3.2）。
 *
 * 命令在 profileContext 早退之前**无条件**注册（库未就绪时返回明确错误，AC4）。
 * 注册是 effect：`ctx.effect` 的工厂返回可调用 disposer——宿主 commands 服务缺失（裸 ctx）
 * 时退化为 no-op。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createMemoryCommandDefinition,
  type MemoryCommandDependencies,
  type MemoryCommandsRuntime,
} from '../command.js'

export function wireMemoryCommand(ctx: Context, dependencies: MemoryCommandDependencies): void {
  ctx.effect(
    () => {
      const commands = ctx.get?.('commands') as MemoryCommandsRuntime | undefined
      return commands?.register(createMemoryCommandDefinition(dependencies)) ?? (() => {})
    },
    'omw-memory-command',
  )
}

// Story 7.3 接线调整：反思定时器改由既有 lifecycle teardown 释放（不加新的 ctx.effect，
// 因为 entry-exports 用例把 closer 数钉死了）。
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const K = (s) => s.replaceAll('\n', eol)
  for (const [from, to] of pairs) {
    if (!text.includes(K(from))) {
      console.error('MISS in ' + file + ':\n' + from.slice(0, 180))
      process.exit(1)
    }
    text = text.replace(K(from), K(to))
  }
  writeFileSync(file, text, 'utf8')
  console.log('patched ' + file)
}

// 1) lifecycle 选项加 onTeardown
patch('src/wire/lifecycle.ts', [
  [
    `export interface MemoryLifecycleOptions {
  readonly ctx: Context
  readonly dbPath: string
  readonly lock: MemoryWriterLock
  readonly slots: MemoryRuntimeSlots
}`,
    `export interface MemoryLifecycleOptions {
  readonly ctx: Context
  readonly dbPath: string
  readonly lock: MemoryWriterLock
  readonly slots: MemoryRuntimeSlots
  /**
   * 额外的 teardown 动作（Story 7.3：反思定时器）。放进既有 effect 而不是新挂一个，
   * 因为 entry-exports 用例把每次 apply 的 closer 数钉死了（新增会破坏既有契约）。
   */
  readonly onTeardown?: () => void
}`,
  ],
  [
    `    const teardownResources = async (): Promise<void> => {`,
    `    const teardownResources = async (): Promise<void> => {
      // Story 7.3：先停自建定时器（幂等；未创建时是 no-op）。
      try {
        options.onTeardown?.()
      } catch {
        // teardown 不许把错误抛回宿主。
      }`,
  ],
])

// 2) index：去掉新 ctx.effect，改用 lifecycle 的 onTeardown + 可变 ref
patch('src/index.ts', [
  [
    `  await wireStep('lifecycle', () => wireMemoryLifecycle({ ctx, dbPath, lock, slots }))`,
    `  // Story 7.3：反思定时器在 lifecycle 的既有 teardown 里释放（不新增 closer）。
  let cancelReflectionTimer = (): void => {}
  await wireStep('lifecycle', () => wireMemoryLifecycle({
    ctx,
    dbPath,
    lock,
    slots,
    onTeardown: () => cancelReflectionTimer(),
  }))`,
  ],
  [
    `  // Story 7.3：反思定时器是自建资源，挂 effect 释放（cordis-tutorial 02 的纪律）。
  ctx.effect(() => () => reflectionExecutor.cancel(), 'omw-memory-reflection-timer')
`,
    `  cancelReflectionTimer = () => reflectionExecutor.cancel()
`,
  ],
])

// Story 8.2 第 4 轮（续）：index 里构造 fold 配置（阈值/只读/会话/幂等键/写句柄）。
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/index.ts'
let text = readFileSync(file, 'utf8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const K = (s) => s.replaceAll('\n', eol)

function must(from, to) {
  if (!text.includes(K(from))) {
    console.error('MISS:\n' + from.slice(0, 220))
    process.exit(1)
  }
  text = text.replace(K(from), K(to))
}

must(
  `  await wireStep('tools', () => wireMemoryTools(ctx, {
    getDb,
    recallStore: retrieval.recallStore,
    relatedStore: retrieval.relatedStore,
    quota: retrieval.quota,
  }))`,
  `  await wireStep('tools', () => wireMemoryTools(ctx, {
    getDb,
    recallStore: retrieval.recallStore,
    relatedStore: retrieval.relatedStore,
    quota: retrieval.quota,
    // Story 8.2：当前会话 id（句柄越权判定）；无 session 时不判。
    sessionId: () => sessionKeyOf(ctx),
    // Story 8.2：结果折叠（接缝 i）。只读实例由 foldToolResult 内部短路，零写入（INV-7）。
    fold: {
      thresholdTokens: resolved.foldThresholdTokens,
      readonly: instance.readonly,
      sessionId: () => sessionKeyOf(ctx),
      // 幂等键：同一会话 + 同一起点 + 同一 depth 视为同一条工具结果（INV-6）。
      seqKey: ({ id, depth }) => 'related:' + sessionKeyOf(ctx) + ':' + id + ':' + String(depth),
      write: async (input) => {
        const database = getDb()
        if (database === undefined) throw new Error('db unavailable')
        const record = await writeHandle(database.connection, {
          sessionId: input.sessionId,
          seq: input.seq,
          text: input.text,
          recordedAt: new Date().toISOString(),
          tokens: input.tokens,
        })
        return { id: record.id }
      },
      logger: ctx.logger,
    },
  }))`,
)

// 会话键辅助：与 quota 同一口径（inboxSessionKey）。
must(
  `import { createReflectionExecutor } from './reflection/executor.js'`,
  `import { createReflectionExecutor } from './reflection/executor.js'
import { writeHandle } from './context/handles.js'
import { inboxSessionKey } from './inbox/idle-gate.js'`,
)

must(
  `/**

 * 插件入口`,
  `/**
 * Story 8.2：从当前 ctx 取会话键（与配额/采集同一口径）。裸 ctx（单测）无 session 时返回 'unknown'。
 */
function sessionKeyOf(ctx: Context): string {
  const session = (ctx as unknown as { session?: unknown }).session
  return inboxSessionKey(session)
}

/**
 * 插件入口`,
)

writeFileSync(file, text, 'utf8')
console.log('patched index fold config')

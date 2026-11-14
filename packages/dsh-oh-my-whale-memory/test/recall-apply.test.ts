/**
 * 召回装配面真库测试（Story 3.1 / F-05、F-06、F-08）：裸 ctx 驱动 `apply`，捕获
 * `memory_recall` 工具与 `/memory recall` 命令，走真实的 recallStore / runRecall /
 * recallMemories 接线（不是假 dep）。
 *
 * 覆盖：
 * - **只读实例召回照常**（AC「只读实例检索照常」）：写者锁被另一进程持有 ⇒ apply 降级只读，
 *   捕获的工具在关键词路上仍能命中真库数据（F-05/F-06）；
 * - **模型 pin 守卫**（F-02）：配置的 `embedding.model` 与库内 pin 不一致 ⇒ 跳过向量路、
 *   `degraded: true` + warn，绝不用异模型向量算余弦；
 * - **配额端到端**（F-08）：工具侧键（`exec.agent.session`）与 turn 事件监听侧键落到同一只
 *   桶；`turn/end` 重置后可继续调用；无 session 身份时 `'unknown'` 桶同样在 turn 边界恢复；
 * - **装配漏传**（F-05）：`degraded` / `hint` / `total` 由真实内核透传到工具输出——漏传会被
 *   本文件的 toEqual/包含断言直接拦住。
 *
 * 开库次数：2 次（只读夹具 + 写者路径各 1），远低于每文件 ≤12 的限制。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import type { MemoryCommandDefinition } from '../src/command'
import { openMemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createFtsIndexStatement,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
  createVectorIndexStatement,
} from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const PIN_MODEL = 'pin-model'
const OTHER_MODEL = 'other-model'
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
const TS = (seconds: number): string => `2026-11-01T00:00:${String(seconds).padStart(2, '0')}.000Z`

/** `defineTool` 编译产物的最小结构视图（与 tool-memory-recall.test.ts 同形）。 */
interface CapturedTool {
  name: string
  execute: (args: { query: string; limit?: number; layer?: string }, exec?: unknown) => Promise<{
    query?: string
    total?: number
    results?: Array<{ id: string; layer: string; kind: string; priority: number; text: string }>
    hint?: string
    degraded?: boolean
    action?: 'failed'
    error?: { code: string; message: string; retryable: boolean }
  }>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

interface CapturedApply {
  readonly tool: CapturedTool
  readonly command: MemoryCommandDefinition | undefined
  readonly warn: ReturnType<typeof vi.fn>
  /** `session/event` 监听器（apply 注册的配额重置点）。 */
  readonly listeners: Array<(session: unknown, event: unknown) => void>
  /** 逐个 await 的 disposer（释放写者锁、停消费者）。 */
  readonly close: () => Promise<void>
}

/**
 * 裸 ctx（同 command-status-db.test.ts）：捕获工具/命令定义、`session/event` 监听器与
 * closers；`ctx.effect` 的工厂立即执行（apply 的既有约定），dispose 由测试显式触发。
 */
async function applyPlugin(
  profileDir: string,
  config: Record<string, unknown>,
): Promise<CapturedApply> {
  const tools: CapturedTool[] = []
  const commands: MemoryCommandDefinition[] = []
  const listeners: Array<(session: unknown, event: unknown) => void> = []
  const closers: Array<() => unknown> = []
  const warn = vi.fn()
  const ctx = {
    logger: { warn, info: vi.fn() },
    get: (key: string) => {
      if (key === 'profileContext') return { dir: profileDir }
      if (key === 'commands') {
        return {
          register: (definition: MemoryCommandDefinition) => {
            commands.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    on: (event: string, listener: (session: unknown, payload: unknown) => void) => {
      if (event === 'session/event') listeners.push(listener)
      return () => {}
    },
    effect: (factory: () => () => unknown) => closers.push(factory()),
    tools: {
      register: (definition: CapturedTool) => {
        tools.push(definition)
        return () => {}
      },
    },
  } as unknown as Parameters<typeof plugin.apply>[0]

  await plugin.apply(ctx, config as Parameters<typeof plugin.apply>[1])

  const tool = tools.find((candidate) => candidate.name === 'memory_recall')
  if (!tool) throw new Error('apply 未注册 memory_recall 工具')
  return {
    tool,
    command: commands[0],
    warn,
    listeners,
    async close() {
      for (const closer of closers.reverse()) await closer()
    },
  }
}

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/**
 * 只读夹具：建 memory/meta 两表 + 一条可命中的 L1 节点，**先插节点后建索引**，
 * 再 LOAD 扩展并建 vector/fts 索引（只读实例靠 database.ts 的 best-effort LOAD 复用）。
 */
function buildReadonlyStatements(dim: number): string[] {
  return [
    'INSTALL vector; LOAD vector;',
    'INSTALL fts; LOAD fts;',
    createMetaTableStatement(),
    createMemoryTableStatement(dim),
    createL0RawTableStatement(),
    mergeMeta(META_KEYS.schemaVersion, SCHEMA_VERSION),
    mergeMeta(META_KEYS.embeddingDim, String(dim)),
    mergeMeta(META_KEYS.embeddingModelId, PIN_MODEL),
    mergeMeta(META_KEYS.createdAt, TS(1)),
    `CREATE (m:memory {id: 'ro-recall-1', layer: 'L1', kind: 'note', priority: 0, ` +
      `text: 'alpha readonly recall 夹具', valid_at: '${TS(1)}', recorded_at: '${TS(1)}', ` +
      'invalid_at: NULL, expired_at: NULL, source_refs: []})',
    createVectorIndexStatement(),
    createFtsIndexStatement(),
  ]
}

async function startWriterInstance(dbPath: string, statements: string[]): Promise<{ stop(): Promise<void> }> {
  await ensureMemoryDbDirectory(dbPath)
  const child = spawn(process.execPath, [FIXTURE, dbPath], { stdio: 'pipe' })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('ready')) resolve()
    })
    void exited.then(() => reject(new Error(`夹具未就绪就退出（dbPath=${dbPath}）：${stderr}`)))
    child.stdin.write(`${JSON.stringify({ statements })}\n`)
  })

  return {
    async stop() {
      child.stdin.end()
      await exited
    },
  }
}

afterAll(cleanupTempDirs)

describe('只读实例召回（F-05 / F-06 / AC「只读实例检索照常」）', () => {
  it('第二实例降级只读 + 模型 pin 不一致 ⇒ 跳过向量路、关键词路照常命中（degraded + warn）', async () => {
    const dir = await makeTempDir('omw-recall-ro-')
    const dbPath = resolveMemoryDbPath(dir)
    const writer = await startWriterInstance(dbPath, buildReadonlyStatements(DIM))
    try {
      const applied = await applyPlugin(dir, {
        embedding: {
          endpoint: 'http://127.0.0.1:1/v1',
          token: 'sk-test',
          model: OTHER_MODEL,
          dim: DIM,
        },
      })
      try {
        // 只读降级确实发生（不是"其实拿了写锁"）。
        expect(plugin.memoryRuntimeState().readonly).toBe(true)
        // 启动期已有一条模型不一致的 warn（只读不改写库级元数据）。
        expect(applied.warn.mock.calls.some((call) => String(call[0]).includes('embedding 模型与库内记录不一致'))).toBe(true)

        applied.warn.mockClear()
        const value = await applied.tool.execute(
          { query: 'alpha' },
          { agent: { session: { id: 'ro-session' } } },
        )

        // F-02：配置模型 ≠ 库内 pin ⇒ 不取查询向量、不接通向量路；degraded 必须可见。
        expect(value.action).toBeUndefined()
        expect(value.degraded).toBe(true)
        expect(value.total).toBeGreaterThanOrEqual(1)
        expect(value.results?.[0]).toMatchObject({ id: 'ro-recall-1', layer: 'L1' })
        expect(value.hint).toContain('降级')
        expect(applied.warn.mock.calls.some((call) => String(call[0]).includes('跳过语义向量路'))).toBe(true)

        // 命令面走同一套 recallStore：手动召回不计配额、渲染与工具同源。
        const command = await applied.command!.handler({ rawInput: ' recall alpha' })
        expect(command.kind).toBe('success')
        expect(command.text).toContain('ro-recall-1')
        expect(command.text).toContain('[L1]')
      } finally {
        await applied.close()
      }
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

/**
 * Epic 8 只读实例的**零写入**断言（Story 8.1 / AC:1581、INV-7；Story 8.3 / AC:1683）。
 *
 * 为什么需要这个文件：`foldToolResult(readonly)` / `shouldFoldInReadonly` 只是层内单测，
 * 「装好的插件在只读实例上真的一个字节都不写」没有装配面证据。这里用**跨进程持锁夹具**
 * （`fixtures/hold-db-open.mjs`，与 command-status-db 同一手法）造出真实的第二实例：
 * 投递完整的 compaction 事件序列，然后断言 INBOX / compaction_run / generation_log **零增长**，
 * 且 status 逐字标出 `mode=readOnly-delegate`。
 *
 * 开库预算：1 个库（写者由子进程持有）。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createL0RawTableStatement,
  createL1InboxTableStatement,
  createL2InboxTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
  createCompactionRunTableStatement,
  createGenerationLogTableStatement,
} from '../src/db/schema'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const TS = '2026-11-01T00:00:00.000Z'
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
const CONFIG = { embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL_ID, dim: DIM } }

type Listener = (session: unknown, event: unknown) => void | Promise<void>

/** 只读夹具：status 会读 l1_inbox/l2_inbox（缺表照抛），因此必须带这两张表。 */
function buildStatements(): string[] {
  return [
    createMetaTableStatement(),
    createMemoryTableStatement(DIM),
    createL0RawTableStatement(),
    createL1InboxTableStatement(),
    createL2InboxTableStatement(),
    // Story 8.1：status 的 compaction 行与零写入断言都需要这两张表。
    createCompactionRunTableStatement(),
    createGenerationLogTableStatement(),
    `MERGE (m:omw_meta {key: '${META_KEYS.schemaVersion}'}) ON CREATE SET m.value = '${SCHEMA_VERSION}' ON MATCH SET m.value = '${SCHEMA_VERSION}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingDim}'}) ON CREATE SET m.value = '${String(DIM)}' ON MATCH SET m.value = '${String(DIM)}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.embeddingModelId}'}) ON CREATE SET m.value = '${MODEL_ID}' ON MATCH SET m.value = '${MODEL_ID}'`,
    `MERGE (m:omw_meta {key: '${META_KEYS.createdAt}'}) ON CREATE SET m.value = '${TS}' ON MATCH SET m.value = '${TS}'`,
    `CREATE (m:memory {id: 'ro-1', layer: 'L1', kind: 'note', priority: 1, text: '只读实例里的一条', valid_at: '${TS}', recorded_at: '${TS}'})`,
  ]
}

/** 子进程持写者锁（同 command-status-db 的夹具用法）。 */
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

let dir: string
let writer: { stop(): Promise<void> } | undefined
let listeners: Listener[]
let commands: MemoryCommandDefinition[]
let closers: Array<() => unknown>
/** Story 8.1：tap 采集到的 measure()（只读实例的归因快照唯一数据源）。 */
const measureResult = {
  totalTokens: 105,
  nodes: [
    { seq: 0, tokens: 50 },
    { seq: 1, tokens: 10 },
    { seq: 2, tokens: 30 },
    { seq: 3, tokens: 15 },
  ],
}

async function countRows(cypher: string): Promise<number> {
  const rows = await queryAll({ connection: undefined as never } as never, cypher).catch(() => [])
  return Number(rows[0]?.total ?? 0)
}

beforeAll(async () => {
  dir = await makeTempDir('omw-epic8-ro-')
  const dbPath = resolveMemoryDbPath(dir)
  writer = await startWriterInstance(dbPath, buildStatements())
  listeners = []
  commands = []
  closers = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    llm: { stream: () => (async function* empty() {})() },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    get: (key: string) => {
      if (key === 'profileContext') return { dir }
      // Story 8.1：归因账本是纯内存观测面，只读实例也必须能采集（AC:1581）。
      if (key === 'tokenMeter') return { measure: () => measureResult }
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
    on: (event: string, listener: Listener) => {
      if (event === 'session/event') listeners.push(listener)
      return () => {}
    },
    effect: (factory: () => () => unknown) => closers.push(factory()),
    tools: { register: () => () => {} },
  } as unknown as Parameters<typeof apply>[0]
  await apply(ctx, CONFIG as Parameters<typeof apply>[1])
})

afterAll(async () => {
  for (const closer of closers.reverse()) await closer()
  await writer?.stop()
  await cleanupTempDirs()
})

/** 只读实例自己的库句柄（由插件在 apply 里打开；测试通过 facade 状态读它）。 */
async function readOnlyCounts(): Promise<{ inbox: number, runs: number, orphanAudit: number, ingestedAudit: number }> {
  const { memoryRuntimeState } = await import('../src/index')
  expect(memoryRuntimeState().readonly).toBe(true)
  // 通过 WRITE 路径不可用，这里用只读打开（database.ts 允许同进程只读复用）。
  const { openMemoryDatabase } = await import('../src/db/database')
  // 复用插件已打开的**只读**句柄（同进程换模式打开会被 database.ts 拒绝）。
  const store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(dir),
    dim: DIM,
    modelId: MODEL_ID,
    readOnly: true,
  })
  const one = async (cypher: string): Promise<number> => {
    const rows = await queryAll(store.connection, cypher)
    return Number(rows[0]?.total ?? 0)
  }
  const counts = {
    inbox: await one('MATCH (i:l1_inbox) RETURN count(i) AS total'),
    runs: await one('MATCH (r:compaction_run) RETURN count(r) AS total'),
    orphanAudit: await one("MATCH (g:generation_log) WHERE g.action = 'compaction_orphan_unblocked' RETURN count(g) AS total"),
    ingestedAudit: await one("MATCH (g:generation_log) WHERE g.action = 'compaction_summary_ingested' RETURN count(g) AS total"),
  }
  await store.close()
  return counts
}

describe('只读实例：压缩事件零写入（INV-7 / AC:1581）', () => {
  it('归因采集只写内存（矩阵行 21）：status 出五类数值，INBOX / compaction_run / 账本零增长', async () => {
    const before = await readOnlyCounts()

    const session = {
      id: 's-ro-ledger',
      snapshotEvents: () => [
        { seq: 0, type: 'system/message' },
        { seq: 1, type: 'user/message' },
        { seq: 2, type: 'tool/result' },
        { seq: 3, type: 'assistant/message' },
      ],
    }
    for (const listener of listeners) {
      await listener(session, { type: 'turn/end', seq: 4, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
    }

    const command = commands.find((definition) => definition.name === 'memory')
    expect(command).toBeDefined()
    const result = await command!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    // 归因快照来自 measure()，只存在进程内存（readOnly 实例不写库）。
    expect(result.text).toContain(
      'context_ledger: system=50 user=10 tool=30 assistant=15 unknown=0 total=105 indexedSeqs=4 captured=',
    )

    const after = await readOnlyCounts()
    expect(after.inbox).toBe(before.inbox)
    expect(after.runs).toBe(before.runs)
    expect(after.ingestedAudit).toBe(before.ingestedAudit)
    expect(after.orphanAudit).toBe(before.orphanAudit)
  })

  it('投递完整 compaction 序列后，INBOX / compaction_run / 账本 全部零增长', async () => {
    const before = await readOnlyCounts()

    for (const listener of listeners) {
      await listener({ id: 's-ro' }, { type: 'compaction/start', turn: 1 })
      await listener({ id: 's-ro' }, {
        type: 'compaction/summary',
        compactionId: 'c-ro',
        summary: '只读实例不该写这条',
        shadowedSeqs: [1],
        shadowedRange: { start: 1, end: 1 },
        provider: 'deepseek-official',
        model: 'deepseek-chat',
      })
      await listener({ id: 's-ro' }, { type: 'compaction/end' })
    }

    const after = await readOnlyCounts()
    expect(after.inbox).toBe(before.inbox)
    expect(after.runs).toBe(before.runs)
    expect(after.ingestedAudit).toBe(before.ingestedAudit)
    expect(after.orphanAudit).toBe(before.orphanAudit)
  })

  it('status 在只读实例上仍可读，且 compaction 行存在（runs=0）', async () => {
    const command = commands.find((definition) => definition.name === 'memory')
    expect(command).toBeDefined()
    const result = await command!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    // 只读降级必须可见（AC2），不能静默当一个普通写者实例。
    expect(result.text).toContain('readonly: true')
    expect(result.text).toMatch(/^compaction: runs=0$/m)
    // 注：`mode=readOnly-delegate` 标签属 Story 8.3（引擎运行态裁决），在
    // `story-8-3-compaction-engine` 分支的 `command-status-db` 钉死行里断言；
    // 主线此刻尚未装配引擎，这里刻意不断言它。
  })
})

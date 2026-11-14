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
 * - **配置装配**（F-05）：`rrfK` 由 Config 真实传入内核（同数据在 rrfK=1 / 60 下排序翻转），
 *   且 `degraded` / `hint` / `total` 由真实内核透传到工具输出——漏传会被断言直接拦住。
 *
 * 开库次数：4 次（只读夹具 + 写者路径 3 个独立配置各 1），低于每文件 ≤12 的限制。
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import type { MemoryCommandDefinition } from '../src/command'
import { openMemoryDatabase } from '../src/db/database'
import { writeEvidenceEdges, writeRelatedEdges } from '../src/db/edges'
import { memoryNodeId } from '../src/db/id'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createFtsIndexStatement,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createEvidenceTableStatement,
  createMetaTableStatement,
  createRelatedTableStatement,
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

/** `memory_related` 工具的最小结构视图（Story 3.2 / B4 装配面）。 */
interface CapturedRelatedTool {
  name: string
  execute: (args: { id: string; depth?: number }, exec?: unknown) => Promise<{
    id?: string
    depth?: number
    total?: number
    results?: Array<{
      id: string
      layer: string
      hops: number
      edge_type: string
      reason?: string
      text: string
      invalid?: boolean
      invalid_at?: string
    }>
    hint?: string
    partial?: boolean
    action?: 'failed'
    error?: { code: string; message: string; retryable: boolean }
  }>
}

interface CapturedApply {
  readonly tool: CapturedTool
  readonly relatedTool: CapturedRelatedTool
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
  const relatedTool = tools.find((candidate) => candidate.name === 'memory_related') as CapturedRelatedTool | undefined
  if (!relatedTool) throw new Error('apply 未注册 memory_related 工具（Story 3.2 / B4）')
  return {
    tool,
    relatedTool,
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
    // Story 3.2 / B4：只读关联遍历夹具——两类边表 + 一个**不含 alpha** 的邻居（不污染上面的
    // recall 断言：关键词路按 'alpha' 只命中 ro-recall-1；向量路因模型 pin 不一致被跳过）。
    createEvidenceTableStatement(),
    createRelatedTableStatement(),
    `CREATE (m:memory {id: 'ro-related-b', layer: 'L1', kind: 'note', priority: 0, ` +
      `text: '关联遍历只读邻居', valid_at: '${TS(1)}', recorded_at: '${TS(1)}', ` +
      'invalid_at: NULL, expired_at: NULL, source_refs: []})',
    "MATCH (a:memory {id: 'ro-recall-1'}), (b:memory {id: 'ro-related-b'}) " +
      "CREATE (a)-[:RELATED {reason: 'rel-ro'}]->(b)",
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

describe('配额端到端（F-08 / spec D7）', () => {
  it('工具侧会话键与 turn/end 监听侧键同一只桶；exec.agent 缺失归 unknown 且在无 session 的 turn 边界同样恢复', async () => {
    const dir = await makeTempDir('omw-recall-quota-')
    const applied = await applyPlugin(dir, {})
    try {
      // 用 `/memory remember` 的真写路径种一条可召回记忆（命令不计配额）。
      expect((await applied.command!.handler({ rawInput: ' remember quota e2e alpha' })).kind).toBe('success')

      // 工具侧 owner = exec.agent.session（经 inboxSessionKey 取 's1'）。
      const exec = { agent: { session: { id: 's1' } } }
      for (let i = 0; i < 3; i += 1) {
        const value = await applied.tool.execute({ query: 'alpha' }, exec)
        expect(value.action).toBeUndefined()
        // F-05 装配漏传：真内核的 degraded / hint 必须透传到工具输出（本用例 embedding 未配置）。
        expect(value.degraded).toBe(true)
        expect(value.hint).toContain('降级')
      }
      // 第 4 次（同轮合计）：quota_exceeded，不抛异常。
      const blocked = await applied.tool.execute({ query: 'alpha' }, exec)
      expect(blocked.error).toMatchObject({ code: 'quota_exceeded', retryable: false })

      // 监听侧（apply 注册的 session/event 配额重置点，listeners[0] 是最早注册的那个）收到
      // 同形态 session 对象 ⇒ 与工具侧落到同一只桶：turn/end 后配额恢复。
      applied.listeners[0]!({ id: 's1' }, { type: 'turn/end' })
      expect((await applied.tool.execute({ query: 'alpha' }, exec)).action).toBeUndefined()

      // Story 3.2 / B4：memory_related 与 memory_recall 共享**同一配额桶**——reset 后已用 1 次
      // （recall）；再拼 2 次（related + recall）⇒ 满 3；第 4 次不论哪个工具都拒。
      expect((await applied.relatedTool.execute({ id: 'absent-id' }, exec)).action).toBeUndefined()
      expect((await applied.tool.execute({ query: 'alpha' }, exec)).action).toBeUndefined()
      const sharedBlocked = await applied.relatedTool.execute({ id: 'absent-id' }, exec)
      expect(sharedBlocked.error).toMatchObject({ code: 'quota_exceeded', retryable: false })
      applied.listeners[0]!({ id: 's1' }, { type: 'turn/end' })

      // `/memory related` 命令面**不计配额**（与 `/memory recall` 同口径）：随后 3 次工具
      // 调用仍全部放行；命令本身走真 deps（起点存在但无邻居 ⇒ 成功值「无匹配记忆。」）。
      const startId = memoryNodeId('L1', 'quota e2e alpha')
      const relatedCommand = await applied.command!.handler({ rawInput: ` related ${startId}` })
      expect(relatedCommand.kind).toBe('success')
      for (let i = 0; i < 3; i += 1) {
        expect((await applied.tool.execute({ query: 'alpha' }, exec)).action).toBeUndefined()
      }
      applied.listeners[0]!({ id: 's1' }, { type: 'turn/end' })

      // exec.agent 缺失 ⇒ 'unknown' 桶；耗尽后，无 session 的 turn/end 派发也必须能恢复它
      // （否则某宿主路径缺 exec.agent 时 unknown 桶进程内永不恢复，F-08 的核心场景）。
      for (let i = 0; i < 3; i += 1) await applied.tool.execute({ query: 'alpha' })
      expect((await applied.tool.execute({ query: 'alpha' })).error).toMatchObject({ code: 'quota_exceeded' })
      applied.listeners[0]!(null, { type: 'turn/end' })
      expect((await applied.tool.execute({ query: 'alpha' })).action).toBeUndefined()

      // Story 3.2 / B4：写者实例的真库关联遍历。复用 applyPlugin 已打开的写者 facade
      // （同进程同路径不新开 Database），所以本用例的开库次数不变。
      const db = await openMemoryDatabase({
        dbPath: resolveMemoryDbPath(dir),
        dim: 1024,
        modelId: 'bge-m3',
      })
      const a = (await db.upsertMemory({ layer: 'L1', text: 'related e2e a' })).id
      const b = (await db.upsertMemory({ layer: 'L1', text: 'related e2e b' })).id
      const c = (await db.upsertMemory({ layer: 'L2', text: 'related e2e c' })).id
      const invalidStart = (await db.upsertMemory({ layer: 'L1', text: 'related e2e invalid start' })).id
      const invalidNeighbor = (await db.upsertMemory({ layer: 'L1', text: 'related e2e invalid neighbor' })).id
      await db.connection.query(
        `CREATE (l:l0_raw {id: 'rel-e2e-l0', raw_text: 'raw', recorded_at: '${TS(1)}', actor: 'test'})`,
      )
      await writeEvidenceEdges(db.connection, [
        { fromId: 'rel-e2e-l0', fromLayer: 'L0', toId: a, toLayer: 'L1', reason: 'ev-l0-a' },
        { fromId: a, fromLayer: 'L1', toId: c, toLayer: 'L2', reason: 'ev-a-c' },
      ])
      await writeRelatedEdges(db.connection, [
        { fromId: a, toId: b, reason: 'rel-a-b' },
        { fromId: invalidStart, toId: invalidNeighbor, reason: 'rel-inv' },
      ])
      const markInvalid = await db.connection.prepare('MATCH (m:memory {id: $id}) SET m.invalid_at = $invalid_at')
      await db.connection.execute(markInvalid, { id: invalidStart, invalid_at: TS(5) })

      const relatedExec = { agent: { session: { id: 'rel-e2e' } } }
      const relatedValue = await applied.relatedTool.execute({ id: a, depth: 2 }, relatedExec)
      expect(relatedValue.action).toBeUndefined()
      const neighbourById = new Map((relatedValue.results ?? []).map((item) => [item.id, item]))
      expect(neighbourById.get(b)).toMatchObject({ hops: 1, edge_type: 'RELATED', reason: 'rel-a-b' })
      expect(neighbourById.get(c)).toMatchObject({ hops: 1, edge_type: 'EVIDENCE', reason: 'ev-a-c' })
      // D2：无向 EVIDENCE 的另一端是 l0_raw，端点约束保证它不进结果面。
      expect(relatedValue.results?.some((item) => item.id === 'rel-e2e-l0')).toBe(false)
      expect(relatedValue.hint).toBeUndefined()

      // D5 ② + B4 裁定：起点自身失效仍照常遍历（不判 evidence expired），hint 可见。
      const fromInvalid = await applied.relatedTool.execute({ id: invalidStart }, relatedExec)
      expect(fromInvalid.results?.map((item) => item.id)).toEqual([invalidNeighbor])
      expect(String(fromInvalid.hint)).toContain('起点已失效')

      // AC:882-884：起点不存在 ⇒ 成功值 + 未找到 hint（不抛错）。
      const missing = await applied.relatedTool.execute({ id: 'absent-id' }, relatedExec)
      expect(missing).toMatchObject({ total: 0, results: [], hint: '未找到该记忆。' })
    } finally {
      await applied.close()
    }
  }, 30_000)
})

describe('配置装配（F-05）：rrfK 从 Config 真实传入内核', () => {
  let server: Server
  let endpoint: string

  /**
   * 假 embeddings 端点：单条输入（recall 的 embedQuery）返回固定查询向量 [1,0,0,0]；
   * 多条输入（写者后台的 NULL 向量回填批次）返回维度不符的向量 ⇒ 回填记 dim-mismatch
   * 失败、节点三列保持 NULL——否则回填会在本测试的种子写入期间竞态地给 X/K2/K3 补上
   * 查询向量，夹具的「X 只在关键词路、Y 在两路」前提就被破坏了。
   */
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown[] }
        const embedding = (body.input?.length ?? 0) === 1 ? [1, 0, 0, 0] : Array.from({ length: 8 }, () => 0)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ embedding, index })) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('假 embeddings 端点未监听')
    endpoint = `http://127.0.0.1:${address.port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /**
   * rrfK 翻转夹具（6 条 L1、同层同 priority）：
   * - X：关键词 rank1（tf 4）、无向量 ⇒ rrf = 1/(k+1)；
   * - Y：向量 rank3（V1/V2 更近）+ 关键词 rank4（tf 1）⇒ rrf = 1/(k+3) + 1/(k+4)；
   * - V1/V2：仅向量路 rank1/rank2；K2/K3：仅关键词路 rank2/rank3。
   * k=1 时 X(0.5) > Y(0.45)；k=60 时 Y(≈0.0315) > X(≈0.0164)——排序随 rrfK 翻转。
   *
   * 种子在 apply **之前**写入（先直开建库）：apply 一启动就挂上 NULL 向量回填的
   * maintenance 钩子，若在 apply 之后播种，回填轮次可能夹在播种中间把 X 单独补上
   * 查询向量（实测发生过），夹具前提就被竞态破坏。预播种后 3 个 NULL 节点恒定成批 ⇒
   * 假端点按「多条输入返回维度不符」拒绝，回填只会记失败审计，绝不写向量。
   */
  async function probeOrder(rrfK: number): Promise<readonly string[]> {
    const dir = await makeTempDir(`omw-recall-rrfk${rrfK}-`)
    const dbPath = resolveMemoryDbPath(dir)
    const db = await openMemoryDatabase({ dbPath, dim: DIM, modelId: 'bge-m3' })
    const seed = (text: string, embedding: readonly number[] | null) =>
      db.upsertMemory({ layer: 'L1', text, embedding })
    await seed('rrfkprobe rrfkprobe rrfkprobe rrfkprobe x', null) // X（关键词 rank1）
    await seed('rrfkprobe rrfkprobe rrfkprobe k2', null) // K2（关键词 rank2）
    await seed('rrfkprobe rrfkprobe k3', null) // K3（关键词 rank3）
    await seed('rrfkprobe y', [0.5, 0.5, 0, 0]) // Y（关键词 rank4 + 向量 rank3）
    await seed('v one', [0.95, 0.05, 0, 0]) // V1（向量 rank1）
    await seed('v two', [0.9, 0.1, 0, 0]) // V2（向量 rank2）

    const applied = await applyPlugin(dir, {
      embedding: { endpoint, token: 'sk-test', model: 'bge-m3', dim: DIM },
      rrfK,
    })
    try {
      const value = await applied.tool.execute(
        { query: 'rrfkprobe', limit: 20 },
        { agent: { session: { id: 'rrfk-probe' } } },
      )
      // 两路都参与（真 embeddings 端点）：非降级 + hint 说明混合检索（F-05 的 hint 透传）。
      expect(value.degraded).toBeUndefined()
      expect(value.hint).toContain('混合检索')
      expect(value.total).toBe(6)
      return (value.results ?? []).map((item) => item.id)
    } finally {
      await applied.close()
    }
  }

  it('rrfK=1 与 rrfK=60 给出相反的 X/Y 顺序（漏传或错配 Config 即红）', async () => {
    const x = memoryNodeId('L1', 'rrfkprobe rrfkprobe rrfkprobe rrfkprobe x')
    const y = memoryNodeId('L1', 'rrfkprobe y')
    const slow = await probeOrder(60) // k 大 ⇒ 多路低位的 Y（RRF 累加）反超
    expect(slow.indexOf(y)).toBeGreaterThanOrEqual(0)
    expect(slow.indexOf(x)).toBeGreaterThanOrEqual(0)
    expect(slow.indexOf(y)).toBeLessThan(slow.indexOf(x))
    const fast = await probeOrder(1) // k 小 ⇒ 单路 rank1 的 X 反超
    expect(fast.indexOf(y)).toBeGreaterThanOrEqual(0)
    expect(fast.indexOf(x)).toBeGreaterThanOrEqual(0)
    expect(fast.indexOf(x)).toBeLessThan(fast.indexOf(y))
  }, 30_000)
})

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
        // F-06：只读扩展 LOAD 成功（夹具已 INSTALL）⇒ 不出现装载失败 warn；
        // 该 warn 的组合面（vector/fts 逐项原因）由 backend 的 install:false 单测钉住。
        expect(applied.warn.mock.calls.some((call) => String(call[0]).includes('装载 vector/fts 扩展失败'))).toBe(false)

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

        // Story 3.2 / B4：只读实例的关联遍历同样是纯读路径（真库 RELATED 邻居可达）。
        const related = await applied.relatedTool.execute(
          { id: 'ro-recall-1' },
          { agent: { session: { id: 'ro-related' } } },
        )
        expect(related.action).toBeUndefined()
        expect(related.results?.map((item) => item.id)).toEqual(['ro-related-b'])
        expect(related.results?.[0]).toMatchObject({ hops: 1, edge_type: 'RELATED', reason: 'rel-ro' })
      } finally {
        await applied.close()
      }
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

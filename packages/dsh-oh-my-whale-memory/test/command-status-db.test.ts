/**
 * `/memory status` 真库集成测试（Story 1.9 / AC1-AC5）。
 *
 * 沿用 command-browse-db.test.ts 范式（mkdtemp → 真实库 dim=4，
 * 裸 ctx 驱动 apply 捕获 commands.register 的定义），在最外层表面验证：
 * - AC1：四层计数来自 `memory.layer` 的真实分布（含 0 层的显式呈现；夹具含一条 L1 墓碑，
 *   钉住「全行计数、不套失效过滤」的口径——status 回答系统规模，不是 list 的有效快照）；
 * - AC2：embedding 配置缺 token / 缺 model → `disabled（降级检索）`；
 * - AC3：只读实例（写者锁被另一进程持有）标注 `readonly: true` + 逐字原因，计数照常；
 * - AC4：空库返回四层与 failed 全 0（不是「记忆库未就绪」）；
 * - AC5：status 全程本地——不发起任何 fetch。
 *
 * 库未就绪（无 profileContext）的真实路径也在此覆盖：命令层假 dep 的同类断言在
 * command-status.test.ts，这里证明的是真实 `getStatus` 读依赖抛出的文案。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll, type MemoryConnection } from '../src/db/memory'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createL0RawTableStatement,
  createL1InboxTableStatement,
  createL2InboxTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { READONLY_REASON } from '../src/db/writer-lock'
import { l2InboxQueue } from '../src/inbox/queue'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
// P6 起 endpoint 也是 enabled 的必要项：本夹具的本意是「配置齐全 ⇒ status 打印 embedding: enabled」。
const EMBEDDING_CONFIG = {
  embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL_ID, dim: DIM },
}
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
const TS = (seconds: number): string => `2026-11-01T00:00:${String(seconds).padStart(2, '0')}.000Z`

/** 主用例的层分布：L1=3（含 1 条墓碑）、L2=1、L1_INBOX=3、L2_INBOX=0（刻意留一个 0 层）。 */
const SEEDS: Array<{ layer: string; text: string }> = [
  { layer: 'L1', text: '状态夹具 L1 一' },
  { layer: 'L1', text: '状态夹具 L1 二' },
  { layer: 'L2', text: '状态夹具 L2 一' },
  { layer: 'L1_INBOX', text: '状态夹具 L1_INBOX 一' },
  { layer: 'L1_INBOX', text: '状态夹具 L1_INBOX 二' },
  { layer: 'L1_INBOX', text: '状态夹具 L1_INBOX 三' },
]

/**
 * 口径钉死夹具：一条 invalid_at 置位的 L1 墓碑。status 是全行计数（系统规模），
 * 与 list 的「有效快照」不同——若聚合语句被误加上失效过滤，AC1 的整段 toBe 会变红。
 */
const TOMBSTONE_TEXT = '状态夹具 L1 墓碑（已失效）'

let dir: string
let dbPath: string
let connection: MemoryConnection
let registered: MemoryCommandDefinition | undefined
/** ctx.get 请求过的 key：AC5 用它证明 status 没有触碰 llm。 */
let requestedKeys: string[] = []

/** 裸 ctx（同 command-browse-db.test.ts）：捕获命令定义，并记录注入点请求。 */
function makeCtx(
  profileDir: string | undefined,
  registeredDefs: MemoryCommandDefinition[],
  keys: string[] = [],
): Parameters<typeof plugin.apply>[0] {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => {
      keys.push(key)
      if (key === 'profileContext') return profileDir === undefined ? undefined : { dir: profileDir }
      if (key === 'commands') {
        return {
          register: (definition: MemoryCommandDefinition) => {
            registeredDefs.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect: (factory: () => () => unknown) => factory(),
    tools: { register: () => () => {} },
  } as unknown as Parameters<typeof plugin.apply>[0]
}

/** 各层真实行数（不依赖分组合聚合，逐层 count——被测实现的主路径才用分组聚合）。 */
async function countLayer(layer: string): Promise<number> {
  const rows = await queryAll(connection, `MATCH (m:memory {layer: '${layer}'}) RETURN count(m) AS total`)
  return Number(rows[0]?.total)
}

/** 夹具专用：直写墓碑列（生产写路径不含 expired_at / invalid_at），同 command-browse-db。 */
async function setTombstone(column: 'invalid_at' | 'expired_at', id: string, at: string): Promise<void> {
  await queryAll(connection, `MATCH (m:memory) WHERE m.id = '${id}' SET m.${column} = '${at}' RETURN m.id AS id`)
}

/**
 * auditGap 缺省 1：主夹具里那条 L1 墓碑没有 keyed 裁决记录（AD-21 的差额）。
 * unembedded 缺省 0（Story 2.4 / U5）：>0 时 embedding 行追加「未嵌入 N 条」；
 * 计数口径 = 仍有效（invalid_at / expired_at 均 NULL）且 embedding 为 NULL 的行。
 */
function statusText(
  overrides: Partial<Record<string, number>> = {},
  auditGap: number = 1,
  unembedded: number = 0,
  evidenceGap: { total: number; eiiViolations: number; drift: number } | null = { total: 0, eiiViolations: 0, drift: 0 },
  relatedSkipped: number | null = 0,
): string {
  const lines = [
    '记忆状态',
    `L1: ${overrides.L1 ?? 3}`,
    `L2: ${overrides.L2 ?? 1}`,
    `L1_INBOX: ${overrides.L1_INBOX ?? 3}`,
    `L2_INBOX: ${overrides.L2_INBOX ?? 0}`,
    'failed: 0',
    `audit_gap: ${auditGap}`,
    unembedded > 0 ? `embedding: enabled（未嵌入 ${unembedded} 条）` : 'embedding: enabled',
    'systemOne: enabled',
    'readonly: false',
  ]
  // Story 2.6 / F2：边侧差额与关系降级——与 command.ts 同一渲染口径。
  if (evidenceGap === null) {
    lines.push('evidence_gap: 未知（边表缺失）')
  } else if (evidenceGap.total > 0) {
    lines.push(`evidence_gap: ${evidenceGap.total}（EII ${evidenceGap.eiiViolations} / 漂移 ${evidenceGap.drift}）`)
  }
  if (relatedSkipped === null) lines.push('related_skipped: 未知（审计表缺失）')
  else if (relatedSkipped > 0) lines.push(`related_skipped: ${relatedSkipped}`)
  return lines.join('\n')
}

beforeAll(async () => {
  dir = await makeTempDir('omw-status-')
  dbPath = resolveMemoryDbPath(dir)

  const registeredDefs: MemoryCommandDefinition[] = []
  await plugin.apply(makeCtx(dir, registeredDefs, requestedKeys), EMBEDDING_CONFIG)
  registered = registeredDefs[0]

  // 同路径复用 apply 建好的 facade（database.ts 按绝对路径缓存）。
  const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })
  connection = store.connection
  for (const [index, seed] of SEEDS.entries()) {
    await store.upsertMemory({
      layer: seed.layer,
      text: seed.text,
      validAt: TS(index + 1),
      recordedAt: TS(index + 1),
    })
  }

  // L1 墓碑：照常计入 L1 规模（全行计数口径的夹具证据）。
  const tombstoneId = (await store.upsertMemory({ layer: 'L1', text: TOMBSTONE_TEXT, recordedAt: TS(7) })).id
  await setTombstone('invalid_at', tombstoneId, '2026-11-02T00:00:00.000Z')
})

afterAll(cleanupTempDirs)

describe('AC1：层计数来自 memory.layer 的真实分布', () => {
  it('夹具前置成立：库内确实是 L1=3（含 1 条墓碑）/ L2=1 / L1_INBOX=3 / L2_INBOX=0', async () => {
    expect(await countLayer('L1')).toBe(3)
    expect(await countLayer('L2')).toBe(1)
    expect(await countLayer('L1_INBOX')).toBe(3)
    expect(await countLayer('L2_INBOX')).toBe(0)
    // 墓碑确实存在（口径夹具的前置证据）：L1 的 3 行里有 1 行 invalid_at 置位。
    const invalid = await queryAll(
      connection,
      'MATCH (m:memory) WHERE m.invalid_at IS NOT NULL RETURN count(m) AS total',
    )
    expect(Number(invalid[0]?.total)).toBe(1)
  })

  it('status 输出四层计数 + failed: 0 + embedding/readonly 标注（逐行钉死）', async () => {
    const result = await registered!.handler({ rawInput: ' status' })

    expect(result.kind).toBe('success')
    // Story 2.4 / U5：6 条种子全无向量（那条 L1 墓碑已失效，不计入）。
    // Story 2.6 / F2：6 条种子经 upsertMemory 直写、既无 source_refs 也无 L0 前驱 ⇒
    // 全部构成 EII 违例，边侧差额追加一行；漂移为 0（无 source_refs 可漂）。
    expect(result.text).toBe(statusText({}, 1, 6, { total: 6, eiiViolations: 6, drift: 0 }))
  })

  it('计数读取不改变库内容（只读语义：再查一次层分布不变）', async () => {
    await registered!.handler({ rawInput: ' status' })

    expect(await countLayer('L1')).toBe(3)
    expect(await countLayer('L1_INBOX')).toBe(3)
  })
})

describe('AC4：空库不是「库未就绪」', () => {
  it('全新空库 → 四层与 failed 全 0，返回 success 而非 error', async () => {
    const emptyDir = await makeTempDir('omw-status-empty-')
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(emptyDir, registeredDefs), EMBEDDING_CONFIG)

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

    expect(result.kind).toBe('success')
    expect(result.text).toBe(statusText({ L1: 0, L2: 0, L1_INBOX: 0 }, 0))
    expect(result.text).not.toContain('记忆库未就绪')
  }, 30_000)
})

describe('AC2：embedding 降级在状态里显式可见', () => {
  it('缺 token → embedding: disabled（降级检索）', async () => {
    const noTokenDir = await makeTempDir('omw-status-notoken-')
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(noTokenDir, registeredDefs), { embedding: { model: MODEL_ID, dim: DIM } })

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

    expect(result.kind).toBe('success')
    expect(result.text).toContain('embedding: disabled（降级检索）')
    expect(result.text).not.toContain('embedding: enabled')
  }, 30_000)

  it('缺 model → embedding: disabled（降级检索）', async () => {
    const noModelDir = await makeTempDir('omw-status-nomodel-')
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(noModelDir, registeredDefs), { embedding: { token: 'sk-test', dim: DIM } })

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

    expect(result.kind).toBe('success')
    expect(result.text).toContain('embedding: disabled（降级检索）')
  }, 30_000)
})

describe('AC5：status 全程本地', () => {
  it('执行 status 不发起网络请求，也不新增任何注入点请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // 不能用 not.toContain('llm')：inject 只有 commands/settings/tools，该断言恒真。
    // 改为「执行前后注入点请求序列不变」，可捕捉 status 新增的任何 ctx.get。
    const keysBefore = [...requestedKeys]
    try {
      const result = await registered!.handler({ rawInput: ' status' })

      expect(result.kind).toBe('success')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(requestedKeys).toEqual(keysBefore)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('Story 2.5 / 评审 P13（T12）：L2_INBOX 是队列深度，不是 memory 层计数', () => {
  it('l2_inbox 有 1 条 pending、memory 层 L2_INBOX 有 2 行 ⇒ 渲染 L2_INBOX: 1', async () => {
    const p13Dir = await makeTempDir('omw-status-l2inbox-')
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(p13Dir, registeredDefs), EMBEDDING_CONFIG)

    const store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(p13Dir), dim: DIM, modelId: MODEL_ID })
    // memory 层的历史口径行：Story 1.7 存量形状，**不该**被算进 L2_INBOX。
    await store.upsertMemory({ layer: 'L2_INBOX', text: 'P13 历史 L2_INBOX 一', recordedAt: TS(1) })
    await store.upsertMemory({ layer: 'L2_INBOX', text: 'P13 历史 L2_INBOX 二', recordedAt: TS(2) })
    // 真实队列深度：1 条 pending。
    await l2InboxQueue.enqueue(store.connection, { id: 'p13-q1', payload: '{"l1Ids":["x"]}', now: new Date('2026-11-01T00:00:05.000Z') })

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('L2_INBOX: 1')
    expect(result.text).not.toContain('L2_INBOX: 2')
    await store.close()
  }, 30_000)
})

describe('库未就绪：无 profileContext 时 status 明确报错（读 dep 惰性）', () => {
  it('真实 getStatus 抛出的文案含「记忆库未就绪」，不静默返回 0', async () => {
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(undefined, registeredDefs), EMBEDDING_CONFIG)

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
    expect(result.text).not.toContain('L1: 0')
  })
})

// ---------------------------------------------------------------------------
// AC3：只读实例。跨进程是 AD-12 的真实场景（两个 DSH 窗口 = 两个进程），且
// database.ts 禁止同进程内同路径换模式打开，所以用 fixtures/hold-db-open.mjs
// 扮演「持锁的第一实例」（同 command-browse-db.test.ts）。
// ---------------------------------------------------------------------------

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/** 只读打开只校验 meta + memory 表与 dim（不建索引、不装扩展），故夹具无需 INSTALL/LOAD。 */
function buildReadonlyStatements(dim: number): string[] {
  const memory = (id: string, layer: string, text: string, at: string): string =>
    `CREATE (m:memory {id: '${id}', layer: '${layer}', kind: 'note', priority: 1, ` +
    `text: '${text}', valid_at: '${at}', recorded_at: '${at}'})`
  return [
    createMetaTableStatement(),
    createMemoryTableStatement(dim),
    createL0RawTableStatement(),
    // Story 2.2：/memory status 读 l1_inbox 的 failed 计数（缺表照抛），只读夹具必须带这张表。
    createL1InboxTableStatement(),
    // Story 2.5 / U1：L2_INBOX 行改读 l2_inbox 的真实队列深度，同样缺表照抛（与 l1_inbox
    // 同一约定，不静默报 0），故只读夹具也必须带这张表。
    createL2InboxTableStatement(),
    mergeMeta(META_KEYS.schemaVersion, SCHEMA_VERSION),
    mergeMeta(META_KEYS.embeddingDim, String(dim)),
    mergeMeta(META_KEYS.embeddingModelId, MODEL_ID),
    mergeMeta(META_KEYS.createdAt, TS(1)),
    memory('ro-status-1', 'L1', '只读实例 L1 一', TS(1)),
    memory('ro-status-2', 'L1', '只读实例 L1 二', TS(2)),
    memory('ro-status-3', 'L2', '只读实例 L2 一', TS(3)),
    memory('ro-status-4', 'L1_INBOX', '只读实例收件箱一', TS(4)),
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

describe('AC3：只读实例下 status 标注 readonly 与逐字原因，计数照常', () => {
  it('写者持锁 → readonly: true, reason: <READONLY_REASON>；层计数仍读得到', async () => {
    const roDir = await makeTempDir('omw-status-ro-')
    const roDbPath = resolveMemoryDbPath(roDir)
    const writer = await startWriterInstance(roDbPath, buildReadonlyStatements(DIM))
    try {
      const registeredDefs: MemoryCommandDefinition[] = []
      await plugin.apply(makeCtx(roDir, registeredDefs), EMBEDDING_CONFIG)
      expect(registeredDefs).toHaveLength(1)
      // 降级确实发生（不是"其实拿了写锁"）：运行态标注只读。
      expect(plugin.memoryRuntimeState().readonly).toBe(true)

      const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

      expect(result.kind).toBe('success')
      expect(result.text).toBe([
        '记忆状态',
        'L1: 2',
        'L2: 1',
        'L1_INBOX: 1',
        'L2_INBOX: 0',
        'failed: 0',
        // 只读实例的库缺审计表（夹具不建）→ 差额不可用；队列表在（Story 2.2 起 status 读它算 failed）。
        'audit_gap: 未知（审计表缺失）',
        // Story 2.4 / U5：只读夹具 4 条节点（L1×2 / L2×1 / L1_INBOX×1）全无向量。
        'embedding: enabled（未嵌入 4 条）',
        'systemOne: enabled',
        `readonly: true, reason: '${READONLY_REASON}'`,
        // Story 2.6 / F2：只读夹具既不建边表也不建审计表 ⇒ 两个差额都算不出来，
        // 与 audit_gap 同一约定显式渲染「未知」，绝不静默报 0。
        'evidence_gap: 未知（边表缺失）',
        'related_skipped: 未知（审计表缺失）',
        // Story 2.5 / 评审 P8：疑似失效账目同样缺审计表 ⇒ 渲染「未知」（同一约定）。
        'uncertain: 未知（审计表缺失）',
      ].join('\n'))
      expect(result.text).toContain(READONLY_REASON)
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

/**
 * `/memory list` 与 `/memory show` 真库集成测试（Story 1.8 / AC1-AC4）。
 *
 * 沿用 db-upsert.test.ts 范式（mkdtemp → 真实库 dim=4），
 * 用裸 ctx 驱动 apply 捕获 commands.register 的定义，再调 definition.handler，
 * 在最外层表面（命令返回值 + 库内事实）上验证：
 * - AC1：25 条未失效 → list 恰返回 20 条且是最新 20（`recorded_at` 倒序，不是插入序）；
 * - AC2：`layer='L1_INBOX'` 的行可见（layer 无白名单过滤），`RRF` / `rrf` 两种写法命中同一批；
 * - AC3：`expired_at` / `invalid_at` 非空的行在列表里隐藏，但 `show` 仍返回并展示墓碑时间；
 * - AC4：只读实例（写者锁被另一进程持有）下 list/show 照常，remember 被拒。
 *
 * 墓碑字段（expired_at / invalid_at）用 `queryAll` 直执行 SET 制造——生产写路径不含
 * 这两个字段（Story 1.8 Design Notes 明确允许测试夹具这么做）。
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
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { READONLY_REASON } from '../src/db/writer-lock'
import { MEMORY_LIST_DEFAULT_LIMIT, type MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
/** 10 条墓碑/有效行共用的时间戳前缀：ISO-8601 UTC 可直接字典序比较。 */
const TS = (seconds: number): string => `2026-11-01T00:00:${String(seconds).padStart(2, '0')}.000Z`

interface Seed {
  layer: string
  text: string
  recordedAt: string
}

/** 25 条未失效：note 01..21 + 3 条含 RRF（其一为 L1_INBOX）+ 1 条尾部。 */
const VALID_SEEDS: Seed[] = [
  ...Array.from({ length: 21 }, (_, index) => ({
    layer: 'L1',
    text: `note ${String(index + 1).padStart(2, '0')}`,
    recordedAt: TS(index + 1),
  })),
  { layer: 'L1', text: 'RRF 策略笔记', recordedAt: TS(22) },
  { layer: 'L2', text: 'rrf 小写命中', recordedAt: TS(23) },
  { layer: 'L1_INBOX', text: 'RRF 收件箱候选', recordedAt: TS(24) },
  { layer: 'L2', text: '尾部条目', recordedAt: TS(25) },
]

const EXPIRED_TEXT = '过期 RRF 墓碑'
const INVALID_TEXT = '作废 行'

let dir: string
let dbPath: string
let connection: MemoryConnection
let registered: MemoryCommandDefinition | undefined
const idsByText = new Map<string, string>()
/** 未失效行按 recorded_at 倒序的 id（= list 期望顺序的全量）。 */
let validIdsDesc: string[] = []
let expiredId: string
let invalidId: string

/** 裸 ctx：commands.register 捕获定义；tools.register 是 Story 1.6 起的无条件注册。 */
function makeCtx(
  profileDir: string | undefined,
  registeredDefs: MemoryCommandDefinition[],
): Parameters<typeof plugin.apply>[0] {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => {
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

/** 夹具专用：直写墓碑列（生产写路径不含 expired_at / invalid_at）。 */
async function setTombstone(column: 'invalid_at' | 'expired_at', id: string, at: string): Promise<void> {
  await queryAll(connection, `MATCH (m:memory) WHERE m.id = '${id}' SET m.${column} = '${at}' RETURN m.id AS id`)
}

/** list 文案 → id 顺序。 */
function idsFromListText(text: string): string[] {
  return text
    .split('\n')
    .slice(1)
    .map((line) => /^- (\S+) \[/.exec(line)?.[1] ?? line)
}

beforeAll(async () => {
  dir = await makeTempDir('omw-browse-')
  dbPath = resolveMemoryDbPath(dir)

  const registeredDefs: MemoryCommandDefinition[] = []
  await plugin.apply(makeCtx(dir, registeredDefs), EMBEDDING_CONFIG)
  registered = registeredDefs[0]

  // 同路径复用 apply 建好的 facade（database.ts 按绝对路径缓存）。
  const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID })
  connection = store.connection

  const seeded: Array<{ id: string; recordedAt: string }> = []
  for (const seed of VALID_SEEDS) {
    const result = await store.upsertMemory({
      layer: seed.layer,
      text: seed.text,
      validAt: seed.recordedAt,
      recordedAt: seed.recordedAt,
    })
    idsByText.set(seed.text, result.id)
    seeded.push({ id: result.id, recordedAt: seed.recordedAt })
  }
  validIdsDesc = seeded.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map((row) => row.id)

  // 两条墓碑：recorded_at 比所有有效行都新——若失效过滤失效，它们必然出现在列表首行。
  expiredId = (await store.upsertMemory({ layer: 'L1', text: EXPIRED_TEXT, recordedAt: TS(30) })).id
  await setTombstone('expired_at', expiredId, '2026-11-02T00:00:00.000Z')
  invalidId = (await store.upsertMemory({ layer: 'L1', text: INVALID_TEXT, recordedAt: TS(31) })).id
  await setTombstone('invalid_at', invalidId, '2026-11-02T00:00:00.000Z')
})

afterAll(cleanupTempDirs)

describe('apply 注册的 /memory 定义（真实库 dim=4）', () => {
  it('apply 捕获到的定义已注册且命令名为 memory（用法文案与 register 计数由 command-list-show / entry-exports 覆盖）', () => {
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('memory')
  })
})

describe('/memory list：倒序 + 上限 + 失效过滤（AC1、AC3）', () => {
  it('种子前置成立：库内未失效行恰 25 条，另有 2 条墓碑', async () => {
    const alive = await queryAll(
      connection,
      'MATCH (m:memory) WHERE m.invalid_at IS NULL AND m.expired_at IS NULL RETURN count(m) AS total',
    )
    expect(Number(alive[0]!['total'])).toBe(VALID_SEEDS.length)
    expect(VALID_SEEDS).toHaveLength(25)
    const all = await queryAll(connection, 'MATCH (m:memory) RETURN count(m) AS total')
    expect(Number(all[0]!['total'])).toBe(25 + 2)
  })

  it('25 条未失效 → 恰返回 20 条（最新 20、recorded_at 倒序，不是插入序）', async () => {
    const result = await registered!.handler({ rawInput: ' list' })

    expect(result.kind).toBe('success')
    const lines = (result.text ?? '').split('\n')
    expect(lines[0]).toBe(`记忆列表（共 ${MEMORY_LIST_DEFAULT_LIMIT} 条，最近优先）：`)
    expect(lines).toHaveLength(MEMORY_LIST_DEFAULT_LIMIT + 1)
    expect(lines[0]).not.toContain('关键词')

    const ids = idsFromListText(result.text ?? '')
    expect(ids).toEqual(validIdsDesc.slice(0, MEMORY_LIST_DEFAULT_LIMIT))
    // 最新一行是 recorded_at 最大的有效行；最早的 5 条被上限裁掉。
    expect(ids[0]).toBe(idsByText.get('尾部条目'))
    expect(ids).not.toContain(idsByText.get('note 01'))
    expect(ids).not.toContain(idsByText.get('note 05'))
    expect(ids).toContain(idsByText.get('note 06'))
  })

  it('失效墓碑在列表里隐藏（尽管它们的 recorded_at 最新）', async () => {
    const ids = idsFromListText((await registered!.handler({ rawInput: ' list' })).text ?? '')

    expect(ids).not.toContain(expiredId)
    expect(ids).not.toContain(invalidId)
    expect(ids[0]).not.toBe(expiredId)
    expect(ids[0]).not.toBe(invalidId)
  })
})

describe('/memory list <关键词>：字面包含匹配、大小写不敏感、layer 无白名单（AC2）', () => {
  it('RRF / rrf 命中同一批 3 条，含 L1_INBOX 行，且仍倒序', async () => {
    const upper = await registered!.handler({ rawInput: ' list RRF' })
    const lower = await registered!.handler({ rawInput: ' list rrf' })

    expect(upper.kind).toBe('success')
    expect(lower.kind).toBe('success')

    const expected = [
      idsByText.get('RRF 收件箱候选'),
      idsByText.get('rrf 小写命中'),
      idsByText.get('RRF 策略笔记'),
    ]
    expect(idsFromListText(upper.text ?? '')).toEqual(expected)
    expect(idsFromListText(lower.text ?? '')).toEqual(expected)
    // spec 钉死首行：带关键词时表头仍是固定文案（不回显关键词），关键词由命中行承载。
    expect((upper.text ?? '').split('\n')[0]).toBe('记忆列表（共 3 条，最近优先）：')
    expect((lower.text ?? '').split('\n')[0]).toBe('记忆列表（共 3 条，最近优先）：')
    // 命中行含关键词；`rrf` 的命中行是库里的「rrf 小写命中」（非表头回显所致）。
    expect(upper.text).toContain('RRF')
    expect(lower.text).toContain('rrf')
    // L1_INBOX 不是 layer 白名单外的东西——必须可见（当前库里确实有这种行）。
    expect(idsFromListText(upper.text ?? '')).toContain(idsByText.get('RRF 收件箱候选'))
    const inboxRows = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1_INBOX'}) RETURN m.id AS id",
    )
    expect(inboxRows.map((row) => String(row['id']))).toContain(idsByText.get('RRF 收件箱候选'))
  })

  it('关键词也受失效过滤约束：含 RRF 的过期墓碑不出现', async () => {
    const ids = idsFromListText((await registered!.handler({ rawInput: ' list RRF' })).text ?? '')
    expect(ids).not.toContain(expiredId)
  })

  it('无匹配 → 没有匹配「<关键词>」的记忆。', async () => {
    const result = await registered!.handler({ rawInput: ' list 绝不存在的关键词' })
    expect(result).toEqual({ kind: 'success', text: '没有匹配「绝不存在的关键词」的记忆。' })
  })

  it('关键词命中 21 条（note 01..21）→ 恰返回 20 条且最新优先（LIMIT 在关键词语句上同样生效）', async () => {
    const result = await registered!.handler({ rawInput: ' list note' })

    expect(result.kind).toBe('success')
    const lines = (result.text ?? '').split('\n')
    expect(lines[0]).toBe(`记忆列表（共 ${MEMORY_LIST_DEFAULT_LIMIT} 条，最近优先）：`)
    expect(lines).toHaveLength(MEMORY_LIST_DEFAULT_LIMIT + 1)

    // note 01..21 共 21 条命中，语句自带 LIMIT → 只回最新 20 条（note 21 递减到 note 02）。
    const expected = Array.from({ length: MEMORY_LIST_DEFAULT_LIMIT }, (_, index) => {
      const ordinal = 21 - index
      return idsByText.get(`note ${String(ordinal).padStart(2, '0')}`)
    })
    expect(idsFromListText(result.text ?? '')).toEqual(expected)
  })
})

describe('/memory show：完整字段 + 墓碑可见（AC3）', () => {
  it('普通行按 AC 字段顺序渲染全字段', async () => {
    const noteId = idsByText.get('note 01')!
    const result = await registered!.handler({ rawInput: ` show ${noteId}` })

    expect(result.kind).toBe('success')
    expect(result.text).toBe([
      `记忆 ${noteId}：`,
      'layer: L1',
      'kind: (空)',
      'priority: 0',
      'text: note 01',
      `valid_at: ${TS(1)}`,
      `recorded_at: ${TS(1)}`,
      'invalid_at: (空)',
      'expired_at: (空)',
      'source_refs: []',
      'embedding_model_id: (空)',
    ].join('\n'))
    expect(result.text).not.toContain('undefined')
  })

  it('过期行列表隐藏但 show 可见，并展示 expired_at 的值', async () => {
    const result = await registered!.handler({ rawInput: ` show ${expiredId}` })

    expect(result.kind).toBe('success')
    expect(result.text).toContain(`记忆 ${expiredId}：`)
    expect(result.text).toContain('text: 过期 RRF 墓碑')
    expect(result.text).toContain('expired_at: 2026-11-02T00:00:00.000Z')
    expect(result.text).toContain('invalid_at: (空)')
  })

  it('失效行同样可见，并展示 invalid_at 的值', async () => {
    const result = await registered!.handler({ rawInput: ` show ${invalidId}` })

    expect(result.kind).toBe('success')
    expect(result.text).toContain('invalid_at: 2026-11-02T00:00:00.000Z')
    expect(result.text).toContain('expired_at: (空)')
  })

  it('未知 id → error 含 id 与「未找到」，不抛出', async () => {
    const result = await registered!.handler({ rawInput: ' show no-such-id' })

    expect(result.kind).toBe('error')
    expect(result.text).toContain('未找到')
    expect(result.text).toContain('no-such-id')
  })
})

describe('库未就绪：无 profileContext 时只读子命令明确报错（读 dep 惰性）', () => {
  it('list / show 都返回 error 说明记忆库未就绪，不抛出', async () => {
    const registeredDefs: MemoryCommandDefinition[] = []
    await plugin.apply(makeCtx(undefined, registeredDefs), EMBEDDING_CONFIG)
    expect(registeredDefs).toHaveLength(1)

    const listed = await registeredDefs[0]!.handler({ rawInput: ' list' })
    expect(listed.kind).toBe('error')
    expect(listed.text).toContain('记忆库未就绪')

    const shown = await registeredDefs[0]!.handler({ rawInput: ' show whatever' })
    expect(shown.kind).toBe('error')
    expect(shown.text).toContain('记忆库未就绪')
  })
})

// ---------------------------------------------------------------------------
// AC4：只读实例。跨进程是 AD-12 的真实场景（两个 DSH 窗口 = 两个进程），且
// database.ts 禁止同进程内同路径换模式打开（createModeMismatchError），
// 所以第二实例仍用 fixtures/hold-db-open.mjs 扮演「持锁的第一实例」。
// ---------------------------------------------------------------------------

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/**
 * 只读打开只校验 meta + memory 表与 dim（不建索引、不装扩展），
 * 故夹具不需要 INSTALL/LOAD vector|fts（也就不依赖 OpenSSL 3）。
 */
function buildInitStatements(dim: number): string[] {
  return [
    createMetaTableStatement(),
    createMemoryTableStatement(dim),
    createL0RawTableStatement(),
    mergeMeta(META_KEYS.schemaVersion, SCHEMA_VERSION),
    mergeMeta(META_KEYS.embeddingDim, String(dim)),
    mergeMeta(META_KEYS.embeddingModelId, MODEL_ID),
    mergeMeta(META_KEYS.createdAt, TS(1)),
    "CREATE (m:memory {id: 'ro-readonly-1', layer: 'L2', kind: 'note', priority: 1, " +
      "text: '只读实例可见的记忆 RRF', valid_at: '2026-11-01T00:00:00.000Z', " +
      "recorded_at: '2026-11-01T00:00:00.000Z'})",
  ]
}

/** 复刻 db-readonly.test.ts 的跨进程夹具启动（此处不测 killed/陈旧锁场景，故只留 stop）。 */
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

describe('只读实例（db.readonly === true）下 list/show 照常、remember 被拒（AC4）', () => {
  it('写者持锁 → 本实例降级只读；list/show 读到别人建的行，remember 报只读', async () => {
    const roDir = await makeTempDir('omw-browse-ro-')
    const roDbPath = resolveMemoryDbPath(roDir)
    const writer = await startWriterInstance(roDbPath, buildInitStatements(DIM))
    try {
      const registeredDefs: MemoryCommandDefinition[] = []
      await plugin.apply(makeCtx(roDir, registeredDefs), EMBEDDING_CONFIG)
      expect(registeredDefs).toHaveLength(1)
      const definition = registeredDefs[0]!
      // 降级确实发生（不是"其实拿了写锁"）：运行态标注只读。
      expect(plugin.memoryRuntimeState().readonly).toBe(true)

      const listed = await definition.handler({ rawInput: ' list' })
      expect(listed.kind).toBe('success')
      expect(listed.text).toBe('记忆列表（共 1 条，最近优先）：\n- ro-readonly-1 [L2] 只读实例可见的记忆 RRF')

      const matched = await definition.handler({ rawInput: ' list rrf' })
      expect(matched.kind).toBe('success')
      expect(idsFromListText(matched.text ?? '')).toEqual(['ro-readonly-1'])

      const shown = await definition.handler({ rawInput: ' show ro-readonly-1' })
      expect(shown.kind).toBe('success')
      expect(shown.text).toContain('记忆 ro-readonly-1：')
      expect(shown.text).toContain('layer: L2')
      expect(shown.text).toContain('text: 只读实例可见的记忆 RRF')

      // 反向证明：同一实例的写入口仍被只读模式拒绝（list/show 的成功不是"库没降级"造成的）。
      const denied = await definition.handler({ rawInput: ' remember 只读实例不该写入' })
      expect(denied.kind).toBe('error')
      expect(denied.text).toContain(READONLY_REASON)
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

/**
 * `/memory forget` 落库集成测试（Story 4.1 / 命令面 → 真库；矩阵行 2、3、8）。
 *
 * 骨架照 `command-remember-db.test.ts`：裸 ctx 驱动 apply，捕获 commands.register 的定义，
 * 再以 `{ rawInput: ' forget <id>' }` 调 handler，在最外层表面（命令返回值 + 落库事实）上验证：
 * - 首次 forget：目标 expired_at 落值、上层 invalid_at 落值、generation_log / keyed_decision 各 +2；
 * - `list` 隐藏、`show` 仍可见且显示 expired_at；
 * - 第二次 forget 幂等：文案切换 + 行数不变；
 * - 不存在的 id：error 文案与 show 逐字一致，零写入。
 *
 * 本文件 1 次开库（apply 建库，测试复用同一 facade）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { resolveMemoryDbPath } from '../src/db/paths'
import { openMemoryDatabase } from '../src/db/database'
import { queryAll, type MemoryConnection } from '../src/db/memory'
import { cleanupTempDirs, makeTempDir } from './tmp'
import type { MemoryCommandDefinition, MemoryCommandInvocation } from '../src/command'

const T0 = '2026-01-01T00:00:00.000Z'

let dir: string
let dbPath: string
let connection: MemoryConnection
let registered: MemoryCommandDefinition | undefined

/** 目标（L1，有 L0 证据）与它的上层（L2 引用它）。 */
const TARGET_ID = 'cmd-forget-target'
const UPPER_ID = 'cmd-forget-upper'
const TARGET_TEXT = '命令面遗忘的原子记忆'

async function exec(statement: string): Promise<void> {
  await connection.query(statement)
}

async function countOf(statement: string): Promise<number> {
  const rows = await queryAll(connection, statement)
  return Number(rows[0]?.c ?? 0)
}

const countGenerationLog = () => countOf('MATCH (g:generation_log) RETURN count(g) AS c')
const countKeyedDecision = () => countOf('MATCH (k:keyed_decision) RETURN count(k) AS c')

/**
 * 本次 forget 自己的账本行数（按 action+policy 过滤，再在 JS 侧按 root id 匹配 reason）。
 * 不按全表行数差断言：本插件的后台消费者（inbox 回收/回填）也会写账本行，全表差会串味。
 */
async function forgetLogRows(rootId: string): Promise<string[]> {
  const rows = await queryAll(
    connection,
    "MATCH (g:generation_log) WHERE g.action = 'forget' AND g.policy = 'user-forget' RETURN g.reason AS reason",
  )
  return rows
    .map((row) => String(row.reason ?? ''))
    .filter((reason) => reason.startsWith(`forget root=${rootId} `))
}

/** 遗忘裁决的 keyed 行（old_id 列表，供「每个被作废节点一条」断言）。 */
async function forgetKeyedOldIds(): Promise<string[]> {
  const rows = await queryAll(
    connection,
    "MATCH (k:keyed_decision) WHERE k.policy = 'user-forget' RETURN k.old_id AS old_id",
  )
  return rows.map((row) => String(row.old_id)).sort()
}

/** 两列墓碑（NULL 归一成 null）。 */
async function tombstones(id: string): Promise<{ invalidAt: unknown, expiredAt: unknown }> {
  const rows = await queryAll(
    connection,
    `MATCH (m:memory {id: '${id}'}) RETURN m.invalid_at AS invalid_at, m.expired_at AS expired_at`,
  )
  return { invalidAt: rows[0]?.invalid_at ?? null, expiredAt: rows[0]?.expired_at ?? null }
}

const run = (rawInput: string): Promise<{ kind: string, text?: string }> => {
  const invocation: MemoryCommandInvocation = { rawInput }
  return registered!.handler(invocation)
}

beforeAll(async () => {
  dir = await makeTempDir('omw-command-forget-')
  dbPath = resolveMemoryDbPath(dir)

  const registeredDefs: MemoryCommandDefinition[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => (key === 'profileContext' ? { dir } : key === 'commands'
      ? { register: (definition: MemoryCommandDefinition) => { registeredDefs.push(definition); return () => {} } }
      : undefined),
    effect: (factory: () => () => unknown) => factory(),
    tools: { register: () => () => {} },
  } as unknown as Parameters<typeof plugin.apply>[0]

  await plugin.apply(ctx, {
    embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: 'bge-m3', dim: 4 },
  })
  registered = registeredDefs[0]

  const store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'bge-m3' })
  connection = store.connection

  await exec(`CREATE (l:l0_raw {id: 'cmd-forget-l0', raw_text: '原始观测', recorded_at: '${T0}', actor: 'test'})`)
  await exec(
    `CREATE (m:memory {id: '${TARGET_ID}', layer: 'L1', kind: '', priority: 0, text: '${TARGET_TEXT}',` +
    ` valid_at: '${T0}', recorded_at: '${T0}', source_refs: ['cmd-forget-l0']})`,
  )
  await exec(
    `CREATE (m:memory {id: '${UPPER_ID}', layer: 'L2', kind: '', priority: 0, text: '命令面上层结论',` +
    ` valid_at: '${T0}', recorded_at: '${T0}', source_refs: ['${TARGET_ID}']})`,
  )
  await exec(
    `MATCH (a:l0_raw {id: 'cmd-forget-l0'}), (b:memory {id: '${TARGET_ID}'}) MERGE (a)-[:EVIDENCE]->(b)`,
  )
  await exec(
    `MATCH (a:memory {id: '${TARGET_ID}'}), (b:memory {id: '${UPPER_ID}'}) MERGE (a)-[:EVIDENCE]->(b)`,
  )
})

afterAll(cleanupTempDirs)

describe('/memory forget 命令面（真实库）', () => {
  it('首次遗忘：文案逐行钉死，目标 expired_at 与上层 invalid_at 同事务落值', async () => {
    const result = await run(` forget ${TARGET_ID}`)

    expect(result.kind).toBe('success')
    expect(result.text).toBe([
      `已遗忘 ${TARGET_ID}：共作废 2 条（其中级联 1 条）`,
      `- ${UPPER_ID} [L2] 深度 1 命令面上层结论`,
      `- ${TARGET_ID} [L1] 深度 0 ${TARGET_TEXT}`,
    ].join('\n'))

    const target = await tombstones(TARGET_ID)
    const upper = await tombstones(UPPER_ID)
    expect(target.expiredAt).not.toBeNull()
    expect(target.invalidAt).toBeNull()
    expect(upper.invalidAt).not.toBeNull()
    expect(upper.expiredAt).toBeNull()
    // 两本账各两行：目标 depth=0 + 级联 victims depth=1，keyed 每个被作废节点一条。
    expect(await forgetLogRows(TARGET_ID)).toEqual([
      `forget root=${TARGET_ID} depth=0`,
      `forget root=${TARGET_ID} depth=1`,
    ])
    expect(await forgetKeyedOldIds()).toEqual([TARGET_ID, UPPER_ID].sort())
  })

  it("list 隐藏、show 仍可见并显示 expired_at（矩阵行 8）", async () => {
    const listed = await run(` list ${TARGET_TEXT}`)
    expect(listed.kind).toBe('success')
    expect(listed.text).not.toContain(TARGET_ID)

    const shown = await run(` show ${TARGET_ID}`)
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain(`记忆 ${TARGET_ID}：`)
    expect(shown.text).toContain('expired_at: ')
    expect(shown.text).not.toContain('expired_at: (空)')
  })

  it('矩阵行 2：重复 forget ⇒ 幂等文案，两本账行数不变', async () => {
    const logsBefore = await forgetLogRows(TARGET_ID)
    const keyedBefore = await forgetKeyedOldIds()

    const result = await run(` forget ${TARGET_ID}`)

    expect(result.kind).toBe('success')
    expect(result.text).toBe([
      `已遗忘 ${TARGET_ID}：本次未重复写入（此前已遗忘）`,
      `- ${TARGET_ID} [L1] 深度 0 ${TARGET_TEXT}`,
    ].join('\n'))
    expect(await forgetLogRows(TARGET_ID)).toEqual(logsBefore)
    expect(await forgetKeyedOldIds()).toEqual(keyedBefore)
  })

  it('矩阵行 3：不存在的 id ⇒ error「未找到 id 为 <id> 的记忆。」且零写入', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead'
    const logBefore = await countGenerationLog()
    const keyedBefore = await countKeyedDecision()

    const result = await run(` forget ${missing}`)

    expect(result.kind).toBe('error')
    expect(result.text).toBe(`未找到 id 为 ${missing} 的记忆。`)
    expect(await countGenerationLog()).toBe(logBefore)
    expect(await countKeyedDecision()).toBe(keyedBefore)
  })

  it('矩阵行 4：缺 id ⇒ usage error（不查库、不写库）', async () => {
    const logBefore = await countGenerationLog()
    const result = await run(' forget   ')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/memory forget <id>')
    expect(await countGenerationLog()).toBe(logBefore)
  })
})

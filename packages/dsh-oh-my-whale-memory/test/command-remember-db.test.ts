/**
 * `/memory remember` 命令落库集成测试（Story 1.7 / AC1-AC4 的库内部分）。
 *
 * 沿用 db-upsert.test.ts 范式：mkdtemp → 真实库（dim=4）。
 * 用裸 ctx 驱动 apply，捕获交给 commands.register 的定义，再以
 * `{ rawInput: ' remember 我偏好 ESM 不要 CJS' }` 调 definition.handler，
 * 在最外层表面（命令返回值 + 落库事实）上验证：
 * - success + `layer='L1'` 节点存在（Story 1.11 层收敛），三列 embedding/embedding_model_id/
 *   embedding_dim 均为 NULL（Epic 1 无 embedding 客户端的既定状态）；
 * - 同文本重复写入节点数不增（id = uuid5(layer+':'+归一化 text)）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { resolveMemoryDbPath } from '../src/db/paths'
import { openMemoryDatabase } from '../src/db/database'
import { queryAll, type MemoryConnection } from '../src/db/memory'
import { cleanupTempDirs, makeTempDir } from './tmp'
import type { MemoryCommandDefinition, MemoryCommandInvocation } from '../src/command'

let dir: string
let dbPath: string
let connection: MemoryConnection
let registered: MemoryCommandDefinition | undefined

beforeAll(async () => {
  dir = await makeTempDir('omw-command-')
  dbPath = resolveMemoryDbPath(dir)

  // 裸 ctx：effect 收 closer（此处不消费），commands.register 捕获定义；
  // tools.register 是 Story 1.6 引入的无条件注册，任何驱动 apply 的 ctx 都必须提供。
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

  // 同路径复用 apply 建好的 facade（database.ts 按绝对路径缓存），拿连接做断言。
  const store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'bge-m3' })
  connection = store.connection
})

afterAll(cleanupTempDirs)

describe('/memory remember 命令注册与执行（真实库 dim=4）', () => {
  it('apply 把名为 memory 的命令定义交给 commands.register（AC3）', () => {
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('memory')
  })

  it('remember 写入成功：L1 节点存在且三列均为 NULL（AC1 + Story 1.11 层收敛）', async () => {
    const invocation: MemoryCommandInvocation = { rawInput: ' remember 我偏好 ESM 不要 CJS' }
    const result = await registered?.handler(invocation)

    expect(result?.kind).toBe('success')

    const rows = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '我偏好 ESM 不要 CJS' RETURN m.id AS id, m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!['embedding']).toBeNull()
    expect(rows[0]!['model_id']).toBeNull()
    expect(rows[0]!['dim']).toBeNull()
  })

  it('同文本重复 remember：两次 success，节点数不增（同指纹同 id）', async () => {
    const before = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    const totalBefore = Number(before[0]!['total'])

    const first = await registered?.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    const second = await registered?.handler({ rawInput: 'remember 我偏好 ESM 不要 CJS' })
    expect(first?.kind).toBe('success')
    expect(second?.kind).toBe('success')

    const after = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    expect(Number(after[0]!['total'])).toBe(totalBefore)
  })

  it('无 payload：返回 usage error，节点数不变（AC2）', async () => {
    const before = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    const totalBefore = Number(before[0]!['total'])

    const result = await registered?.handler({ rawInput: ' remember' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('memory remember')

    const after = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    expect(Number(after[0]!['total'])).toBe(totalBefore)
  })

  it('status 走正常路径：真实库上返回 success 与四层计数（Story 1.9，不再是 usage error）', async () => {
    // Story 1.11 层收敛后：本文件的写入全部落在 L1（实时计数，与用例顺序无关）；
    // L1_INBOX 只是 INBOX 队列标识的历史计数位，本文件不再有写入命中它，故恒 0。
    const result = await registered?.handler({ rawInput: ' status' })

    // Story 2.4 / U5 + 评审 P16（T17）：**固定期望值**，不复刻生产 SQL 现算期望——
    // 否则生产过滤条件写错时，测试会跟着一起错。本用例之前本文件只写了一条 L1 记忆
    //（且不带向量），所以 L1 与「未嵌入」都恒为 1；顺序变化会立刻变红，这是有意的。
    // Story 2.6 / F2：`memory_remember` 工具写的是**没有 source_refs 的 L1 节点**（Epic 1 手动
    // 写路径），按 AD-19 它构成 1 条 EII 违例（无 L0 前驱可达），故 evidence_gap 追加一行；
    // 漂移为 0（无 source_refs 可漂）。related_skipped 为 0，不渲染。
    expect(result?.kind).toBe('success')
    expect(result?.text).toBe([
      '记忆状态',
      'L1: 1',
      'L2: 0',
      'L1_INBOX: 0',
      'L2_INBOX: 0',
      'failed: 0',
      'audit_gap: 0',
      'embedding: enabled（未嵌入 1 条）',
      'systemOne: enabled',
      'readonly: false',
      'evidence_gap: 1（EII 1 / 漂移 0）',
      'injection: 未知（本实例尚未触发开局注入）',
    ].join('\n'))
  })

  it('remember 命令的溯源行 actor=user（Story 1.10 / AD-10：三档来源不写死）', async () => {
    const before = await queryAll(connection, "MATCH (g:generation_log) WHERE g.actor = 'user' RETURN count(g) AS total")
    const result = await registered?.handler({ rawInput: ' remember 命令溯源行 actor 用例' })
    expect(result?.kind).toBe('success')

    const after = await queryAll(connection, "MATCH (g:generation_log) WHERE g.actor = 'user' RETURN count(g) AS total")
    expect(Number(after[0]!['total'])).toBe(Number(before[0]!['total']) + 1)
  })

  it('空指纹文本：收敛为 error 而非抛出（AC4）', async () => {
    const result = await registered?.handler({ rawInput: ' remember ！！！' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('归一化后为空')
  })

  it('remember 支持 --kind / --priority 旗标并落库（Story 1.11 / AC2：手动路径也能产出分类）', async () => {
    const result = await registered?.handler({
      rawInput: ' remember --kind=persona --priority=-1 我偏好先看证据再下结论',
    })
    expect(result?.kind).toBe('success')

    const rows = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '我偏好先看证据再下结论' RETURN m.kind AS kind, m.priority AS priority",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!['kind']).toBe('persona')
    // priority=-1 不得被缺省值 0 吞掉（AC1 的硬要求）。
    expect(Number(rows[0]!['priority'])).toBe(-1)
  })

  it('旗标顺序无关、正文保留内部空白（Story 1.11 / AC2）', async () => {
    const result = await registered?.handler({
      rawInput: ' remember --priority=7 --kind=work_method 先 复现 再 修',
    })
    expect(result?.kind).toBe('success')

    const rows = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '先 复现 再 修' RETURN m.kind AS kind, m.priority AS priority",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!['kind']).toBe('work_method')
    expect(Number(rows[0]!['priority'])).toBe(7)
  })

  it('非法旗标值：返回 usage error 且不写库（Story 1.11）', async () => {
    const before = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    const result = await registered?.handler({ rawInput: ' remember --priority=abc 非法优先级样例' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('memory remember')

    const after = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) RETURN count(m) AS total")
    expect(Number(after[0]!['total'])).toBe(Number(before[0]!['total']))
    const leaked = await queryAll(connection, "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '非法优先级样例' RETURN m.id AS id")
    expect(leaked).toHaveLength(0)
  })

  it('同文本不同分类：命中同一 id、以最新写入为准、逐写记 generation log（Story 1.11 / AC4）', async () => {
    const text = '同文本不同分类的收敛样例'
    const logsBefore = await queryAll(connection, "MATCH (g:generation_log) WHERE g.action = 'upsert_memory' RETURN count(g) AS total")

    const first = await registered?.handler({ rawInput: ' remember --kind=episodic --priority=5 ' + text })
    expect(first?.kind).toBe('success')
    const rowsAfterFirst = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '" + text + "' RETURN m.id AS id, m.kind AS kind, m.priority AS priority",
    )
    expect(rowsAfterFirst).toHaveLength(1)
    expect(rowsAfterFirst[0]!['kind']).toBe('episodic')

    const second = await registered?.handler({ rawInput: ' remember --kind=instruction --priority=-1 ' + text })
    expect(second?.kind).toBe('success')
    const rowsAfterSecond = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1'}) WHERE m.text = '" + text + "' RETURN m.id AS id, m.kind AS kind, m.priority AS priority",
    )
    // kind/priority 不进指纹 ⇒ 仍是同一节点，且分类以最新一次写入为准（AC4）。
    expect(rowsAfterSecond).toHaveLength(1)
    expect(rowsAfterSecond[0]!['id']).toBe(rowsAfterFirst[0]!['id'])
    expect(rowsAfterSecond[0]!['kind']).toBe('instruction')
    expect(Number(rowsAfterSecond[0]!['priority'])).toBe(-1)

    // 「该改动必须记 generation log」（Story 1.10 的表）：两次写入各追加一行。
    const logsAfter = await queryAll(connection, "MATCH (g:generation_log) WHERE g.action = 'upsert_memory' RETURN count(g) AS total")
    expect(Number(logsAfter[0]!['total'])).toBe(Number(logsBefore[0]!['total']) + 2)
  })
})

describe('库未就绪：无 profileContext 时命令仍可用且明确报错（矩阵行「库未就绪」）', () => {
  it('apply 跳过建库但仍注册命令；handler 返回 error 说明记忆库未就绪，不抛出', async () => {
    const registeredDefs: MemoryCommandDefinition[] = []
    const ctx = {
      logger: { warn: vi.fn(), info: vi.fn() },
      get: (key: string) => (key === 'commands'
        ? { register: (definition: MemoryCommandDefinition) => { registeredDefs.push(definition); return () => {} } }
        : undefined),
      effect: (factory: () => () => unknown) => factory(),
      tools: { register: () => () => {} },
    } as unknown as Parameters<typeof plugin.apply>[0]

    await plugin.apply(ctx, {
    embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: 'bge-m3', dim: 4 },
  })
    expect(registeredDefs).toHaveLength(1)

    const result = await registeredDefs[0]!.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
  })
})

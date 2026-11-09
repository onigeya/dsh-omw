/**
 * `/memory remember` 命令落库集成测试（Story 1.7 / AC1-AC4 的库内部分）。
 *
 * 沿用 db-upsert.test.ts 范式：injectOpenSslPath → mkdtemp → 真实库（dim=4）。
 * 用裸 ctx 驱动 apply，捕获交给 commands.register 的定义，再以
 * `{ rawInput: ' remember 我偏好 ESM 不要 CJS' }` 调 definition.handler，
 * 在最外层表面（命令返回值 + 落库事实）上验证：
 * - success + `layer='L1_INBOX'` 节点存在，三列 embedding/embedding_model_id/
 *   embedding_dim 均为 NULL（Epic 1 无 embedding 客户端的既定状态）；
 * - 同文本重复写入节点数不增（id = uuid5(layer+':'+归一化 text)）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { resolveMemoryDbPath } from '../src/db/paths'
import { openMemoryDatabase } from '../src/db/database'
import { queryAll, type MemoryConnection } from '../src/db/memory'
import { injectOpenSslPath } from './openssl'
import type { MemoryCommandDefinition, MemoryCommandInvocation } from '../src/command'

let dir: string
let dbPath: string
let connection: MemoryConnection
let registered: MemoryCommandDefinition | undefined

beforeAll(async () => {
  injectOpenSslPath()
  dir = await mkdtemp(join(tmpdir(), 'omw-command-'))
  dbPath = resolveMemoryDbPath(dir)

  // 裸 ctx：effect 收 closer（此处不消费），commands.register 捕获定义。
  const registeredDefs: MemoryCommandDefinition[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => (key === 'profileContext' ? { dir } : key === 'commands'
      ? { register: (definition: MemoryCommandDefinition) => { registeredDefs.push(definition); return () => {} } }
      : undefined),
    effect: (factory: () => () => unknown) => factory(),
  } as unknown as Parameters<typeof plugin.apply>[0]

  await plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
  registered = registeredDefs[0]

  // 同路径复用 apply 建好的 facade（database.ts 按绝对路径缓存），拿连接做断言。
  const store = await openMemoryDatabase({ dbPath, dim: 4, modelId: 'bge-m3' })
  connection = store.connection
})

afterAll(async () => {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('/memory remember 命令注册与执行（真实库 dim=4）', () => {
  it('apply 把名为 memory 的命令定义交给 commands.register（AC3）', () => {
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('memory')
  })

  it('remember 写入成功：L1_INBOX 节点存在且三列均为 NULL（AC1）', async () => {
    const invocation: MemoryCommandInvocation = { rawInput: ' remember 我偏好 ESM 不要 CJS' }
    const result = await registered?.handler(invocation)

    expect(result?.kind).toBe('success')

    const rows = await queryAll(
      connection,
      "MATCH (m:memory {layer: 'L1_INBOX'}) WHERE m.text = '我偏好 ESM 不要 CJS' RETURN m.id AS id, m.embedding AS embedding, m.embedding_model_id AS model_id, m.embedding_dim AS dim",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!['embedding']).toBeNull()
    expect(rows[0]!['model_id']).toBeNull()
    expect(rows[0]!['dim']).toBeNull()
  })

  it('同文本重复 remember：两次 success，节点数不增（同指纹同 id）', async () => {
    const before = await queryAll(connection, "MATCH (m:memory {layer: 'L1_INBOX'}) RETURN count(m) AS total")
    const totalBefore = Number(before[0]!['total'])

    const first = await registered?.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    const second = await registered?.handler({ rawInput: 'remember 我偏好 ESM 不要 CJS' })
    expect(first?.kind).toBe('success')
    expect(second?.kind).toBe('success')

    const after = await queryAll(connection, "MATCH (m:memory {layer: 'L1_INBOX'}) RETURN count(m) AS total")
    expect(Number(after[0]!['total'])).toBe(totalBefore)
  })

  it('无 payload：返回 usage error，节点数不变（AC2）', async () => {
    const before = await queryAll(connection, "MATCH (m:memory {layer: 'L1_INBOX'}) RETURN count(m) AS total")
    const totalBefore = Number(before[0]!['total'])

    const result = await registered?.handler({ rawInput: ' remember' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('memory remember')

    const after = await queryAll(connection, "MATCH (m:memory {layer: 'L1_INBOX'}) RETURN count(m) AS total")
    expect(Number(after[0]!['total'])).toBe(totalBefore)
  })

  it('未知子命令 status：返回 usage error（AC3）', async () => {
    const result = await registered?.handler({ rawInput: ' status' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('memory remember')
  })

  it('空指纹文本：收敛为 error 而非抛出（AC4）', async () => {
    const result = await registered?.handler({ rawInput: ' remember ！！！' })
    expect(result?.kind).toBe('error')
    expect(result?.text).toContain('归一化后为空')
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
    } as unknown as Parameters<typeof plugin.apply>[0]

    await plugin.apply(ctx, { embedding: { token: 'sk-test', model: 'bge-m3', dim: 4 } })
    expect(registeredDefs).toHaveLength(1)

    const result = await registeredDefs[0]!.handler({ rawInput: ' remember 我偏好 ESM 不要 CJS' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('记忆库未就绪')
  })
})

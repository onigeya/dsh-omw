/**
 * NULL 向量有界回填（Story 2.4 / U5）。
 *
 * 覆盖：补齐 / 幂等 / 不覆盖已有向量 / 空闲闸门 / 逐条失败只记审计 / 部分缺向量 /
 * 每轮条数上界 / 消费者 maintenance 钩子（不新增 ctx.effect）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { countUnembeddedMemories, listUnembeddedMemories, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { BACKFILL_BATCH_SIZE, createEmbeddingBackfill } from '../src/embedding/backfill'
import type { EmbedClient, EmbedResult } from '../src/embedding/client'
import { createInboxConsumer } from '../src/inbox/consumer'
import { createIdleGate } from '../src/inbox/idle-gate'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const VEC = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

async function openDb(prefix: string): Promise<MemoryDatabase> {
  return openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir(prefix)),
    dim: DIM,
    modelId: 'test-embed',
  })
}

/** 计数型假客户端：按次数返回预设结果（默认成功，每条给同一个向量）。 */
function makeClient(handler?: (input: readonly string[]) => EmbedResult): {
  client: EmbedClient
  calls: number[][]
} {
  const calls: number[][] = []
  const client: EmbedClient = {
    async embed(_model, input) {
      calls.push(input.map(() => 1))
      if (handler) return handler(input)
      return { ok: true, vectors: input.map(() => VEC) }
    },
  }
  return { client, calls }
}

function makeBackfill(store: MemoryDatabase, client: EmbedClient, gate = createIdleGate(), logger?: { warn(m: string): void }) {
  return createEmbeddingBackfill({
    connection: () => store.connection,
    gate,
    client,
    model: 'test-model',
    modelId: 'test-embed',
    logger,
  })
}

async function readRow(store: MemoryDatabase, id: string): Promise<{ embeddingNull: boolean; modelId: string | null; dim: number | null }> {
  const rows = await queryAll(
    store.connection,
    `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.embedding AS embedding,` +
      ' m.embedding_model_id AS model_id, m.embedding_dim AS embedding_dim',
  )
  const row = rows[0]
  if (row === undefined) throw new Error('节点不存在：' + id)
  return {
    embeddingNull: row.embedding === null || row.embedding === undefined,
    modelId: row.model_id === null || row.model_id === undefined ? null : String(row.model_id),
    dim: row.embedding_dim === null || row.embedding_dim === undefined ? null : Number(row.embedding_dim),
  }
}

interface BackfillAudit { outcome: string; reason: string }

async function readBackfillAudit(store: MemoryDatabase): Promise<BackfillAudit[]> {
  const rows = await queryAll(
    store.connection,
    "MATCH (g:generation_log) WHERE g.action = 'backfill_embedding' RETURN g.outcome AS outcome, g.reason AS reason",
  )
  return rows.map((row) => ({ outcome: String(row.outcome ?? ''), reason: String(row.reason ?? '') }))
}

afterAll(cleanupTempDirs)

async function seedNullVector(store: MemoryDatabase, text: string, recordedAt: string): Promise<void> {
  await upsertMemory(store.connection, { layer: 'L1', text, embedding: null, recordedAt })
}

describe('createEmbeddingBackfill（Story 2.4 / U5）', () => {
  it('补齐 NULL 向量节点：runOnce 返回条数、三列落库、审计 success；再跑幂等返回 0', async () => {
    const store = await openDb('omw-bf-basic-')
    try {
      await seedNullVector(store, '老事实', '2026-01-01T00:00:00.000Z')
      expect(await countUnembeddedMemories(store.connection)).toBe(1)
      const { client } = makeClient()
      const backfill = makeBackfill(store, client)
      expect(await backfill.runOnce()).toBe(1)
      expect(await listUnembeddedMemories(store.connection, 10)).toHaveLength(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(0)
      const rows = await queryAll(store.connection, "MATCH (m:memory) RETURN m.id AS id")
      const row = await readRow(store, String(rows[0]!.id))
      expect(row.embeddingNull).toBe(false)
      expect(row.modelId).toBe('test-embed')
      expect(row.dim).toBe(DIM)
      const audits = await readBackfillAudit(store)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('success')
      // 幂等：第二轮无候选（WHERE embedding IS NULL 不再命中）
      expect(await backfill.runOnce()).toBe(0)
      expect(await readBackfillAudit(store)).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it('不覆盖已有向量：只有 NULL 节点进候选，已有向量节点保持原值', async () => {
    const store = await openDb('omw-bf-skip-')
    try {
      await upsertMemory(store.connection, { layer: 'L1', text: '已有向量', embedding: VEC, embeddingModelId: 'orig-model' })
      await seedNullVector(store, '待补', '2026-01-01T00:00:00.000Z')
      expect(await countUnembeddedMemories(store.connection)).toBe(1)
      const { client, calls } = makeClient()
      expect(await makeBackfill(store, client).runOnce()).toBe(1)
      expect(calls).toHaveLength(1)
      expect(calls[0]!).toHaveLength(1)
      const rows = await queryAll(store.connection, "MATCH (m:memory) RETURN m.id AS id, m.embedding_model_id AS model_id")
      const existing = rows.find((r) => String(r.model_id) === 'orig-model')
      expect(existing).toBeDefined()
    } finally {
      await store.close()
    }
  })

  it('空闲闸门：turn 进行中 → 0 条、不查库、不发网络', async () => {
    const store = await openDb('omw-bf-gate-')
    try {
      await seedNullVector(store, '待补', '2026-01-01T00:00:00.000Z')
      const gate = createIdleGate()
      gate.enterTurn('s1')
      const { client, calls } = makeClient()
      expect(await makeBackfill(store, client, gate).runOnce()).toBe(0)
      expect(calls).toHaveLength(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('批次失败：逐条记 failure 审计、节点仍为 NULL、不抛错（下一轮重来）', async () => {
    const store = await openDb('omw-bf-fail-')
    try {
      await seedNullVector(store, '甲', '2026-01-01T00:00:00.000Z')
      await seedNullVector(store, '乙', '2026-01-02T00:00:00.000Z')
      const warns: string[] = []
      const { client } = makeClient(() => ({ ok: false, reason: 'http-500', message: 'upstream down' }))
      const backfill = makeBackfill(store, client, createIdleGate(), { warn: (m) => warns.push(m) })
      expect(await backfill.runOnce()).toBe(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(2)
      const audits = await readBackfillAudit(store)
      expect(audits).toHaveLength(2)
      for (const audit of audits) {
        expect(audit.outcome).toBe('failure')
        expect(audit.reason).toContain('http-500')
      }
      expect(warns).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it('部分缺向量（vector-missing）：该条失败、其余照常补上', async () => {
    const store = await openDb('omw-bf-partial-')
    try {
      await seedNullVector(store, '甲', '2026-01-01T00:00:00.000Z')
      await seedNullVector(store, '乙', '2026-01-02T00:00:00.000Z')
      const { client } = makeClient((input) => ({ ok: true, vectors: input.slice(0, 1).map(() => VEC) }))
      expect(await makeBackfill(store, client).runOnce()).toBe(1)
      const audits = await readBackfillAudit(store)
      expect(audits.filter((a) => a.outcome === 'failure')).toHaveLength(1)
      expect(audits.filter((a) => a.outcome === 'success')).toHaveLength(1)
      expect(await countUnembeddedMemories(store.connection)).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('每轮条数上界（batchSize）：分两轮补齐 4 条，第三轮为 0', async () => {
    const store = await openDb('omw-bf-bound-')
    try {
      for (let i = 0; i < 4; i += 1) {
        await seedNullVector(store, '事实' + i, `2026-01-0${i + 1}T00:00:00.000Z`)
      }
      const { client } = makeClient()
      const backfill = createEmbeddingBackfill({
        connection: () => store.connection,
        gate: createIdleGate(),
        client,
        model: 'test-model',
        modelId: 'test-embed',
        batchSize: 2,
      })
      expect(BACKFILL_BATCH_SIZE).toBe(50)
      expect(await backfill.runOnce()).toBe(2)
      expect(await backfill.runOnce()).toBe(2)
      expect(await backfill.runOnce()).toBe(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(0)
    } finally {
      await store.close()
    }
  })

  it('消费者 maintenance 钩子：无处理器时 FIFO 跳过、维护照常跑一次；维护抛错只告警', async () => {
    const store = await openDb('omw-bf-hook-')
    try {
      const warns: string[] = []
      let calls = 0
      const consumer = createInboxConsumer({
        connection: () => store.connection,
        gate: createIdleGate(),
        maintenance: async () => { calls += 1 },
        logger: { warn: (m) => warns.push(m) },
      })
      expect(await consumer.runOnce()).toBe(0)
      expect(calls).toBe(1)

      const failing = createInboxConsumer({
        connection: () => store.connection,
        gate: createIdleGate(),
        maintenance: async () => { throw new Error('backfill boom') },
        logger: { warn: (m) => warns.push(m) },
      })
      expect(await failing.runOnce()).toBe(0)
      expect(warns.some((m) => m.includes('backfill boom'))).toBe(true)
    } finally {
      await store.close()
    }
  })
})

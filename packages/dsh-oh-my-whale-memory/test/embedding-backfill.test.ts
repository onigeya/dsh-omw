/**
 * NULL 向量有界回填（Story 2.4 / U5）。
 *
 * 覆盖：补齐 / 幂等 / 不覆盖已有向量 / 空闲闸门 / **每轮至多一条聚合失败审计** / 部分缺向量 /
 * 每轮条数上界 / 批次失败不阻塞后续批 / 批间 turn/start 立即停 / ≤8 分批且先补最老 /
 * 消费者 maintenance 钩子（不新增 ctx.effect）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { countUnembeddedMemories, listUnembeddedMemories, setMemoryEmbedding, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { BACKFILL_BATCH_SIZE, createEmbeddingBackfill } from '../src/embedding/backfill'
import { EMBEDDING_MAX_BATCH, type EmbedClient, type EmbedResult } from '../src/embedding/client'
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

  it('批次失败：整轮只落一条聚合 failure 审计（不是逐条）、节点仍为 NULL、不抛错', async () => {
    const store = await openDb('omw-bf-fail-')
    try {
      await seedNullVector(store, '甲', '2026-01-01T00:00:00.000Z')
      await seedNullVector(store, '乙', '2026-01-02T00:00:00.000Z')
      const warns: string[] = []
      const { client } = makeClient(() => ({ ok: false, reason: 'http-500', message: 'upstream down' }))
      const backfill = makeBackfill(store, client, createIdleGate(), { warn: (m) => warns.push(m) })
      expect(await backfill.runOnce()).toBe(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(2)
      // P9③：整轮至多一条聚合行（失败条数 + 首个 reason），端点故障时不再每分钟灌数十行。
      const audits = await readBackfillAudit(store)
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('failure')
      expect(audits[0]!.reason).toBe('failed=2 first=http-500')
      // P9⑦：审计只留机器 reason；完整 message（可能含 endpoint URL）只进 logger。
      expect(audits[0]!.reason).not.toContain('upstream down')
      expect(warns).toHaveLength(1)
      expect(warns[0]!).toContain('upstream down')
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

  it('P9 回填：头部批次失败不阻塞后续批次（每批一个独立预算、失败只计本轮聚合行）', async () => {
    const store = await openDb('omw-bf-headfail-')
    try {
      for (let i = 0; i < 10; i += 1) {
        await seedNullVector(store, '事实' + i, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
      }
      let call = 0
      const { client } = makeClient((input) => {
        call += 1
        // 第 1 批（8 条）整体失败，第 2 批（2 条）成功：头部失败不得吃掉整轮
        return call === 1
          ? { ok: false, reason: 'http-503', message: 'unavailable' }
          : { ok: true, vectors: input.map(() => VEC) }
      })
      expect(await makeBackfill(store, client).runOnce()).toBe(2)
      expect(call).toBe(2)
      const audits = await readBackfillAudit(store)
      expect(audits.filter((a) => a.outcome === 'success')).toHaveLength(2)
      const failures = audits.filter((a) => a.outcome === 'failure')
      expect(failures).toHaveLength(1)
      expect(failures[0]!.reason).toBe('failed=8 first=http-503')
      expect(await countUnembeddedMemories(store.connection)).toBe(8)
    } finally {
      await store.close()
    }
  })

  it('P9 回填：同一失败批次连续两轮各记一条聚合审计（不逐条、也不无限沉默）', async () => {
    const store = await openDb('omw-bf-repeat-')
    try {
      await seedNullVector(store, '甲', '2026-01-01T00:00:00.000Z')
      await seedNullVector(store, '乙', '2026-01-02T00:00:00.000Z')
      const { client } = makeClient(() => ({ ok: false, reason: 'http-500', message: 'down' }))
      const backfill = makeBackfill(store, client)
      expect(await backfill.runOnce()).toBe(0)
      expect(await backfill.runOnce()).toBe(0)
      const audits = await readBackfillAudit(store)
      expect(audits).toHaveLength(2)
      for (const audit of audits) expect(audit.reason).toBe('failed=2 first=http-500')
      expect(await countUnembeddedMemories(store.connection)).toBe(2)
    } finally {
      await store.close()
    }
  })

  it('P9 回填：批次之间出现 turn/start ⇒ 立即 break（一轮不跨 turn 边界继续）', async () => {
    const store = await openDb('omw-bf-midturn-')
    try {
      for (let i = 0; i < 10; i += 1) {
        await seedNullVector(store, '事实' + i, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
      }
      const gate = createIdleGate()
      let call = 0
      const { client } = makeClient((input) => {
        call += 1
        // 首批 embedding 期间宿主开始新 turn：批次迭代前的复查必须立刻停
        if (call === 1) gate.enterTurn('s1')
        return { ok: true, vectors: input.map(() => VEC) }
      })
      expect(await makeBackfill(store, client, gate).runOnce()).toBe(8)
      expect(call).toBe(1)
      expect(await countUnembeddedMemories(store.connection)).toBe(2)
    } finally {
      await store.close()
    }
  })

  it('P13 覆写守卫：setMemoryEmbedding 二次调用返回 false，且原向量/模型标记都不被改写', async () => {
    const store = await openDb('omw-bf-guard-')
    try {
      await seedNullVector(store, '待补', '2026-01-01T00:00:00.000Z')
      const rows = await queryAll(store.connection, 'MATCH (m:memory) RETURN m.id AS id')
      const id = String(rows[0]!.id)
      expect(await setMemoryEmbedding(store.connection, id, VEC, 'test-embed')).toBe(true)
      // WHERE m.embedding IS NULL 的守卫：第二次不得命中、不得改写
      const replacement = VEC.map((value) => value * 2)
      expect(await setMemoryEmbedding(store.connection, id, replacement, 'other-model')).toBe(false)
      const row = await readRow(store, id)
      expect(row.embeddingNull).toBe(false)
      expect(row.modelId).toBe('test-embed')
      expect(row.dim).toBe(DIM)
      const stored = await queryAll(store.connection, `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.embedding AS embedding`)
      const vector = Array.from(stored[0]!.embedding as ArrayLike<number>)
      expect(vector).toHaveLength(DIM)
      expect(vector[0]).toBeCloseTo(VEC[0]!, 5)
      expect(vector[1]).toBeCloseTo(VEC[1]!, 5)
    } finally {
      await store.close()
    }
  })

  it('P12 回填：9 条候选按 ≤8 分批请求，且先补 recorded_at 最老的', async () => {
    const store = await openDb('omw-bf-batch-')
    try {
      for (let i = 0; i < 9; i += 1) {
        await seedNullVector(store, '事实' + i, `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
      }
      const batches: string[][] = []
      const client: EmbedClient = {
        async embed(_model, input) {
          batches.push([...input])
          return { ok: true, vectors: input.map(() => VEC) }
        },
      }
      expect(EMBEDDING_MAX_BATCH).toBe(8)
      expect(await makeBackfill(store, client).runOnce()).toBe(9)
      expect(batches.map((batch) => batch.length)).toEqual([8, 1])
      expect(batches.flat()).toEqual(Array.from({ length: 9 }, (_value, i) => '事实' + i))
      expect(await countUnembeddedMemories(store.connection)).toBe(0)
    } finally {
      await store.close()
    }
  })
})

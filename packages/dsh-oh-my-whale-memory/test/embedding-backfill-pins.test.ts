/**
 * Story 2.4 补钉（Lead 变异审计 M8/M9）：P9① 每批独立预算、P9④ pin dim 校验。
 * 撤掉这两处修复后全量测试仍绿 ⇒ 无回归钉。单独成文件以守住「单进程约 15 个
 * LadybugDB 实例」的上限（test/embedding-backfill.test.ts 已有 12 条用例）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { countUnembeddedMemories, listUnembeddedMemories, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { createEmbeddingBackfill } from '../src/embedding/backfill'
import type { EmbedClient, EmbedResult } from '../src/embedding/client'
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

function makeBackfill(store: MemoryDatabase, client: EmbedClient) {
  return createEmbeddingBackfill({
    connection: () => store.connection,
    gate: createIdleGate(),
    client,
    model: 'test-model',
    modelId: 'test-embed',
  })
}

afterAll(cleanupTempDirs)

describe('Story 2.4 补钉：回填预算与 pin dim 校验', () => {
  it('P9① 每批一个新预算：跨批次的两个请求拿到互不相同的 AbortSignal', async () => {
    const store = await openDb('omw-bf-pin-signal-')
    try {
      for (let i = 0; i < 9; i += 1) {
        const day = String(i + 1).padStart(2, '0')
        await upsertMemory(store.connection, {
          layer: 'L1',
          text: '事实 ' + i,
          embedding: null,
          recordedAt: '2026-01-' + day + 'T00:00:00.000Z',
        })
      }
      const signals: AbortSignal[] = []
      const client: EmbedClient = {
        async embed(_model, input, signal): Promise<EmbedResult> {
          signals.push(signal)
          return { ok: true, vectors: input.map(() => VEC) }
        },
      }
      expect(await makeBackfill(store, client).runOnce()).toBe(9)
      // 9 条 × 每请求 ≤8 条 ⇒ 恰好两批
      expect(signals).toHaveLength(2)
      // 撤成「整轮共享一个 signal」即变红
      expect(signals[0]).not.toBe(signals[1])
      expect(signals[0]!.aborted).toBe(false)
    } finally {
      await store.close()
    }
  })

  it('P9④ pin dim 校验：客户端返回长度与库内 pin 不符 ⇒ 不写库、记 dim-mismatch 失败', async () => {
    const store = await openDb('omw-bf-pin-dim-')
    try {
      await upsertMemory(store.connection, {
        layer: 'L1',
        text: '维度不符的事实',
        embedding: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const client: EmbedClient = {
        async embed(_model, input): Promise<EmbedResult> {
          return { ok: true, vectors: input.map(() => [0.1, 0.2, 0.3]) }
        },
      }
      expect(await makeBackfill(store, client).runOnce()).toBe(0)
      expect(await countUnembeddedMemories(store.connection)).toBe(1)
      const rows = await queryAll(
        store.connection,
        "MATCH (g:generation_log) WHERE g.action = 'backfill_embedding' RETURN g.outcome AS outcome, g.reason AS reason",
      )
      expect(rows.map((row) => String(row.reason ?? '')).join('|')).toContain('dim-mismatch')
    } finally {
      await store.close()
    }
  })

  it('F-04 future-valid 夹具：valid_at > now 的节点在生效前不进回填目标集（可注入 now）', async () => {
    const store = await openDb('omw-bf-future-valid-')
    try {
      await upsertMemory(store.connection, {
        layer: 'L1',
        text: '未来才生效的事实',
        embedding: null,
        // 已记录但尚未生效：不满足快照四条件的 `valid_at <= now`。
        validAt: '2999-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      // 当前时刻（2026+）：未生效 ⇒ 不计数、不扫描、不回填。
      expect(await countUnembeddedMemories(store.connection)).toBe(0)
      expect(await listUnembeddedMemories(store.connection, 10)).toHaveLength(0)
      const client: EmbedClient = {
        async embed(_model, input): Promise<EmbedResult> {
          return { ok: true, vectors: input.map(() => VEC) }
        },
      }
      expect(await makeBackfill(store, client).runOnce()).toBe(0)

      // 显式把 clock 推到生效之后（注入 now）⇒ 进入目标集（延后补齐，不是永久跳过）。
      const future = '3000-01-01T00:00:00.000Z'
      expect(await countUnembeddedMemories(store.connection, future)).toBe(1)
      expect(await listUnembeddedMemories(store.connection, 10, future)).toHaveLength(1)
    } finally {
      await store.close()
    }
  })
})

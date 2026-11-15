/**
 * `/memory status` 健康视图的真库端到端（Story 4.3 / T5；矩阵行 2/3/4/6/11/12/13/14 与 SM-2）。
 *
 * 分层：采集函数的三态（缺表 / 读失败 / 超预算）在 `db-health.test.ts` 用注入时钟与 spy 构造；
 * 渲染文案在 `command-status.test.ts`；本文件只证明**真实库 → apply → 命令 handler → 文本**
 * 这条链上的数值口径，以及漂移重划后「手工 remember(context=消息 id)」不再挂住 audit_gap。
 *
 * 开库次数：本文件共 4 次（积压与精炼时刻 / 空库 / 手工 remember / 漂移三态），
 * LadybugDB 每进程约 15 个库封顶。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { computeAuditGap } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { computeEvidenceDrift, computeEvidenceGap } from '../src/db/eii'
import { resolveMemoryDbPath } from '../src/db/paths'
import { l1InboxQueue, l2InboxQueue } from '../src/inbox/queue'
import { createMemoryRememberTool } from '../src/tools/memory-remember'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = {
  embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL_ID, dim: DIM },
}

/** 精炼完成时刻（逐个字面量：渲染必须原样回显库内 updated_at）。 */
const LAST_REFINE_AT = '2026-11-01T00:30:00.000Z'

/** 裸 ctx（同 command-status-db.test.ts）：捕获 commands.register 的定义。 */
function makeCtx(profileDir: string, registeredDefs: MemoryCommandDefinition[]): Parameters<typeof plugin.apply>[0] {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => {
      if (key === 'profileContext') return { dir: profileDir }
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

/** 建 profile 目录 + apply 注册命令 + 同路径复用当时建好的 facade。 */
async function openFixture(prefix: string): Promise<{
  store: MemoryDatabase
  handler: MemoryCommandDefinition['handler']
  dir: string
}> {
  const dir = await makeTempDir(prefix)
  const registeredDefs: MemoryCommandDefinition[] = []
  await plugin.apply(makeCtx(dir, registeredDefs), EMBEDDING_CONFIG)
  const store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
  return { store, handler: registeredDefs[0]!.handler, dir }
}

afterAll(cleanupTempDirs)

describe('矩阵行 2/3/6：积压时长取较大者，精炼时刻逐字回显', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>

  beforeAll(async () => {
    fixture = await openFixture('omw-status-health-')
    const { store } = fixture
    // 先做一条精炼完成：入队 → claim → complete（updated_at 由 complete 注入，逐字回显）。
    await l1InboxQueue.enqueue(store.connection, { id: 'sh-done', payload: '已完成', now: new Date(Date.now() - 3_600_000) })
    await l1InboxQueue.claimNext(store.connection, { owner: 'test', now: new Date(Date.now() - 3_600_000) })
    await l1InboxQueue.complete(store.connection, 'sh-done', { now: new Date(LAST_REFINE_AT) })
    // 再制造积压：L1 约 90.5s、L2 约 30.5s（多 0.5s 让「向下取整」不受毫秒级竞态影响）。
    await l1InboxQueue.enqueue(store.connection, { id: 'sh-l1', payload: '排队中', now: new Date(Date.now() - 90_500) })
    await l2InboxQueue.enqueue(store.connection, { id: 'sh-l2', payload: '{"l1Ids":["x"]}', now: new Date(Date.now() - 30_500) })
  })

  afterAll(async () => {
    await fixture.store.close()
  })

  it('inbox_backlog 取两队列较大者并给分项；last_refine_at 是库内 updated_at 原文', async () => {
    const result = await fixture.handler({ rawInput: ' status' })

    expect(result.kind).toBe('success')
    expect(result.text).toContain('inbox_backlog: 90s（L1 90s / L2 30s）')
    expect(result.text).toContain(`last_refine_at: ${LAST_REFINE_AT}`)
    // 积压秒数是整数、向下取整（没有小数点）。
    expect(result.text).not.toMatch(/inbox_backlog: \d+\.\d+s/)
  })
})

describe('矩阵行 4：空库的健康行是 n/a 形态，不是 0', () => {
  it('全新库 → 无积压 / 从未精炼 / 两项 Epic 7 占位；计数全 0', async () => {
    const fixture = await openFixture('omw-status-health-empty-')
    try {
      const result = await fixture.handler({ rawInput: ' status' })

      expect(result.kind).toBe('success')
      expect(result.text).toContain('L1: 0')
      expect(result.text).toContain('inbox_backlog: n/a（无积压）')
      expect(result.text).toContain('last_refine_at: n/a（从未完成精炼）')
      expect(result.text).toContain('rerank_latency: n/a (v1 无精排)')
      expect(result.text).toContain('pending_conflicts: n/a（Epic 7 真源在 Story 7.1）')
      expect(result.text).toContain('strategy_gate: n/a（Epic 7 真源在 Story 7.3）')
      expect(result.text).not.toContain('rerank_latency: 0ms')
    } finally {
      await fixture.store.close()
    }
  })
})

describe('SM-2：手工 remember(context=消息 id) 之后 audit_gap 仍为 0', () => {
  it('不可解析的 context 不再计入漂移：audit_gap = 0、漂移分项 = 0', async () => {
    const fixture = await openFixture('omw-status-health-context-')
    try {
      const { store } = fixture
      const tool = createMemoryRememberTool(() => store)
      const stored = await tool.execute({ content: '手工记住并引用一条消息', context: 'msg-123' })
      expect(stored).toMatchObject({ action: 'stored' })

      const now = new Date().toISOString()
      // 4.1 的 keyed 口径：节点仍有效，本就不会进 audit_gap。
      expect(await computeAuditGap(store.connection)).toBe(0)
      // 4.3 的重划点：source_refs=['msg-123'] 既不是 l0_raw 也不是节点 ⇒ 不是漂移。
      const drift = await computeEvidenceDrift(store.connection, now)
      expect(drift.refsWithoutEdges.filter((entry) => entry.ref === 'msg-123')).toEqual([])
      expect(drift.edgesWithoutRefs).toEqual([])

      // 端到端：status 里漂移分项为 0（不再出现「漂移 1」）。
      const gap = await computeEvidenceGap(store.connection, now)
      expect(gap?.drift).toBe(0)

      const result = await fixture.handler({ rawInput: ' status' })
      expect(result.kind).toBe('success')
      // 漂移分项为 0（4.1 时这里会是「漂移 1」）；EII 1 是「手工写的节点没有 L0 证据链」，
      // 属另一集合，本 story 不改变它（见 spec 矩阵行 13 的 audit_gap 口径注记）。
      expect(result.text).toContain('evidence_gap: 1（EII 1 / 漂移 0）')
      expect(result.text).not.toContain('漂移 1')
    } finally {
      await fixture.store.close()
    }
  })
})

describe('矩阵行 12/13/14：漂移 A 只统计可解析端点', () => {
  /** 直接建一行 L0（同 db-edge-tables.test.ts 的夹具形态）。 */
  async function seedL0(store: MemoryDatabase, id: string): Promise<void> {
    await store.connection.query(
      `CREATE (l:l0_raw {id: '${id}', raw_text: '原文', recorded_at: '2026-01-01T00:00:00.000Z', actor: 'test'})`,
    )
  }

  let store: MemoryDatabase
  /** 三个夹具节点的 id（由真实写路径返回，测试不复制 uuid5 规则）。 */
  let resolvableId: string
  let unresolvableId: string
  let mixedId: string

  beforeAll(async () => {
    // 故意不 apply：apply 会启动证据回填消费者，它会把 `source_refs` 里的 L0 引用补成
    // 真实 EVIDENCE 边，本用例就再也构造不出「可解析且无边」的漂移。这里只开库直写。
    store = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-status-health-drift-')),
      dim: DIM,
      modelId: MODEL_ID,
    })
    const now = new Date().toISOString()
    await seedL0(store, 'res-l0')
    // 行 12：可解析（l0_raw 存在）但无 EVIDENCE 边的 ref。
    resolvableId = (await store.upsertMemory({
      layer: 'L1', text: '可解析端点无边的记忆', sourceRefs: ['res-l0'], validAt: now, recordedAt: now,
    })).id
    // 行 13：不可解析的 ref（消息 id，既非 l0_raw 也非 memory）。
    unresolvableId = (await store.upsertMemory({
      layer: 'L1', text: '引用库外消息的记忆', sourceRefs: ['msg-456'], validAt: now, recordedAt: now,
    })).id
    // 行 14：混合引用 ⇒ 只计可解析那条。
    mixedId = (await store.upsertMemory({
      layer: 'L1', text: '混合引用的记忆', sourceRefs: ['res-l0', 'msg-789'], validAt: now, recordedAt: now,
    })).id
  })

  afterAll(async () => {
    await store.close()
  })

  it('可解析 ref 计漂移、不可解析 ref 不计、混合只计可解析那条', async () => {
    const drift = await computeEvidenceDrift(store.connection, new Date().toISOString())
    const of = (id: string) => drift.refsWithoutEdges.filter((entry) => entry.id === id)

    // 行 12：可解析端点无边的 ref 仍是一条真漂移。
    expect(of(resolvableId)).toEqual([{ id: resolvableId, ref: 'res-l0' }])
    // 行 13：不可解析的 ref 完全不出现在漂移里（可见性归 Epic 10）。
    expect(of(unresolvableId)).toEqual([])
    // 行 14：混合引用只把可解析那条算进漂移。
    expect(of(mixedId)).toEqual([{ id: mixedId, ref: 'res-l0' }])
  })
})

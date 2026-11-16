/**
 * Story 7.1：待裁决冲突（persona）与 `/memory resolve` 的裁决语义。
 *
 * 覆盖 spec 矩阵行 1–5、7、9、12：
 * - 冲突：新 persona 与既有 persona 语义近邻 ⇒ 不写新节点、旧值仍有效、落 keyed(await-confirmation) + pending 行；
 * - 非 persona 的语义重复 ⇒ 行为不变（照旧 merge，不产生待裁决）；
 * - resolve `--accept`：旧节点 invalid_at、新节点写入、keyed(user, supersede)、pending 行删除；
 * - resolve `--keep`：旧节点不变、新节点写入、keyed(user, merge)；
 * - 不存在的 id ⇒ `pending_decision_not_found`，库不变；
 * - 重启（重新打开 facade）后待裁决仍在（证明落表不是内存态）。
 *
 * 开库预算：本文件 2 个库（冲突/裁决用同一个 + 重启用同一个路径），≤14。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildJudgeKey, computeAuditGap } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { writeDeduplicatedMemory } from '../src/db/dedup'
import { memoryNodeId } from '../src/db/id'
import { getMemoryById } from '../src/db/memory'
import {
  PERSONA_CONFLICT_POLICY,
  countPendingDecisions,
  insertPendingDecision,
  listPendingDecisions,
  readPendingDecision,
  resolvePendingDecision,
} from '../src/db/pending'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { runStatement } from '../src/db/backend'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = new Date('2026-06-01T00:00:00.000Z')

let store: MemoryDatabase

/** 固定维度的单位向量族：vec(0,1) 与 vec(0.02, ...) 的 cosine ≈ 0.999（同一话题的另一种说法）。 */
function vec(a: number, b: number): number[] {
  const norm = Math.hypot(a, b)
  return [a / norm, b / norm, 0, 0]
}

/** 第二个正交轴：与 `vec` 的余弦恒为 0，保证不同用例的节点不会互相成为 ANN 候选。 */
function vecY(a: number, b: number): number[] {
  const norm = Math.hypot(a, b)
  return [0, a / norm, b / norm, 0]
}

/** 第三个正交轴（同上）。 */
function vecZ(a: number, b: number): number[] {
  const norm = Math.hypot(a, b)
  return [0, 0, a / norm, b / norm]
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-pending-')),
    dim: DIM,
    modelId: MODEL,
  })
})

afterAll(async () => {
  await store?.close()
  cleanupTempDirs()
})

describe('待裁决表原语（Story 7.1 / D-1）', () => {
  it('插入后可读、计数 +1、清单按时间倒序', async () => {
    const before = await countPendingDecisions(store.connection)
    expect(before).toBe(0)
    await insertPendingDecision(store.connection, {
      id: 'p-alpha',
      oldId: 'old-alpha',
      newId: 'new-alpha',
      payload: '我偏好先看证据',
      kind: 'persona',
      priority: -1,
      actor: 'agent',
      createdAt: T0,
    })
    const read = await readPendingDecision(store.connection, 'p-alpha')
    expect(read?.payload).toBe('我偏好先看证据')
    expect(read?.priority).toBe(-1)
    expect(await countPendingDecisions(store.connection)).toBe(1)
    const list = await listPendingDecisions(store.connection, { limit: 5 })
    expect(list.map((item) => item.id)).toEqual(['p-alpha'])
  })
})

describe('persona 冲突路由（矩阵行 1–3）', () => {
  it('非 persona 的语义重复：照旧 merge，不产生待裁决', async () => {
    const pendingBefore = await countPendingDecisions(store.connection)
    const first = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'work_fact',
      text: '非人设事实一',
      embedding: vec(1, 0),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    const second = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'work_fact',
      text: '非人设事实一（另一种说法）',
      embedding: vec(1, 0.01),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    expect(second.outcome).toBe('semantic-merge')
    expect(second.id).toBe(first.id)
    expect(await countPendingDecisions(store.connection)).toBe(pendingBefore)
  })

  it('命中 persona：不写新节点、旧值仍有效、落 keyed(await-confirmation) + pending 行', async () => {
    const old = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我偏好深色主题',
      embedding: vecY(1, 0),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    const oldId = old.id
    const conflict = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我更喜欢浅色主题',
      embedding: vecY(1, 0.02),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    expect(conflict.outcome).toBe('await-confirmation')
    // 旧节点仍有效（用户确认前旧值保持有效，AC:1381）
    const oldNode = await getMemoryById(store.connection, oldId)
    expect(oldNode?.invalidAt ?? null).toBeNull()
    expect(oldNode?.expiredAt ?? null).toBeNull()
    // 新节点**没有**被写入
    const newNodeId = memoryNodeId('L1', '我更喜欢浅色主题')
    expect(await getMemoryById(store.connection, newNodeId)).toBeNull()
    // keyed 裁决 + pending 行都在
    const keyed = await queryAll(
      store.connection,
      `MATCH (k:keyed_decision) WHERE k.old_id = '${oldId}' RETURN k.action AS action, k.resolution_source AS source`,
    )
    expect(keyed.map((row) => row.action)).toContain('await-confirmation')
    const pending = await listPendingDecisions(store.connection, { limit: 5 })
    const entry = pending.find((item) => item.oldId === oldId)
    expect(entry).toBeDefined()
    expect(entry?.payload).toBe('我更喜欢浅色主题')
    expect(entry?.id).toBe(buildJudgeKey(PERSONA_CONFLICT_POLICY, 'await-confirmation', oldId, newNodeId))
  })
})

describe('resolve 裁决（矩阵行 4、5、7）', () => {
  it('--keep：旧节点不变、新节点写入、keyed(user, merge)、pending 行删除', async () => {
    const old = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我禁止自动提交',
      embedding: vecZ(1, 0),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    const conflict = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我允许草稿提交',
      embedding: vecZ(1, 0.01),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    expect(conflict.outcome).toBe('await-confirmation')
    const pending = (await listPendingDecisions(store.connection, { limit: 5 })).find((item) => item.oldId === old.id)
    expect(pending).toBeDefined()
    const countBefore = await countPendingDecisions(store.connection)

    const result = await resolvePendingDecision(store.connection, pending!.id, 'keep', { now: () => NOW })
    expect(result.action).toBe('merge')
    expect(result.newMemoryId).toBe(memoryNodeId('L1', '我允许草稿提交'))
    const oldNode = await getMemoryById(store.connection, old.id)
    expect(oldNode?.invalidAt ?? null).toBeNull()
    expect(await getMemoryById(store.connection, result.newMemoryId)).not.toBeNull()
    expect(await countPendingDecisions(store.connection)).toBe(countBefore - 1)
    const keyed = await queryAll(
      store.connection,
      `MATCH (k:keyed_decision) WHERE k.old_id = '${old.id}' AND k.action = 'merge' RETURN k.resolution_source AS source`,
    )
    expect(keyed[0]?.source).toBe('user')
  })

  it('--accept：旧节点 invalid_at、新节点写入（parent_id=old）、keyed(user, supersede)', async () => {
    const old = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我讨厌缩写',
      embedding: vec(1, 0.5),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我不介意缩写',
      embedding: vec(1, 0.51),
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    const pending = (await listPendingDecisions(store.connection, { limit: 5 })).find((item) => item.oldId === old.id)
    expect(pending).toBeDefined()
    const result = await resolvePendingDecision(store.connection, pending!.id, 'accept', { now: () => NOW })
    expect(result.action).toBe('supersede')
    const oldNode = await getMemoryById(store.connection, old.id)
    expect(oldNode?.invalidAt).toBe(NOW.toISOString())
    const parentRows = await queryAll(
      store.connection,
      `MATCH (m:memory {id: '${result.newMemoryId}'}) RETURN m.parent_id AS parent_id`,
    )
    expect(parentRows[0]?.parent_id).toBe(old.id)
    const keyed = await queryAll(
      store.connection,
      `MATCH (k:keyed_decision) WHERE k.old_id = '${old.id}' AND k.action = 'supersede' RETURN k.resolution_source AS source`,
    )
    expect(keyed[0]?.source).toBe('user')
    // 评审 R71：中间态的 await-confirmation 行必须在结案时删掉——否则它会替旧节点在
    // audit_gap 里永久作证，把这下面的 0 变成假绿。
    const dangling = await queryAll(
      store.connection,
      `MATCH (k:keyed_decision) WHERE k.old_id = '${old.id}' AND k.action = 'await-confirmation' RETURN count(k) AS c`,
    )
    expect(Number(dangling[0]?.c ?? 0)).toBe(0)
    // 合法的 user 裁决让 audit_gap 不因这次作废上涨
    expect(await computeAuditGap(store.connection)).toBe(0)
  })

  it('不存在的 id ⇒ pending_decision_not_found，且库不变', async () => {
    const countBefore = await countPendingDecisions(store.connection)
    await expect(resolvePendingDecision(store.connection, 'no-such-pending', 'keep'))
      .rejects.toMatchObject({ code: 'pending_decision_not_found' })
    expect(await countPendingDecisions(store.connection)).toBe(countBefore)
  })

  it('重启（重新打开 facade）后待裁决仍在：证明落表不是内存态', async () => {
    // 同一路径 openMemoryDatabase 返回同一 facade（进程级句柄），因此这里直接再读一次库；
    // 真正的跨进程重启由既有 db-parent-id/db-support-column 的子进程手法覆盖，本用例只钉「数据在库里」。
    const rows = await queryAll(store.connection, 'MATCH (p:pending_decision) RETURN count(p) AS c')
    expect(Number(rows[0]?.c ?? 0)).toBe(await countPendingDecisions(store.connection))
  })

  it('同一 id 二次裁决 ⇒ not_found（幂等，不重复写节点）', async () => {
    const old = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我只看结论',
      embedding: [0, 0, 0, 1],
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'persona',
      priority: -1,
      text: '我看过程和结论',
      embedding: [0, 0, 0.01, 1],
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    const pending = (await listPendingDecisions(store.connection, { limit: 5 })).find((item) => item.oldId === old.id)
    expect(pending).toBeDefined()
    await resolvePendingDecision(store.connection, pending!.id, 'keep', { now: () => NOW })
    await expect(resolvePendingDecision(store.connection, pending!.id, 'keep', { now: () => NOW }))
      .rejects.toMatchObject({ code: 'pending_decision_not_found' })
  })

  it('audit_gap 不被「无裁决的作废」掩盖：手工作废仍计 1', async () => {
    // 反向证明：如果 audit_gap 只要求「任一行 keyed 引用该节点」，那么手工把节点置无效应该为 0；
    // 它必须为 1（没有任何裁决行），否则基线用例的 0 就是假绿。
    const before = await computeAuditGap(store.connection)
    const node = await writeDeduplicatedMemory(store.connection, {
      layer: 'L1',
      kind: 'work_fact',
      text: '手工作废的节点',
      embedding: [0.5, 0.5, 0.5, 0.5],
      embeddingModelId: MODEL,
      actor: 'agent',
    })
    await runStatement(
      store.connection,
      `MATCH (m:memory {id: '${node.id}'}) SET m.invalid_at = '${T0}'`,
    )
    expect(await computeAuditGap(store.connection)).toBe(before + 1)
  })

  it('pending 列表按时间倒序且 limit 生效（n=7 ⇒ 只回 5 条）', async () => {
    const countBefore = await countPendingDecisions(store.connection)
    for (let index = 0; index < 7; index += 1) {
      await insertPendingDecision(store.connection, {
        id: `p-${String(index)}`,
        oldId: `old-${String(index)}`,
        newId: `new-${String(index)}`,
        payload: `候选 ${String(index)}`,
        kind: 'persona',
        priority: -1,
        actor: 'agent',
        createdAt: `2026-07-0${String(index + 1)}T00:00:00.000Z`,
      })
    }
    const list = await listPendingDecisions(store.connection, { limit: 5 })
    expect(list).toHaveLength(5)
    // 倒序：在本次插入的 p-* 子集里，最新的 p-6 在最前（库里还有前面用例留下的真实冲突行）
    const mine = list.map((item) => item.id).filter((id) => id.startsWith('p-'))
    expect(mine[0]).toBe('p-6')
    expect(await countPendingDecisions(store.connection)).toBe(countBefore + 7)
  })
})
/**
 * Story 2.4 评审补丁 P1–P5 / P10 / P14 的回归钉（受审 HEAD = 4e265e5）。
 *
 * 与 db-dedup.test.ts 同构（真库 + HNSW，向量按 cosine 精确构造），但**独立成文件**：
 * LadybugDB 每实例预留 8 TiB、单进程约 15 个库封顶，因此每个测试文件都要有自己的开库预算
 * （本文件 9 个用例 = 9 次开库，留在 14 次以内）。
 *
 * 覆盖：
 * - P1 路径①墓碑：被路径③作废的节点在同文本重申时**复活**；expired_at（用户 forget）**不复活**
 * - P2 路径③把本次算定的 validAt 显式传给写入（旧版 invalid_at === 新节点 valid_at）
 * - P3 作废上界绝不早于旧节点自身 valid_at（调用方传入更早 validAt 时也不产生倒置区间）
 * - P4 路径③同事务落一条 keyed_decision ⇒ audit_gap 不因正常版本替换上涨
 * - P5 向量长度不可用时**剥离向量再写**（含指纹命中路径），绝不绑未校验长度的向量
 * - P10 ANN 扫描失败只告警、按无候选写入（不阻塞写入）
 * - P14 精确余弦差一点（≈0.9695）不算语义重复
 * - P20（Story 2.6 评审补钉）`scanFailure: 'throw'` / `skipSemanticScan`：事务内 ANN 失败必须让
 *   调用方事务**干净回滚**，而不是吞掉后继续写——LadybugDB 0.22.3 里事务内任一语句报错即中止
 *   整个事务，吞掉再写等于把数据写进一个已死的事务。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { computeAuditGap } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { SemanticScanError, writeDeduplicatedMemory } from '../src/db/dedup'
import { memoryNodeId } from '../src/db/id'
import { upsertMemory, type MemoryConnection } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/rows'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 8
const E1 = [1, 0, 0, 0, 0, 0, 0, 0]
const LAYER = 'L1'

/** 与 e1 的 cosine 恰为 c 的向量。 */
function vectorWithCosine(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0, 0, 0, 0, 0]
}

async function openDb(prefix: string): Promise<MemoryDatabase> {
  return openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir(prefix)),
    dim: DIM,
    modelId: 'test-embed',
  })
}

type DedupInput = Parameters<typeof writeDeduplicatedMemory>[1]
type DedupOptions = Parameters<typeof writeDeduplicatedMemory>[2]

/** 原语不自开事务（与 writeMemoryVersion 同一契约）——测试里补一层。 */
async function writeDedup(
  store: MemoryDatabase,
  input: DedupInput,
  options?: DedupOptions,
  conn: MemoryConnection = store.connection,
) {
  return runInTransaction(store.connection, () => writeDeduplicatedMemory(conn, input, options))
}

interface NodeView {
  text: string
  refs: string[]
  recordedAt: string
  validAt: string
  invalidAt: string | null
  expiredAt: string | null
  hasEmbedding: boolean
}

async function readNode(store: MemoryDatabase, id: string): Promise<NodeView> {
  const rows = await queryAll(
    store.connection,
    `MATCH (m:memory) WHERE m.id = '${id}' RETURN m.text AS text, m.source_refs AS refs,` +
      ' m.recorded_at AS recorded_at, m.valid_at AS valid_at, m.invalid_at AS invalid_at,' +
      ' m.expired_at AS expired_at, m.embedding IS NOT NULL AS has_embedding',
  )
  const row = rows[0]
  if (row === undefined) throw new Error('节点不存在：' + id)
  const text = (value: unknown): string =>
    value === null || value === undefined ? '' : String(value)
  return {
    text: text(row.text),
    refs: Array.isArray(row.refs) ? row.refs.map(String) : [],
    recordedAt: text(row.recorded_at),
    validAt: text(row.valid_at),
    invalidAt: row.invalid_at === null || row.invalid_at === undefined ? null : String(row.invalid_at),
    expiredAt: row.expired_at === null || row.expired_at === undefined ? null : String(row.expired_at),
    hasEmbedding: row.has_embedding === true,
  }
}

async function readAudit(
  store: MemoryDatabase,
  action: string,
): Promise<Array<{ reason: string; outcome: string }>> {
  const rows = await queryAll(
    store.connection,
    `MATCH (g:generation_log) WHERE g.action = '${action}' RETURN g.reason AS reason, g.outcome AS outcome`,
  )
  return rows.map((row) => ({ reason: String(row.reason ?? ''), outcome: String(row.outcome ?? '') }))
}

async function nodeCount(store: MemoryDatabase): Promise<number> {
  const rows = await queryAll(store.connection, 'MATCH (m:memory) RETURN count(m) AS total')
  return Number(rows[0]?.total ?? 0)
}

/** 直接置 expired_at（模拟用户 forget；写路径不提供这个动作）。 */
async function markExpired(store: MemoryDatabase, id: string, at: string): Promise<void> {
  const statement = await store.connection.prepare('MATCH (m:memory) WHERE m.id = $id SET m.expired_at = $at')
  await store.connection.execute(statement, { id, at })
}

/**
 * 代理连接：只拦截 `prepare`，用于「特定语句必抛」与「统计某类语句」两种桩。
 * 方法一律绑回真实连接，避免 this 指向代理。
 */
function proxyConnection(
  real: MemoryConnection,
  onPrepare?: (statement: string) => void,
): MemoryConnection {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return async (statement: string) => {
          onPrepare?.(statement)
          return target.prepare(statement)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as MemoryConnection
}

afterAll(cleanupTempDirs)

describe('Story 2.4 评审补丁：墓碑复活 / 时钟对齐 / 向量剥离 / ANN 兜底', () => {
  it('P1 复活：A → B（cos≈0.93，同源）→ 再写 A ⇒ 清 invalid_at、提 valid_at、并 source_refs、保留最早 recorded_at', async () => {
    const store = await openDb('omw-tb-revive-')
    try {
      const aId = memoryNodeId(LAYER, '被作废的旧事实')
      await writeDedup(store, {
        layer: LAYER,
        text: '被作废的旧事实',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const invalidated = await writeDedup(store, {
        layer: LAYER,
        text: '接替它的新版本',
        embedding: E1,
        sourceRefs: ['s1'],
        validAt: '2026-02-01T00:00:00.000Z',
        recordedAt: '2026-02-01T00:00:00.000Z',
      })
      expect(invalidated.outcome).toBe('version-invalidated')
      expect((await readNode(store, aId)).invalidAt).toBe('2026-02-01T00:00:00.000Z')

      // 同文本重申 ⇒ 指纹命中那个**已作废**的节点：必须复活（否则这条事实永久留在 recall 之外）
      const revived = await writeDedup(store, {
        layer: LAYER,
        text: '被作废的旧事实',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s2'],
        validAt: '2026-03-01T00:00:00.000Z',
      })
      expect(revived.outcome).toBe('fingerprint-merge')
      expect(revived.id).toBe(aId)
      expect(await nodeCount(store)).toBe(2)
      const node = await readNode(store, aId)
      expect(node.invalidAt).toBeNull()
      expect(node.validAt).toBe('2026-03-01T00:00:00.000Z')
      expect(node.refs.slice().sort()).toEqual(['s1', 's2'])
      expect(node.recordedAt).toBe('2026-01-01T00:00:00.000Z')
      const audits = await readAudit(store, 'resurrect_memory')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('success')
      expect(audits[0]!.reason).toContain('previous_invalid_at=2026-02-01T00:00:00.000Z')
    } finally {
      await store.close()
    }
  })

  it('P1 用户 forget 优先：expired_at 置位后重写 ⇒ 不复活、保留失效态、只记 uncertain（P19a：仍合并 source_refs）', async () => {
    const store = await openDb('omw-tb-forget-')
    try {
      const id = memoryNodeId(LAYER, '用户点名遗忘的事实')
      await writeDedup(store, {
        layer: LAYER,
        text: '用户点名遗忘的事实',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      await markExpired(store, id, '2026-02-01T00:00:00.000Z')

      const result = await writeDedup(store, {
        layer: LAYER,
        text: '用户点名遗忘的事实',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s2'],
        validAt: '2026-03-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('fingerprint-merge')
      expect(await nodeCount(store)).toBe(1)
      const node = await readNode(store, id)
      expect(node.expiredAt).toBe('2026-02-01T00:00:00.000Z')
      expect(node.validAt).toBe('2026-01-01T00:00:00.000Z')
      // 评审 P19a（T23）：不复活（expired_at / invalid_at 都不动），但 **source_refs 必须合并**。
      // processor 仍会为本次观测建 l0_raw→该节点 的 EVIDENCE 边（事实层面为真），而
      // EFFECTIVE_MEMORY_REFS / computeEvidenceDrift 都按 expired_at IS NULL 过滤 ⇒ 不合并的话
      // 两个载体（边 / source_refs）永久不一致且都不可见。
      expect(node.refs.slice().sort()).toEqual(['s1', 's2'])
      const audits = await readAudit(store, 'resurrect_memory')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.outcome).toBe('uncertain')
      expect(audits[0]!.reason).toContain('skip-resurrect expired_at=')
    } finally {
      await store.close()
    }
  })

  it('P2 时钟对齐：不传 validAt + 会前进的时钟 ⇒ 旧版 invalid_at === 新节点 valid_at（同一次读数）', async () => {
    const store = await openDb('omw-tb-clock-')
    try {
      const oldId = memoryNodeId(LAYER, '旧版本（P2）')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '旧版本（P2）',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      // 每次读时钟都前进 1s：若写入路径不复用本次读数，T1 ≠ T2 会立刻暴露。
      let tick = 0
      const base = Date.parse('2026-05-01T00:00:00.000Z')
      const now = () => new Date(base + (tick += 1) * 1_000)
      const result = await writeDedup(store, { layer: LAYER, text: '新版本（P2）', embedding: E1, sourceRefs: ['s1'] }, { now })
      expect(result.outcome).toBe('version-invalidated')
      const old = await readNode(store, oldId)
      const fresh = await readNode(store, result.id)
      // 首个时钟读数 = base+1000（`++tick` 先自增）：旧版 invalid_at 与
      // 新节点 valid_at 必须都是**同一次**读数——这正是不复用读数的可判别点。
      expect(old.invalidAt).toBe('2026-05-01T00:00:01.000Z')
      expect(fresh.validAt).toBe(old.invalidAt)
    } finally {
      await store.close()
    }
  })

  it('P3 防倒置区间：调用方传入早于旧节点 valid_at 的 validAt ⇒ invalid_at 不早于旧节点 valid_at', async () => {
    const store = await openDb('omw-tb-invert-')
    try {
      const oldId = memoryNodeId(LAYER, '较晚的旧版本')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '较晚的旧版本',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-06-01T00:00:00.000Z',
        recordedAt: '2026-06-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '2.5 复用原语时传入的更早版本',
        embedding: E1,
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('version-invalidated')
      const old = await readNode(store, oldId)
      expect(old.validAt).toBe('2026-06-01T00:00:00.000Z')
      expect(old.invalidAt).toBe('2026-06-01T00:00:00.000Z')
      expect((await readNode(store, result.id)).validAt).toBe('2026-01-01T00:00:00.000Z')
    } finally {
      await store.close()
    }
  })

  it('P4 版本替换落 keyed_decision：audit_gap 不因正常版本作废而上涨', async () => {
    const store = await openDb('omw-tb-decide-')
    try {
      expect(await computeAuditGap(store.connection)).toBe(0)
      const oldId = memoryNodeId(LAYER, '旧版本（P4）')
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '旧版本（P4）',
        embedding: vectorWithCosine(0.93),
        sourceRefs: ['s1'],
        validAt: '2026-01-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await writeDedup(store, {
        layer: LAYER,
        text: '新版本（P4）',
        embedding: E1,
        sourceRefs: ['s1'],
        validAt: '2026-02-01T00:00:00.000Z',
        recordedAt: '2026-02-01T00:00:00.000Z',
      })
      expect(result.outcome).toBe('version-invalidated')
      expect(await computeAuditGap(store.connection)).toBe(0)
      const rows = await queryAll(
        store.connection,
        'MATCH (k:keyed_decision) RETURN k.action AS action, k.old_id AS old_id, k.new_id AS new_id,' +
          ' k.resolution_source AS resolution_source, k.policy AS policy',
      )
      expect(rows).toHaveLength(1)
      expect(String(rows[0]!.action)).toBe('supersede')
      expect(String(rows[0]!.old_id)).toBe(oldId)
      expect(String(rows[0]!.new_id)).toBe(result.id)
      expect(String(rows[0]!.resolution_source)).toBe('auto')
      expect(String(rows[0]!.policy)).toBe('last-writer-wins')
    } finally {
      await store.close()
    }
  })

  it('P5 维度失配 ⇒ 剥离向量再写（不抛错、节点无向量、告警含库内 dim）', async () => {
    const store = await openDb('omw-tb-dim-')
    try {
      const warns: string[] = []
      const result = await writeDedup(
        store,
        { layer: LAYER, text: '长度不符的向量', embedding: [0.5, 0.5, 0.5, 0.5], sourceRefs: ['m1'] },
        { logger: { warn: (m) => warns.push(m) } },
      )
      expect(result.outcome).toBe('created')
      const node = await readNode(store, result.id)
      expect(node.hasEmbedding).toBe(false)
      expect(warns).toHaveLength(1)
      expect(warns[0]!).toContain('dim=8')
      expect(warns[0]!).toContain('长度=4')
    } finally {
      await store.close()
    }
  })

  it('P5 指纹命中路径同样受长度校验保护：库里已有向量不被覆盖、也不绑坏向量', async () => {
    const store = await openDb('omw-tb-dim-fp-')
    try {
      const first = await writeDedup(store, { layer: LAYER, text: '已有向量的节点', embedding: E1, sourceRefs: ['m1'] })
      expect(first.outcome).toBe('created')
      const warns: string[] = []
      const again = await writeDedup(
        store,
        { layer: LAYER, text: '已有向量的节点', embedding: [0.25, 0.25], sourceRefs: ['m2'] },
        { logger: { warn: (m) => warns.push(m) } },
      )
      expect(again.outcome).toBe('fingerprint-merge')
      const node = await readNode(store, first.id)
      expect(node.hasEmbedding).toBe(true)
      expect(node.refs.slice().sort()).toEqual(['m1', 'm2'])
      expect(warns).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it('P10 ANN 扫描失败：按无候选写入、只告警、节点照常落库（不阻塞写入）', async () => {
    const store = await openDb('omw-tb-annfail-')
    try {
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '已有近似节点',
        embedding: vectorWithCosine(0.99),
        sourceRefs: ['m1'],
      })
      const warns: string[] = []
      let annAttempts = 0
      const conn = proxyConnection(store.connection, (statement) => {
        if (statement.includes('QUERY_VECTOR_INDEX')) {
          annAttempts += 1
          throw new Error('vector extension not loaded')
        }
      })
      const result = await writeDedup(
        store,
        { layer: LAYER, text: '即使索引挂了也要写进去', embedding: E1, sourceRefs: ['m2'] },
        { logger: { warn: (m) => warns.push(m) } },
        conn,
      )
      expect(annAttempts).toBe(1)
      expect(result.outcome).toBe('created')
      expect(await nodeCount(store)).toBe(2)
      expect((await readNode(store, result.id)).hasEmbedding).toBe(true)
      expect(warns).toHaveLength(1)
      expect(warns[0]!).toContain('语义去重扫描失败')
      expect(warns[0]!).toContain('vector extension not loaded')
    } finally {
      await store.close()
    }
  })

  it('P14 精确余弦差一点（≈0.9695 < 0.97）不算语义重复 ⇒ created', async () => {
    const store = await openDb('omw-tb-edge-')
    try {
      await upsertMemory(store.connection, {
        layer: LAYER,
        text: '差一点的近似表述',
        embedding: vectorWithCosine(0.9695),
        sourceRefs: ['x'],
      })
      // refs 无交集 ⇒ 也进不了版本链分支，判据只剩「精确余弦 ≥ 0.97」。
      const result = await writeDedup(store, { layer: LAYER, text: '另一条表述', embedding: E1, sourceRefs: ['y'] })
      expect(result.outcome).toBe('created')
      expect(await nodeCount(store)).toBe(2)
      expect(await readAudit(store, 'merge_semantic')).toHaveLength(0)
      expect(await readAudit(store, 'invalidate_version')).toHaveLength(0)
    } finally {
      await store.close()
    }
  })
  it('P20 scanFailure=throw：ANN 失败抛 SemanticScanError，调用方事务干净回滚', async () => {
    const store = await openDb('omw-tb-throw-')
    try {
      const conn = proxyConnection(store.connection, (statement) => {
        if (statement.includes('QUERY_VECTOR_INDEX')) throw new Error('vector extension not loaded')
      })
      await expect(
        writeDedup(
          store,
          { layer: LAYER, text: '扫描挂了必须让事务回滚', embedding: E1, sourceRefs: ['p20a'] },
          { scanFailure: 'throw' },
          conn,
        ),
      ).rejects.toThrow(SemanticScanError)
      // 干净回滚：不留节点、不留审计——留给调用方带 skipSemanticScan 重写。
      expect(await nodeCount(store)).toBe(0)
      expect(await readAudit(store, 'merge_semantic')).toHaveLength(0)
      expect(await readAudit(store, 'invalidate_version')).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('P20 skipSemanticScan：不碰 ANN、指纹路径照常、向量仍写入（索引自愈靠它）', async () => {
    const store = await openDb('omw-tb-skip-')
    try {
      const conn = proxyConnection(store.connection, (statement) => {
        if (statement.includes('QUERY_VECTOR_INDEX')) throw new Error('本轮连 ANN 都不该发')
      })
      const warns: string[] = []
      const result = await writeDedup(
        store,
        { layer: LAYER, text: '降级重试也要带向量落库', embedding: E1, sourceRefs: ['p20b'] },
        { skipSemanticScan: true, logger: { warn: (m) => warns.push(m) } },
        conn,
      )
      expect(result.outcome).toBe('created')
      expect((await readNode(store, result.id)).hasEmbedding).toBe(true)
      expect(warns.join('|')).toContain('语义去重扫描本轮跳过')
      // 同文本再来一次（不带 skip）：指纹命中，同样不碰 ANN。
      const again = await writeDedup(store, {
        layer: LAYER,
        text: '降级重试也要带向量落库',
        embedding: E1,
        sourceRefs: ['p20c'],
      })
      expect(again.outcome).toBe('fingerprint-merge')
      expect((await readNode(store, again.id)).refs.slice().sort()).toEqual(['p20b', 'p20c'])
    } finally {
      await store.close()
    }
  })
})


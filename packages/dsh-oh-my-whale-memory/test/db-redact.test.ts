/**
 * `--redact` 墓碑语义与 `evidence_degraded`（Story 4.2 / FR-14、AD-4、AD-19、AD-21）。
 *
 * 覆盖 I/O & Edge-Case 矩阵行 7、8、9、10、11、14、15（命令面解析/只读在
 * `command-forget-redact.test.ts`，status 行在 `command-status-evidence-degraded.test.ts`）。
 *
 * 本文件 1 次开库（beforeAll 建一次，全部用例复用同一 facade）。
 *
 * 图形态（一次建好，各用例只碰自己的子树）：
 * - `r1-l0a` → `r1-l1`（目标）、`r1-l0a` → `r1-l1b`（兄弟）、`r1-l1` → `r1-l2`（上层）、
 *   `r1-l0c` → `r1-other`（闭包外的对照节点）；
 * - `r2-l0` → `r2-l1` → `r2-l2`（矩阵行 9 的 L2 目标）；
 * - `r3-l0` → `r3-l1`（矩阵行 15 的无旗标回归）。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeAuditGap } from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { computeEiiViolations } from '../src/db/eii'
import { forgetMemory, type ForgetResult } from '../src/db/forget'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import { l0TombstoneText } from '../src/db/schema'
import { cleanupTempDirs, makeTempDir } from './tmp'

const T0 = '2026-01-01T00:00:00.000Z'
const TS = '2026-11-16T00:00:00.000Z'
/** 显式构造的假凭据（NFR9 纪律：绝不使用真实 token）。 */
const SECRET = 'sk-live-SECRET-' + randomUUID()

let store: MemoryDatabase

const fixedClock = { now: () => new Date(TS) }

async function exec(statement: string, params: Record<string, unknown> = {}): Promise<void> {
  await queryRows(store.connection, statement, params as never)
}

interface L0Row {
  readonly id: string
  readonly raw_text: string | null
  readonly recorded_at: string | null
  readonly actor: string | null
  readonly redacted_by: string | null
  readonly redacted_at: string | null
}

async function readL0(id: string): Promise<L0Row> {
  const rows = await queryRows(
    store.connection,
    'MATCH (l:l0_raw {id: $id}) RETURN l.id AS id, l.raw_text AS raw_text, l.recorded_at AS recorded_at, ' +
    'l.actor AS actor, l.redacted_by AS redacted_by, l.redacted_at AS redacted_at',
    { id },
  )
  return rows[0] as unknown as L0Row
}

interface MemoryFlags {
  readonly invalid_at: string | null
  readonly expired_at: string | null
  readonly evidence_degraded: boolean | null
  readonly text: string
}

async function readMemory(id: string): Promise<MemoryFlags> {
  const rows = await queryRows(
    store.connection,
    'MATCH (m:memory {id: $id}) RETURN m.invalid_at AS invalid_at, m.expired_at AS expired_at, ' +
    'm.evidence_degraded AS evidence_degraded, m.text AS text',
    { id },
  )
  return rows[0] as unknown as MemoryFlags
}

async function redactLogs(): Promise<string[]> {
  const rows = await queryRows(
    store.connection,
    "MATCH (g:generation_log) WHERE g.kind = 'redact' AND g.action = 'redact_l0' RETURN g.reason AS reason ORDER BY reason",
  )
  return rows.map((row) => String(row.reason))
}

async function createMemory(id: string, layer: string, text: string, refs: readonly string[]): Promise<void> {
  await queryRows(
    store.connection,
    'CREATE (:memory {id: $id, layer: $layer, kind: $kind, priority: $priority, text: $text, ' +
    'valid_at: $valid, recorded_at: $recorded, source_refs: $refs})',
    { id, layer, kind: '', priority: 0, text, valid: T0, recorded: T0, refs: [...refs] },
  )
}

async function createL0(id: string, text: string): Promise<void> {
  await queryRows(
    store.connection,
    'CREATE (:l0_raw {id: $id, raw_text: $text, recorded_at: $recorded, actor: $actor})',
    { id, text, recorded: T0, actor: 'session-1' },
  )
}

/** EVIDENCE 的两段都显式写标签：无标签 MATCH 在 0.22.3 建边时报「多个标签绑定」。 */
async function linkL0ToMemory(l0Id: string, memoryId: string): Promise<void> {
  await queryRows(
    store.connection,
    'MATCH (a:l0_raw {id: $from}), (b:memory {id: $to}) MERGE (a)-[:EVIDENCE]->(b)',
    { from: l0Id, to: memoryId },
  )
}

async function linkMemoryToMemory(fromId: string, toId: string): Promise<void> {
  await queryRows(
    store.connection,
    'MATCH (a:memory {id: $from}), (b:memory {id: $to}) MERGE (a)-[:EVIDENCE]->(b)',
    { from: fromId, to: toId },
  )
}

beforeAll(async () => {
  store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-redact-')),
    dim: 4,
    modelId: 'test-embed',
  })

  await createL0('r1-l0a', '会话：我的密钥是 ' + SECRET + ' 请记住')
  await createL0('r1-l0b', '另一段与密钥无关的观测')
  await createL0('r1-l0c', '闭包外的观测')
  await createMemory('r1-l1', 'L1', '原子记忆（不含密钥）', ['r1-l0a', 'r1-l0b'])
  await createMemory('r1-l1b', 'L1', '共用同一 L0 的兄弟记忆', ['r1-l0a'])
  await createMemory('r1-l2', 'L2', '上层综合陈述', ['r1-l1'])
  await createMemory('r1-other', 'L1', '闭包外的记忆', ['r1-l0c'])
  await linkL0ToMemory('r1-l0a', 'r1-l1')
  await linkL0ToMemory('r1-l0b', 'r1-l1')
  await linkL0ToMemory('r1-l0a', 'r1-l1b')
  await linkMemoryToMemory('r1-l1', 'r1-l2')
  await linkL0ToMemory('r1-l0c', 'r1-other')

  await createL0('r2-l0', 'L2 目标的底层观测')
  await createMemory('r2-l1', 'L1', 'L2 目标的中间层', ['r2-l0'])
  await createMemory('r2-l2', 'L2', 'L2 目标', ['r2-l1'])
  await linkL0ToMemory('r2-l0', 'r2-l1')
  await linkMemoryToMemory('r2-l1', 'r2-l2')

  await createL0('r3-l0', '无旗标路径的原始观测')
  await createMemory('r3-l1', 'L1', '不带 --redact 的目标', ['r3-l0'])
  await linkL0ToMemory('r3-l0', 'r3-l1')
})

afterAll(async () => {
  try {
    await store?.close()
  } catch {
    /* ignore */
  }
  await cleanupTempDirs()
})

describe('矩阵行 7/14：单条 L1 + --redact', () => {
  it('前置：L0 原文含假凭据、L1 正文不含（AC:1076 的断言面成立）', async () => {
    const before = await readL0('r1-l0a')
    expect(before.raw_text).toContain(SECRET)
    expect((await readMemory('r1-l1')).text).not.toContain(SECRET)
    const l0Hits = await queryRows(
      store.connection,
      'MATCH (l:l0_raw) WHERE l.raw_text CONTAINS $secret RETURN count(l) AS c',
      { secret: SECRET },
    )
    expect(Number(l0Hits[0]?.c)).toBe(1)
  })

  it('墓碑逐字、redacted_by=user、目标 expired_at；id/recorded_at/actor 不变；redact 账本行各一条', async () => {
    const beforeA = await readL0('r1-l0a')
    const beforeB = await readL0('r1-l0b')

    const result: ForgetResult = await forgetMemory(store.connection, 'r1-l1', {
      ...fixedClock,
      redact: { actor: 'user' },
    })

    expect(result.redactedL0).toBe(2)
    // 目标自身 + 共用 L0 的兄弟记忆（上层 r1-l2 已被 forget 级联 invalid_at，不计入）
    expect(result.degraded).toBe(2)

    const afterA = await readL0('r1-l0a')
    expect(afterA.raw_text).toBe(l0TombstoneText('r1-l0a', TS))
    expect(afterA.redacted_by).toBe('user')
    expect(afterA.redacted_at).toBe(TS)
    expect(afterA.id).toBe(beforeA.id)
    expect(afterA.recorded_at).toBe(beforeA.recorded_at)
    expect(afterA.actor).toBe(beforeA.actor)

    const afterB = await readL0('r1-l0b')
    expect(afterB.raw_text).toBe(l0TombstoneText('r1-l0b', TS))
    expect(afterB.redacted_at).toBe(TS)

    const target = await readMemory('r1-l1')
    expect(target.expired_at).toBe(TS)
    expect(target.evidence_degraded).toBe(true)

    expect(await redactLogs()).toEqual([
      'redact root=r1-l1 l0=r1-l0a',
      'redact root=r1-l1 l0=r1-l0b',
    ])
  })

  it('矩阵行 14：全表扫 l0_raw / generation_log 文本列零命中，FTS 查询零命中', async () => {
    const l0Hits = await queryRows(
      store.connection,
      'MATCH (l:l0_raw) WHERE l.raw_text CONTAINS $secret RETURN count(l) AS c',
      { secret: SECRET },
    )
    expect(Number(l0Hits[0]?.c)).toBe(0)

    const logHits = await queryRows(
      store.connection,
      'MATCH (g:generation_log) WHERE g.reason CONTAINS $secret OR g.policy CONTAINS $secret ' +
      'OR g.action CONTAINS $secret OR g.kind CONTAINS $secret OR g.actor CONTAINS $secret ' +
      'OR g.outcome CONTAINS $secret OR g.detail CONTAINS $secret OR g.trigger_id CONTAINS $secret ' +
      'OR g.question_key CONTAINS $secret RETURN count(g) AS c',
      { secret: SECRET },
    )
    expect(Number(logHits[0]?.c)).toBe(0)

    const fts = await queryRows(
      store.connection,
      "CALL QUERY_FTS_INDEX('memory', 'memory_text_fts', $q, K := $k, B := $b, TOP := $top) " +
      'WITH node, score MATCH (node) RETURN node.id AS id',
      { q: SECRET, k: 1.2, b: 0.75, top: 10 },
    )
    expect(fts).toEqual([])
  })

  it('矩阵行 8：二次 --redact 是 no-op —— 文本/首改时刻逐字不变，不新增账本行', async () => {
    const beforeA = await readL0('r1-l0a')
    const logsBefore = await redactLogs()

    const result = await forgetMemory(store.connection, 'r1-l1', {
      ...fixedClock,
      redact: { actor: 'user' },
    })

    expect(result.alreadyExpired).toBe(true)
    expect(result.redactedL0).toBe(0)
    expect(result.degraded).toBe(0)
    const afterA = await readL0('r1-l0a')
    expect(afterA.raw_text).toBe(beforeA.raw_text)
    expect(afterA.redacted_at).toBe(beforeA.redacted_at)
    expect(afterA.redacted_by).toBe(beforeA.redacted_by)
    expect(await redactLogs()).toEqual(logsBefore)
  })

  it('矩阵行 11：共用同一 L0 的兄弟节点也被降级，但内容与时间列不变', async () => {
    const sibling = await readMemory('r1-l1b')
    expect(sibling.evidence_degraded).toBe(true)
    expect(sibling.invalid_at).toBeNull()
    expect(sibling.expired_at).toBeNull()
    expect(sibling.text).toBe('共用同一 L0 的兄弟记忆')
  })

  it('矩阵行 11：闭包外的记忆零改动（L0 原文与降级标记都保持原样）', async () => {
    const other = await readMemory('r1-other')
    expect(other.evidence_degraded).toBeNull()
    expect(other.invalid_at).toBeNull()
    expect(other.expired_at).toBeNull()
    expect((await readL0('r1-l0c')).raw_text).toBe('闭包外的观测')
    expect((await readL0('r1-l0c')).redacted_at).toBeNull()
  })

  it('矩阵行 10：EII 不因墓碑上涨（降级节点被排除），audit_gap 仍 0', async () => {
    const violations = await computeEiiViolations(store.connection, TS)
    expect(violations).toEqual([])
    expect(await computeAuditGap(store.connection)).toBe(0)
  })
})

describe('矩阵行 9：L2 目标 --redact（高层不反向下杀）', () => {
  it('闭包内 L0 全部墓碑化；L1/L2 都标降级；L1 不被下杀', async () => {
    const result = await forgetMemory(store.connection, 'r2-l2', {
      ...fixedClock,
      redact: { actor: 'user' },
    })
    expect(result.redactedL0).toBe(1)
    expect(result.degraded).toBe(2)
    expect((await readL0('r2-l0')).raw_text).toBe(l0TombstoneText('r2-l0', TS))

    const l1 = await readMemory('r2-l1')
    expect(l1.evidence_degraded).toBe(true)
    expect(l1.invalid_at).toBeNull()
    expect(l1.expired_at).toBeNull()

    const l2 = await readMemory('r2-l2')
    expect(l2.evidence_degraded).toBe(true)
    // 目标自身照 4.1 写 expired_at；redact 不改变这一点，也不写 invalid_at。
    expect(l2.expired_at).toBe(TS)
    expect(l2.invalid_at).toBeNull()
  })
})

describe('矩阵行 15：无 --redact 回归', () => {
  it('L0 行完全不变、evidence_degraded 保持 NULL、结果不含 redact 计数', async () => {
    const before = await readL0('r3-l0')
    const result = await forgetMemory(store.connection, 'r3-l1', fixedClock)

    expect(result.alreadyExpired).toBe(false)
    expect(result.redactedL0).toBeUndefined()
    expect(result.degraded).toBeUndefined()
    const after = await readL0('r3-l0')
    expect(after.raw_text).toBe(before.raw_text)
    expect(after.redacted_at).toBeNull()
    expect(after.redacted_by).toBeNull()
    expect((await readMemory('r3-l1')).evidence_degraded).toBeNull()
    expect((await readMemory('r3-l1')).expired_at).toBe(TS)
  })
})


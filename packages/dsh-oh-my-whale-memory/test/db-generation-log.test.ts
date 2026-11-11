/**
 * 审计账本测试（Story 1.10 / AD-10、AD-18、AD-19、AD-21）。
 *
 * 契约：generation_log 与 keyed_decision 一次建表（不改既有三表）；任一写路径的日志行与
 * 节点同事务（要么都成、要么都失败）；invalidated_by 追加而非覆盖且重放幂等；audit_gap
 * 只算「已失效却无 keyed 裁决记录」的版本写入，审计表缺失时报不可用（null）而不是静默 0；
 * 记忆原文与凭据值绝不进账本（NFR9）。
 *
 * 依赖 Windows 上 PATH 里的 OpenSSL 3（vector/fts 扩展），同 db-upsert.test.ts。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendInvalidationCause,
  buildInvalidatedByKey,
  buildJudgeKey,
  computeAuditGap,
  insertGenerationLog,
  insertKeyedDecision,
  listPendingKeyedDecisions,
  markKeyedDecisionPublished,
} from '../src/db/audit'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { memoryNodeId } from '../src/db/id'
import { writeMemoryVersion } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { collectRows } from '../src/db/rows'
import { createGenerationLogTableStatement } from '../src/db/schema'
import { runInTransaction } from '../src/db/transaction'
import { cleanupTempDirs, makeTempDir } from './tmp'

const TS = '2026-11-11T00:00:00.000Z'
const EARLY = '2020-01-01T00:00:00.000Z'

/** 15 列全读，供「凭据不入账本」这类整表断言使用。 */
const ALL_LOGS =
  'MATCH (g:generation_log) RETURN g.id AS id, g.recorded_at AS recorded_at, g.actor AS actor, ' +
  'g.kind AS kind, g.action AS action, g.policy AS policy, g.l0_refs AS l0_refs, ' +
  'g.outcome AS outcome, g.reason AS reason, g.question_key AS question_key, ' +
  'g.probability AS probability, g.threshold AS threshold, g.passed AS passed, ' +
  'g.cascade_depth AS cascade_depth, g.trigger_id AS trigger_id'

let dir: string
let store: MemoryDatabase

/** 带参数的一次读/写；审计语句一律走绑定参数，不拼字符串。 */
async function rowsOn(
  db: MemoryDatabase,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const prepared = await db.connection.prepare(statement)
  return collectRows(await db.connection.execute(prepared, params))
}

async function rows(statement: string, params: Record<string, unknown> = {}) {
  return rowsOn(store, statement, params)
}

async function allLogs(): Promise<Record<string, unknown>[]> {
  return rows(ALL_LOGS)
}

function refsOf(row: Record<string, unknown>): string[] {
  return Array.isArray(row.l0_refs) ? (row.l0_refs as unknown[]).map(String) : []
}

function logByRef(logs: Record<string, unknown>[], ref: string): Record<string, unknown> | undefined {
  return logs.find((row) => refsOf(row).includes(ref))
}

async function countMemory(id: string): Promise<number> {
  const result = await rows('MATCH (m:memory {id: $id}) RETURN count(m) AS n', { id })
  return Number(result[0]?.n ?? -1)
}

beforeAll(async () => {
  dir = await makeTempDir('omw-audit-')
  store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: 4, modelId: 'test-embed-model' })
})

afterAll(async () => {
  try {
    await store?.close()
  } catch {
    /* ignore */
  }
  await cleanupTempDirs()
})

describe('审计账本：同事务与只 append（AD-10 / AD-21）', () => {
  it('runInTransaction：事务内第二条日志行撞主键 → 整事务回滚并重抛原始错误', async () => {
    const fixedId = 'dup-' + randomUUID()
    const before = (await allLogs()).length
    await expect(
      runInTransaction(store.connection, async () => {
        await insertGenerationLog(store.connection, { id: fixedId, recordedAt: TS, actor: 'system', kind: 'capture', action: 'probe' })
        await insertGenerationLog(store.connection, { id: fixedId, recordedAt: TS, actor: 'system', kind: 'capture', action: 'probe' })
      }),
    ).rejects.toThrow(/duplicated primary key/i)
    expect((await allLogs()).length).toBe(before)
  })

  it('同事务：记忆节点与溯源行要么都成、要么都失败（AD-10 置序）', async () => {
    const text = '回滚演示-' + randomUUID()
    const id = memoryNodeId('L1', text)
    const ref = 'l0-rollback-' + randomUUID()
    const fixedId = 'roll-' + randomUUID()
    await expect(
      runInTransaction(store.connection, async () => {
        await writeMemoryVersion(store.connection, { layer: 'L1', text, sourceRefs: [ref] })
        await insertGenerationLog(store.connection, { id: fixedId, recordedAt: TS, actor: 'system', kind: 'capture', action: 'upsert_memory', l0Refs: [ref] })
        await insertGenerationLog(store.connection, { id: fixedId, recordedAt: TS, actor: 'system', kind: 'capture', action: 'upsert_memory', l0Refs: [ref] })
      }),
    ).rejects.toThrow(/duplicated primary key/i)
    expect(await countMemory(id)).toBe(0)
    expect(logByRef(await allLogs(), ref)).toBeUndefined()
  })

  it('upsertMemory：节点与一条溯源行同事务落地，字段逐字（agent / capture / upsert_memory / last-writer-wins / success）', async () => {
    const text = '采集-' + randomUUID()
    const ref = 'msg-' + randomUUID()
    const before = (await allLogs()).length
    const written = await store.upsertMemory({ layer: 'L1', text, embedding: null, sourceRefs: [ref], actor: 'agent' })
    const logs = await allLogs()
    expect(logs.length).toBe(before + 1)
    const row = logByRef(logs, ref)
    expect(row).toBeDefined()
    expect(String(row!.id)).toMatch(/^[0-9a-f-]{8,}/)
    expect(String(row!.kind)).toBe('capture')
    expect(String(row!.action)).toBe('upsert_memory')
    expect(String(row!.actor)).toBe('agent')
    expect(String(row!.policy)).toBe('last-writer-wins')
    expect(String(row!.outcome)).toBe('success')
    expect(String(row!.recorded_at)).toMatch(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T/)
    expect(refsOf(row!)).toEqual([ref])
    for (const column of ['reason', 'question_key', 'probability', 'threshold', 'passed', 'cascade_depth', 'trigger_id']) {
      expect(row![column] ?? null).toBeNull()
    }
    expect(await countMemory(written.id)).toBe(1)
  })

  it('缺省 actor=system；同指纹二次写入各记一行（节点 recorded_at 保留最早，日志 recorded_at 是操作时间）', async () => {
    const text = '重复-' + randomUUID()
    const ref1 = 'msg-a-' + randomUUID()
    const ref2 = 'msg-b-' + randomUUID()
    const first = await store.upsertMemory({ layer: 'L2', text, embedding: null, sourceRefs: [ref1], recordedAt: EARLY })
    const second = await store.upsertMemory({ layer: 'L2', text, embedding: null, sourceRefs: [ref2] })
    expect(second.id).toBe(first.id)
    const logs = await allLogs()
    const rowA = logByRef(logs, ref1)
    const rowB = logByRef(logs, ref2)
    expect(rowA).toBeDefined()
    expect(rowB).toBeDefined()
    expect(rowA!.id).not.toBe(rowB!.id)
    expect(String(rowA!.actor)).toBe('system')
    expect(String(rowB!.actor)).toBe('system')
    expect(String(rowA!.recorded_at)).not.toBe(EARLY)
    expect(String(rowB!.recorded_at)).not.toBe(EARLY)
    const node = await rows('MATCH (m:memory {id: $id}) RETURN m.recorded_at AS recorded_at', { id: first.id })
    expect(String(node[0]!.recorded_at)).toBe(EARLY)
  })
})

describe('失效因果与 keyed 裁决（AD-18 / AD-19）', () => {
  it('invalidated_by：同 (source, target) 键下追加触发 id 不覆盖，同触发重放幂等，反向键独立', async () => {
    const judgeKey = buildJudgeKey('last-writer-wins', 'old-a', 'new-a')
    await insertKeyedDecision(store.connection, {
      judgeKey, newId: 'new-a', oldId: 'old-a', action: 'supersede',
      policy: 'last-writer-wins', resolutionSource: 'auto', ts: TS,
    })
    const forward = buildInvalidatedByKey('new-a', 'old-a')
    const reverse = buildInvalidatedByKey('old-a', 'new-a')
    expect(await appendInvalidationCause(store.connection, { judgeKey, sourceId: 'new-a', targetId: 'old-a', triggerId: 'trig-1' })).toEqual(['trig-1'])
    expect(await appendInvalidationCause(store.connection, { judgeKey, sourceId: 'new-a', targetId: 'old-a', triggerId: 'trig-2' })).toEqual(['trig-1', 'trig-2'])
    expect(await appendInvalidationCause(store.connection, { judgeKey, sourceId: 'new-a', targetId: 'old-a', triggerId: 'trig-1' })).toEqual(['trig-1', 'trig-2'])
    expect(await appendInvalidationCause(store.connection, { judgeKey, sourceId: 'old-a', targetId: 'new-a', triggerId: 'trig-3' })).toEqual(['trig-3'])
    const read = await rows('MATCH (k:keyed_decision {judge_key: $jk}) RETURN k.invalidated_by AS ib', { jk: judgeKey })
    const ib = read[0]!.ib as Record<string, string[]>
    expect(ib instanceof Map).toBe(false)
    expect(ib[forward]).toEqual(['trig-1', 'trig-2'])
    expect(ib[reverse]).toEqual(['trig-3'])
  })

  it('buildJudgeKey 与新旧 id 先后无关、对 policy 敏感；buildInvalidatedByKey 有向', () => {
    const key = buildJudgeKey('last-writer-wins', 'old-1', 'new-1')
    expect(buildJudgeKey('last-writer-wins', 'new-1', 'old-1')).toBe(key)
    expect(buildJudgeKey('merge-policy', 'old-1', 'new-1')).not.toBe(key)
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(buildInvalidatedByKey('src', 'tgt')).toBe('src|tgt')
    expect(buildInvalidatedByKey('tgt', 'src')).toBe('tgt|src')
  })

  it('keyed 裁决幂等（MERGE 保留首次字段）、write_pending 翻转与待重放清单', async () => {
    const judgeKey = buildJudgeKey('merge-policy', 'old-9', 'new-9')
    await insertKeyedDecision(store.connection, {
      judgeKey, newId: 'new-9', oldId: 'old-9', action: 'merge', policy: 'merge-policy',
      resolutionSource: 'auto', writePending: true, ts: TS,
    })
    await insertKeyedDecision(store.connection, {
      judgeKey, newId: 'ignored', oldId: 'ignored', action: 'supersede', policy: 'other',
      resolutionSource: 'user', writePending: false, ts: '2030-01-01T00:00:00.000Z',
    })
    const read = await rows(
      'MATCH (k:keyed_decision {judge_key: $jk}) RETURN k.new_id AS new_id, k.action AS action, k.policy AS policy, k.resolution_source AS rs, k.write_pending AS wp, k.ts AS ts',
      { jk: judgeKey },
    )
    expect(String(read[0]!.new_id)).toBe('new-9')
    expect(String(read[0]!.action)).toBe('merge')
    expect(String(read[0]!.policy)).toBe('merge-policy')
    expect(String(read[0]!.rs)).toBe('auto')
    expect(read[0]!.wp).toBe(true)
    expect(String(read[0]!.ts)).toBe(TS)
    expect(await listPendingKeyedDecisions(store.connection)).toContain(judgeKey)
    await markKeyedDecisionPublished(store.connection, judgeKey)
    expect(await listPendingKeyedDecisions(store.connection)).not.toContain(judgeKey)
    await expect(markKeyedDecisionPublished(store.connection, 'missing-judge-key')).rejects.toMatchObject({
      code: 'audit_record_missing',
    })
  })
})

describe('audit_gap 只读校验器（AD-21）', () => {
  it('失效却无 keyed 裁决记录的版本写入计 1，补上记录后回到基线', async () => {
    const base = await computeAuditGap(store.connection)
    expect(typeof base).toBe('number')
    const written = await store.upsertMemory({ layer: 'L1', text: '墓碑-' + randomUUID(), embedding: null })
    await rows('MATCH (m:memory {id: $id}) SET m.invalid_at = $ts', { id: written.id, ts: TS })
    expect(await computeAuditGap(store.connection)).toBe((base ?? 0) + 1)
    await insertKeyedDecision(store.connection, {
      judgeKey: buildJudgeKey('last-writer-wins', written.id, 'new-node'),
      newId: 'new-node', oldId: written.id, action: 'supersede',
      policy: 'last-writer-wins', resolutionSource: 'review', ts: TS,
    })
    expect(await computeAuditGap(store.connection)).toBe(base)
  })

  it('审计表缺失：audit_gap 返回 null（不抛、不静默报 0）', async () => {
    const otherDir = await makeTempDir('omw-audit-missing-')
    const other = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(otherDir), dim: 4, modelId: 'test-embed-model' })
    try {
      expect(await computeAuditGap(other.connection)).toBe(0)
      await other.connection.query('DROP TABLE generation_log')
      expect(await computeAuditGap(other.connection)).toBeNull()
      await other.connection.query(createGenerationLogTableStatement())
      await other.connection.query('DROP TABLE keyed_decision')
      expect(await computeAuditGap(other.connection)).toBeNull()
    } finally {
      await other.close()
    }
  })
})

describe('NFR9：记忆原文与凭据值绝不进账本', () => {
  it('写入含凭据与原文的记忆后，generation_log 与 keyed_decision 的列都不含它们', async () => {
    const secret = 'sk-live-SECRET-' + randomUUID()
    const plaintext = '偏好：深色主题-' + randomUUID()
    const ref = 'msg-nfr9-' + randomUUID()
    await store.upsertMemory({ layer: 'L1', text: plaintext + secret, embedding: null, sourceRefs: [ref], actor: 'user' })
    const judgeKey = buildJudgeKey('last-writer-wins', 'old-nfr9', 'new-nfr9')
    await insertKeyedDecision(store.connection, {
      judgeKey, newId: 'new-nfr9', oldId: 'old-nfr9', action: 'supersede',
      policy: 'last-writer-wins', l0Refs: [ref], resolutionSource: 'auto', ts: TS,
    })
    const logDump = JSON.stringify(await allLogs())
    expect(logDump).not.toContain(secret)
    expect(logDump).not.toContain(plaintext)
    const decisionDump = JSON.stringify(
      await rows(
        'MATCH (k:keyed_decision) RETURN k.judge_key AS judge_key, k.new_id AS new_id, k.old_id AS old_id, ' +
        'k.action AS action, k.policy AS policy, k.l0_refs AS l0_refs, k.resolution_source AS resolution_source, ' +
        'k.invalidated_by AS invalidated_by, k.ts AS ts',
      ),
    )
    expect(decisionDump).not.toContain(secret)
    expect(decisionDump).not.toContain(plaintext)
  })
})

describe('同连接事务串行化（Design Note 5 / AD-10 置序）', () => {
  it('同一连接上的两个并发 runInTransaction 按调用顺序串行，两行都落库', async () => {
    const order: string[] = []
    const idA = randomUUID()
    const idB = randomUUID()

    await Promise.all([
      runInTransaction(store.connection, async () => {
        order.push('a-start')
        await insertGenerationLog(store.connection, { id: idA, recordedAt: TS, actor: 'system', kind: 'capture', action: 'serialize-probe' })
        order.push('a-end')
      }),
      runInTransaction(store.connection, async () => {
        order.push('b-start')
        await insertGenerationLog(store.connection, { id: idB, recordedAt: TS, actor: 'system', kind: 'capture', action: 'serialize-probe' })
        order.push('b-end')
      }),
    ])

    // 去掉 transaction.ts 的 promise 链时，第二个 BEGIN 会抛
    // 「Connection already has an active transaction」，本断言即失败。
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])

    const written = await rows("MATCH (g:generation_log) WHERE g.action = 'serialize-probe' RETURN g.id AS id")
    expect(written.map((row) => String(row.id)).sort()).toEqual([idA, idB].sort())
  })
})

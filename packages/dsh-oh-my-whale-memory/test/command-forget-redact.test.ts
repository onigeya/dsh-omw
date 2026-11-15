/**
 * `/memory forget <id> --redact` 命令层测试（Story 4.2 / 解析 + 渲染 + 只读拒绝）。
 *
 * 覆盖矩阵行 12（缺 id 的 usage）、行 13（只读实例零写入）、行 15（无旗标逐字回归）与
 * spec「钉死的输出文案」的 redact 追加行；真实落库由 `db-redact.test.ts` 覆盖。
 *
 * 本文件 0 次开库（假 deps / 假 facade），与 `command-forget.test.ts` 同一手法。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import { resolveRuntimeConfig } from '../src/config'
import { createInjectionStore } from '../src/injection/state'
import { READONLY_REASON } from '../src/db/writer-lock'
import { createMemoryAccess } from '../src/wire/access'
import type { MemoryDatabase } from '../src/db/database'
import {
  MEMORY_FORGET_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
} from '../src/command'

function makeDeps(overrides: Partial<MemoryCommandDependencies> = {}): MemoryCommandDependencies {
  return {
    writeInbox: async () => {},
    listMemories: async () => [],
    getMemoryById: async () => null,
    getStatus: async () => ({
      layers: { L1: 0, L2: 0 },
      inboxes: { L1: 0, L2: 0 },
      failed: 0,
      embeddingMode: 'enabled',
      systemOne: 'enabled',
      unembedded: 0,
      readonly: false,
      auditGap: 0,
      evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
      relatedSkipped: 0,
    }),
    recallMemories: async () => ({ total: 0, results: [], degraded: false, hint: '' }),
    relatedMemories: async () => ({ id: '', depth: 2, total: 0, results: [] }),
    forgetMemory: async () => ({ id: 'id-1', alreadyExpired: false, affected: [] }),
    ...overrides,
  }
}

/** 首次成功 + redact 计数（4.1 的两行头/清单后追加一行）。 */
const REDACT_RESULT = {
  id: 'id-1',
  alreadyExpired: false,
  affected: [
    { id: 'id-2', layer: 'L2', hops: 1, text: '上层综合陈述' },
    { id: 'id-1', layer: 'L1', hops: 0, text: '原子记忆' },
  ],
  redactedL0: 2,
  degraded: 3,
}

describe('parseMemoryCommand（forget --redact）', () => {
  it('`forget <id> --redact` → redact:true（旗标顺序无关）', () => {
    expect(parseMemoryCommand(' forget id-1 --redact')).toEqual({ kind: 'forget', id: 'id-1', redact: true })
    expect(parseMemoryCommand('forget --redact id-1')).toEqual({ kind: 'forget', id: 'id-1', redact: true })
  })

  it('不带旗标时结果里没有 redact 字段（4.1 的逐字相等断言不被破坏）', () => {
    expect(parseMemoryCommand(' forget id-1')).toEqual({ kind: 'forget', id: 'id-1' })
  })

  it('矩阵行 12：`/memory forget --redact` ⇒ usage error（不把旗标当 id 查库）', () => {
    expect(parseMemoryCommand(' forget --redact')).toEqual({ kind: 'invalid', usage: MEMORY_FORGET_USAGE })
  })

  it('重复旗标 / 多个 id / 未知旗标 ⇒ usage（不静默忽略输入）', () => {
    for (const input of ['forget id-1 --redact --redact', 'forget id-1 id-2 --redact', 'forget id-1 --force']) {
      expect(parseMemoryCommand(' ' + input)).toEqual({ kind: 'invalid', usage: MEMORY_FORGET_USAGE })
    }
  })

  it('usage 文案含旗标说明（可 grep 的口径）', () => {
    expect(MEMORY_FORGET_USAGE).toContain('用法：/memory forget <id> [--redact]')
    expect(MEMORY_FORGET_USAGE).toContain('--redact 额外把该记忆证据链上的 L0 原始段落替换为 [REDACTED <id> @<时间>] 墓碑')
    expect(MEMORY_FORGET_USAGE).toContain('evidence_degraded')
  })
})

describe('/memory forget --redact handler（钉死的输出文案）', () => {
  it('首次成功：4.1 的两行头/清单后追加「已改写 L0 墓碑 k 条，证据降级 m 条记忆」', async () => {
    const deps = makeDeps({ forgetMemory: vi.fn(async () => REDACT_RESULT) })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-1 --redact' })

    expect(result).toEqual({
      kind: 'success',
      text: [
        '已遗忘 id-1：共作废 2 条（其中级联 1 条）',
        '- id-2 [L2] 深度 1 上层综合陈述',
        '- id-1 [L1] 深度 0 原子记忆',
        '已改写 L0 墓碑 2 条，证据降级 3 条记忆',
      ].join('\n'),
    })
    expect(deps.forgetMemory).toHaveBeenCalledWith('id-1', { redact: true })
  })

  it('幂等重放 + --redact：4.1 的重放文案后同样追加一行（k=0 也显示）', async () => {
    const deps = makeDeps({
      forgetMemory: async () => ({
        id: 'id-1',
        alreadyExpired: true,
        affected: [{ id: 'id-1', layer: 'L1', hops: 0, text: '原子记忆' }],
        redactedL0: 0,
        degraded: 0,
      }),
    })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-1 --redact' })

    expect(result.text).toBe([
      '已遗忘 id-1：本次未重复写入（此前已遗忘）',
      '- id-1 [L1] 深度 0 原子记忆',
      '已改写 L0 墓碑 0 条，证据降级 0 条记忆',
    ].join('\n'))
  })

  it('矩阵行 15：不带旗标时输出逐字等于 4.1，且 dep 只收到一个参数', async () => {
    const forgetMemory = vi.fn(async () => ({
      id: 'id-1',
      alreadyExpired: false,
      affected: [
        { id: 'id-2', layer: 'L2', hops: 1, text: '上层综合陈述' },
        { id: 'id-1', layer: 'L1', hops: 0, text: '原子记忆' },
      ],
    }))
    const result = await createMemoryCommandDefinition(makeDeps({ forgetMemory }))
      .handler({ rawInput: ' forget id-1' })

    expect(result.text).toBe([
      '已遗忘 id-1：共作废 2 条（其中级联 1 条）',
      '- id-2 [L2] 深度 1 上层综合陈述',
      '- id-1 [L1] 深度 0 原子记忆',
    ].join('\n'))
    expect(forgetMemory).toHaveBeenCalledWith('id-1')
    expect(forgetMemory.mock.calls[0]).toHaveLength(1)
  })

  it('矩阵行 12：缺 id 的 handler 直接返回 usage，不调用 dep', async () => {
    const forgetMemory = vi.fn(async () => REDACT_RESULT)
    const result = await createMemoryCommandDefinition(makeDeps({ forgetMemory }))
      .handler({ rawInput: ' forget --redact' })
    expect(result).toEqual({ kind: 'error', text: MEMORY_FORGET_USAGE })
    expect(forgetMemory).not.toHaveBeenCalled()
  })
})

/**
 * 矩阵行 13：只读实例。`wire/access.ts` 是唯一拒绝点，假 facade 的 connection 一旦被碰
 * 就抛错——这同时证明「库内零写入」（连读都没发生，更不会写 L0 / memory）。
 */
describe('createMemoryAccess().forgetMemory（只读 + --redact）', () => {
  const RESOLVED = resolveRuntimeConfig({
    embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: 'bge-m3', dim: 4 },
  })

  function accessWith(db: MemoryDatabase | undefined) {
    return createMemoryAccess({
      getDb: () => db,
      resolved: RESOLVED,
      readonlyState: () => ({ readonly: db?.readonly === true }),
      getSystemOneClient: () => null,
      injectionStore: createInjectionStore(),
    })
  }

  function readonlyDb(): { db: MemoryDatabase; touched: () => boolean } {
    let touched = false
    const connection = {
      query: () => { touched = true; throw new Error('只读实例不应触碰连接') },
      prepare: () => { touched = true; throw new Error('只读实例不应触碰连接') },
    }
    return {
      db: {
        dbPath: '/tmp/omw-redact/lbug.db',
        readonly: true,
        connection,
      } as unknown as MemoryDatabase,
      touched: () => touched,
    }
  }

  it('只读实例 ⇒ 抛 readonly_mode，文案逐字复用 facade 的句子，且零连接访问', async () => {
    const { db, touched } = readonlyDb()
    const failure = accessWith(db).forgetMemory('id-1', { redact: true })
    await expect(failure).rejects.toBeInstanceOf(MemoryDbError)
    await expect(failure).rejects.toMatchObject({ code: 'readonly_mode', retryable: false })
    await expect(failure).rejects.toThrow(READONLY_REASON)
    expect(touched()).toBe(false)
  })

  it('可写实例 + redact ⇒ 透传到库层（连接被真正使用）', async () => {
    const query = vi.fn(() => { throw new Error('转发到了库层') })
    const db = {
      dbPath: '/tmp/omw-redact/lbug.db',
      readonly: false,
      connection: { query, prepare: query },
    } as unknown as MemoryDatabase
    await expect(accessWith(db).forgetMemory('id-1', { redact: true })).rejects.toThrow('转发到了库层')
    expect(query).toHaveBeenCalled()
  })
})

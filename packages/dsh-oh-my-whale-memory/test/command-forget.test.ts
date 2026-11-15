/**
 * `/memory forget` 命令层测试（Story 4.1 / 解析 + 渲染 + 错误收敛；假 deps，0 开库）。
 *
 * 覆盖矩阵行 3（不存在 ⇒ 未找到文案）、行 4（空 id ⇒ usage）与 spec「钉死的输出文案」
 * 的两个分支（首次成功 / 幂等重放），以及「命令不抛异常」的收敛契约。
 * 真实落库、list/show 可见性与账本行由 `command-forget-db.test.ts` 覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryDbError } from '../src/db/errors'
import { resolveRuntimeConfig } from '../src/config'
import { createInjectionStore } from '../src/injection/state'
import { READONLY_REASON } from '../src/db/writer-lock'
import { createMemoryAccess } from '../src/wire/access'
import type { MemoryDatabase } from '../src/db/database'
import {
  MEMORY_COMMAND_USAGE,
  MEMORY_FORGET_SUBCOMMAND,
  MEMORY_FORGET_USAGE,
  createMemoryCommandDefinition,
  parseMemoryCommand,
  type MemoryCommandDependencies,
  type MemoryCommandForgetResult,
} from '../src/command'

/** 全部 dep 都可替换；未覆盖的给默认实现（本文件只关心 forget 相关的几个分支）。 */
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

/** 首次成功：目标 + 一条级联受害者（跳数降序，目标在最后）。 */
const CASCADE_RESULT: MemoryCommandForgetResult = {
  id: 'id-1',
  alreadyExpired: false,
  affected: [
    { id: 'id-2', layer: 'L2', hops: 1, text: '上层综合陈述' },
    { id: 'id-1', layer: 'L1', hops: 0, text: '原子记忆' },
  ],
}

describe('parseMemoryCommand（forget 分支）', () => {
  it("'forget <id>' → { kind:'forget', id }（首尾空白被 trim，id 内不切分）", () => {
    expect(parseMemoryCommand(' forget id-1')).toEqual({ kind: 'forget', id: 'id-1' })
    expect(parseMemoryCommand('forget   id-1   ')).toEqual({ kind: 'forget', id: 'id-1' })
  })

  it('缺 id → invalid + forget usage（矩阵行 4：参数错误先于查库）', () => {
    expect(parseMemoryCommand(' forget')).toEqual({ kind: 'invalid', usage: MEMORY_FORGET_USAGE })
    expect(parseMemoryCommand('forget    ')).toEqual({ kind: 'invalid', usage: MEMORY_FORGET_USAGE })
  })

  it('子命令常量与总 usage 覆盖 forget（未知子命令仍走总 usage）', () => {
    expect(MEMORY_FORGET_SUBCOMMAND).toBe('forget')
    expect(MEMORY_FORGET_USAGE).toContain('/memory forget <id>')
    expect(MEMORY_COMMAND_USAGE).toContain('/memory forget <id>')
    expect(parseMemoryCommand(' Forget id-1')).toEqual({
      kind: 'invalid',
      usage: MEMORY_COMMAND_USAGE,
    })
  })
})

describe('/memory forget handler（钉死的输出文案）', () => {
  it('首次成功：首行「共作废 N 条（其中级联 N-1 条）」+ 每行「- <id> [<layer>] 深度 <d> <摘要>」', async () => {
    const deps = makeDeps({ forgetMemory: vi.fn(async () => CASCADE_RESULT) })
    const definition = createMemoryCommandDefinition(deps)
    const result = await definition.handler({ rawInput: ' forget id-1' })

    expect(result).toEqual({
      kind: 'success',
      text: [
        '已遗忘 id-1：共作废 2 条（其中级联 1 条）',
        '- id-2 [L2] 深度 1 上层综合陈述',
        '- id-1 [L1] 深度 0 原子记忆',
      ].join('\n'),
    })
    expect(deps.forgetMemory).toHaveBeenCalledWith('id-1')
  })

  it('幂等重放：首行「本次未重复写入（此前已遗忘）」，只有目标一行、深度 0', async () => {
    const deps = makeDeps({
      forgetMemory: async () => ({
        id: 'id-1',
        alreadyExpired: true,
        affected: [{ id: 'id-1', layer: 'L1', hops: 0, text: '原子记忆' }],
      }),
    })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-1' })

    expect(result).toEqual({
      kind: 'success',
      text: [
        '已遗忘 id-1：本次未重复写入（此前已遗忘）',
        '- id-1 [L1] 深度 0 原子记忆',
      ].join('\n'),
    })
  })

  it('矩阵行 16：text 含换行与超长 ⇒ 摘要折叠空白并截断，行格式不被破坏', async () => {
    const long = '很长的记忆正文'.repeat(20)
    const deps = makeDeps({
      forgetMemory: async () => ({
        id: 'id-1',
        alreadyExpired: false,
        affected: [{ id: 'id-1', layer: 'L1', hops: 0, text: `第一行\n第二行 ${long}` }],
      }),
    })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-1' })
    expect(result.kind).toBe('success')
    const lines = result.text!.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.startsWith('- id-1 [L1] 深度 0 第一行 第二行 ')).toBe(true)
    expect(lines[1]).toContain('…')
    expect(lines[1]!.length).toBeLessThan(200)
  })

  it('矩阵行 3：不存在 ⇒ error + 「未找到 id 为 <id> 的记忆。」（与 show 逐字一致）', async () => {
    const deps = makeDeps({
      forgetMemory: async () => {
        throw new Error('未找到 id 为 id-x 的记忆。')
      },
    })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-x' })
    expect(result).toEqual({ kind: 'error', text: '未找到 id 为 id-x 的记忆。' })
  })

  it('矩阵行 12：只读实例 ⇒ error（文案含 readonly_mode 判据），handler 不抛', async () => {
    const deps = makeDeps({
      forgetMemory: async () => {
        throw new Error("记忆库处于只读模式（another instance owns the writer lock），拒绝写入（/tmp/lbug.db）")
      },
    })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget id-1' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('只读模式')
  })

  it('缺 id 时不调用 dep，直接返回 usage error', async () => {
    const forgetMemory = vi.fn(async () => CASCADE_RESULT)
    const deps = makeDeps({ forgetMemory })
    const result = await createMemoryCommandDefinition(deps).handler({ rawInput: ' forget  ' })
    expect(result.kind).toBe('error')
    expect(result.text).toBe(MEMORY_FORGET_USAGE)
    expect(forgetMemory).not.toHaveBeenCalled()
  })
})

/**
 * `wire/access.ts` 的 forgetMemory（矩阵行 12 的真实分支）：0 开库，用假 facade 走三条路径。
 * 这一层是「只读实例必须先拒」的唯一实现处，命令层只负责把异常收敛成 error 结果。
 */
describe('createMemoryAccess().forgetMemory（矩阵行 12）', () => {
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

  /** 只提供本分支会用到的字段；connection 一旦被碰就先炸出来（库内零写入的旁证）。 */
  function fakeDb(overrides: { readonly?: boolean, connection?: unknown } = {}): MemoryDatabase {
    const connection = overrides.connection ?? {
      query: () => { throw new Error('只读实例不应触碰连接') },
    }
    return {
      dbPath: '/tmp/omw-forget/lbug.db',
      readonly: overrides.readonly ?? true,
      connection,
    } as unknown as MemoryDatabase
  }

  it('库未就绪 ⇒ 抛写入未就绪（不触碰连接）', async () => {
    await expect(accessWith(undefined).forgetMemory('id-1')).rejects.toThrow(/记忆库未就绪/)
  })

  it('只读实例 ⇒ 抛 readonly_mode，文案逐字复用 facade 的句子', async () => {
    const failure = accessWith(fakeDb({ readonly: true })).forgetMemory('id-1')
    await expect(failure).rejects.toBeInstanceOf(MemoryDbError)
    await expect(failure).rejects.toMatchObject({ code: 'readonly_mode', retryable: false })
    await expect(failure).rejects.toThrow(READONLY_REASON)
    await expect(failure).rejects.toThrow('/tmp/omw-forget/lbug.db')
  })

  it('可写实例 ⇒ 转发到 db/forget（事务由库层自开）', async () => {
    const query = vi.fn(() => { throw new Error('转发到了库层') })
    const access = accessWith(fakeDb({ readonly: false, connection: { query } }))
    await expect(access.forgetMemory('id-1')).rejects.toThrow('转发到了库层')
    expect(query).toHaveBeenCalled()
  })
})

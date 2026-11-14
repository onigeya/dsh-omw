/**
 * `/memory status` 的 failed 死信视图测试（Story 2.2 / AC4）。
 *
 * 两层证据：
 * - 渲染层（纯函数）：没有 failedEntries 时既有逐行输出**逐字不变**；有死信时追加
 *   `failed 最近条目:` 与最近条目行（stale 标注、lastError 单行化）；
 * - 集成层（真库 + 真 apply）：造两条真死信（一条 25h 前更新的 stale），经命令 handler
 *   断言 `failed: 2`、最近条目行、顺序（新在前）与 stale 标注。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import type { MemoryConnection } from '../src/db/memory'
import {
  claimNextInboxItem,
  enqueueInboxItem,
  failInboxItem,
} from '../src/inbox/queue'
import {
  renderMemoryStatus,
  type MemoryCommandDefinition,
  type MemoryStatusSnapshot,
} from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }

afterAll(cleanupTempDirs)

const BASE_SNAPSHOT: MemoryStatusSnapshot = {
  layers: { L1: 1, L2: 2 },
  inboxes: { L1: 3, L2: 4 },
  failed: 0,
  embeddingMode: 'enabled',
  systemOne: 'enabled',
  unembedded: 0,
  readonly: false,
  auditGap: 0,
  evidenceGap: { total: 0, eiiViolations: 0, drift: 0 },
  relatedSkipped: 0,
}

const BASE_LINES = [
  '记忆状态',
  'L1: 1',
  'L2: 2',
  'L1_INBOX: 3',
  'L2_INBOX: 4',
  'failed: 0',
  'audit_gap: 0',
  'embedding: enabled',
  'systemOne: enabled',
  'readonly: false',
  'injection: 未知（本实例尚未触发开局注入）',
]

describe('AC4 渲染层：无死信时既有输出逐字不变', () => {
  it('failedEntries 缺失或为空数组都不追加任何行', () => {
    expect(renderMemoryStatus(BASE_SNAPSHOT)).toBe(BASE_LINES.join('\n'))
    expect(renderMemoryStatus({ ...BASE_SNAPSHOT, failedEntries: [] })).toBe(BASE_LINES.join('\n'))
  })

  it('有死信时追加「failed 最近条目:」与逐条摘要（stale / 单行化 / 空错误）', () => {
    const text = renderMemoryStatus({
      ...BASE_SNAPSHOT,
      failed: 2,
      failedEntries: [
        {
          id: 'i-stale',
          kind: 'work_fact',
          attempts: 4,
          lastError: 'boom\nline2',
          updatedAt: '2026-11-10T00:00:00.000Z',
          stale: true,
        },
        {
          id: 'i-fresh',
          kind: 'persona',
          attempts: 4,
          lastError: null,
          updatedAt: '2026-11-11T00:00:00.000Z',
          stale: false,
        },
      ],
    })
    const lines = text.split('\n')
    expect(lines.slice(0, 10)).toEqual([
      '记忆状态',
      'L1: 1',
      'L2: 2',
      'L1_INBOX: 3',
      'L2_INBOX: 4',
      'failed: 2',
      'audit_gap: 0',
      'embedding: enabled',
      'systemOne: enabled',
      'readonly: false',
    ])
    expect(lines[10]).toBe('failed 最近条目:')
    expect(lines[11]).toBe(
      '- i-stale kind=work_fact attempts=4 stale updated_at=2026-11-10T00:00:00.000Z error=boom\\nline2',
    )
    expect(lines[12]).toBe(
      '- i-fresh kind=persona attempts=4 updated_at=2026-11-11T00:00:00.000Z error=(空)',
    )
    expect(lines).toHaveLength(14) // 10 基准 + failed 头 + 2 条明细 + Story 3.3 注入行
  })

  it('P5：id/kind 内的换行也被单行化，不伪造额外行', () => {
    const text = renderMemoryStatus({
      ...BASE_SNAPSHOT,
      failed: 1,
      failedEntries: [
        {
          id: 'i-1\n伪造行',
          kind: 'work_fact\n伪造行',
          attempts: 4,
          lastError: null,
          updatedAt: '2026-11-11T00:00:00.000Z',
          stale: false,
        },
      ],
    })
    const lines = text.split('\n')
    // 10 行基准 + 「failed 最近条目:」+ 1 行条目：id/kind 里的换行不得裂成更多行。
    // Story 3.3：末行注入状态行 ⇒ 12 → 13。
    expect(lines).toHaveLength(13)
    expect(lines[11]).toContain('i-1')
    expect(lines[11]).toContain('kind=work_fact')
    expect(lines[11]).toContain('attempts=4')
  })
})

function makeCtx(
  profileDir: string | undefined,
  registeredDefs: MemoryCommandDefinition[],
  onEvents: string[] = [],
): Parameters<typeof plugin.apply>[0] {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    get: (key: string) => {
      if (key === 'profileContext') return profileDir === undefined ? undefined : { dir: profileDir }
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
    on: (event: string) => {
      onEvents.push(event)
      return () => {}
    },
  } as unknown as Parameters<typeof plugin.apply>[0]
}

/** 造一条真死信：入队 → 连续 4 轮 claim+fail（第 4 轮进 failed）。 */
async function makeDeadLetter(
  connection: MemoryConnection,
  id: string,
  kind: string,
  now: Date,
  message: string,
): Promise<void> {
  await enqueueInboxItem(connection, { payload: '死信夹具', kind, sessionId: 'sess-status', now, id })
  // R3①：失败回 pending 会写退避截止（最长 20s），每轮前进 1 分钟越过窗口，同时不破坏 25h 的 stale 断言。
  for (let round = 0; round < 4; round += 1) {
    const stamp = new Date(now.getTime() + round * 60_000)
    const item = await claimNextInboxItem(connection, { owner: 'status-fixture', now: stamp })
    if (!item) throw new Error('死信夹具取不到队头：' + id)
    await failInboxItem(connection, item.id, { error: new Error(message), now: stamp })
  }
}

describe('AC4 集成：真库死信进入 status', () => {
  it('failed 计数 + 最近条目 + stale 标注（新在前）', async () => {
    const dir = await makeTempDir('omw-inbox-status-')
    const registeredDefs: MemoryCommandDefinition[] = []
    const onEvents: string[] = []
    // 先造死信、再 apply：Story 2.3 起 apply 会接线真精炼处理器，活消费者会在 pending 窗口抢走队头
    // （实测 lease_owner = 进程 id）。死信（failed）永不被取，所以夹具先落库、插件后启动即可独占驱动队列。
    const store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
    const stale = 'status-dead-stale'
    const fresh = 'status-dead-fresh'
    const staleNow = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await makeDeadLetter(store.connection, stale, 'work_fact', staleNow, '老账失败')
    await makeDeadLetter(store.connection, fresh, 'persona', new Date(), '人格失败')
    await store.close()

    await plugin.apply(makeCtx(dir, registeredDefs, onEvents), EMBEDDING_CONFIG)
    // Story 3.1：召回配额重置监听（只读早退之前注册）+ 写者模式的闸门/采集监听。
    // Story 3.3：开局注入的 `agent/pre-step` 监听（在只读早退前注册）。
    // Story 3.3 / F-05：`session/disposed` 清理监听 + 写者模式的闸门/采集监听。
    expect(onEvents).toEqual(['session/event', 'agent/pre-step', 'session/event', 'session/event'])
    expect(registeredDefs).toHaveLength(1)

    const result = await registeredDefs[0]!.handler({ rawInput: ' status' })
    expect(result.kind).toBe('success')
    const lines = result.text.split('\n')
    expect(lines).toContain('failed: 2')
    expect(lines).toContain('failed 最近条目:')

    const staleLine = lines.find((line) => line.startsWith('- ' + stale + ' '))
    const freshLine = lines.find((line) => line.startsWith('- ' + fresh + ' '))
    expect(staleLine).toBeDefined()
    expect(freshLine).toBeDefined()
    expect(staleLine).toMatch(/^\- status-dead-stale kind=work_fact attempts=4 stale updated_at=\d{4}-.* error=老账失败$/)
    expect(freshLine).toMatch(/^- status-dead-fresh kind=persona attempts=4 updated_at=\d{4}-.* error=人格失败$/)
    expect(freshLine).not.toContain('stale')
    expect(result.text).not.toContain('attempts=3')
    expect(result.text.indexOf(fresh)).toBeLessThan(result.text.indexOf(stale))
  }, 30_000)
})

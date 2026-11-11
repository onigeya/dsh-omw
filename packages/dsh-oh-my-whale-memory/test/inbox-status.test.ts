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
  readonly: false,
  auditGap: 0,
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
  'readonly: false',
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
    expect(lines.slice(0, 9)).toEqual([
      '记忆状态',
      'L1: 1',
      'L2: 2',
      'L1_INBOX: 3',
      'L2_INBOX: 4',
      'failed: 2',
      'audit_gap: 0',
      'embedding: enabled',
      'readonly: false',
    ])
    expect(lines[9]).toBe('failed 最近条目:')
    expect(lines[10]).toBe(
      '- i-stale kind=work_fact attempts=4 stale updated_at=2026-11-10T00:00:00.000Z error=boom\\nline2',
    )
    expect(lines[11]).toBe(
      '- i-fresh kind=persona attempts=4 updated_at=2026-11-11T00:00:00.000Z error=(空)',
    )
    expect(lines).toHaveLength(12)
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
  for (let round = 0; round < 4; round += 1) {
    const stamp = new Date(now.getTime() + round * 1000)
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
    await plugin.apply(makeCtx(dir, registeredDefs, onEvents), EMBEDDING_CONFIG)
    expect(onEvents).toEqual(['session/event'])
    expect(registeredDefs).toHaveLength(1)

    const store = await openMemoryDatabase({ dbPath: resolveMemoryDbPath(dir), dim: DIM, modelId: MODEL_ID })
    const stale = 'status-dead-stale'
    const fresh = 'status-dead-fresh'
    const staleNow = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await makeDeadLetter(store.connection, stale, 'work_fact', staleNow, '老账失败')
    await makeDeadLetter(store.connection, fresh, 'persona', new Date(), '人格失败')

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

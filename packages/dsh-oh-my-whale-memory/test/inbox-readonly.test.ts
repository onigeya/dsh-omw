/**
 * 只读实例的 INBOX 行为测试（Story 2.2 / AC7，AD-12）。
 *
 * 跨进程是 AD-12 的真实场景（两个 DSH 窗口 = 两个进程），用 fixtures/hold-db-open.mjs
 * 扮演「持写者锁的第一实例」（同 command-status-db.test.ts）。第二实例 apply 后：
 * - 不启动消费者（只注册召回配额重置监听，不接闸门/采集的 session/event 监听）、不回收过期 lease；
 * - 库内 `processing` + lease_owner=dead-writer 的过期 lease 条目原样保留（未被回收）；
 * - 运行态标注 readonly: true，且没有「记忆库就绪」的 info。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import * as plugin from '../src/index'
import { openMemoryDatabase } from '../src/db/database'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { queryAll } from '../src/db/memory'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createL0RawTableStatement,
  createL1InboxTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
} from '../src/db/schema'
import { READONLY_REASON } from '../src/db/writer-lock'
import type { MemoryCommandDefinition } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL_ID = 'bge-m3'
const EMBEDDING_CONFIG = { embedding: { token: 'sk-test', model: MODEL_ID, dim: DIM } }
const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
const TS = (seconds: number): string => `2026-11-01T00:00:${String(seconds).padStart(2, '0')}.000Z`

afterAll(cleanupTempDirs)

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/** 只读打开只校验 meta + memory 表与 dim（不建索引、不装扩展）。 */
function buildReadonlyStatements(dim: number, withInbox = true): string[] {
  // 只回 lease 值的单参 helper：owner 空串渲染 null（原本多一个从不使用的 until 形参，删掉避免误导）。
  const lease = (owner: string): string => (owner === '' ? 'null' : `'${owner}'`)
  const inboxRow = (
    id: string,
    status: string,
    leaseOwner: string,
    leaseUntil: string,
    at: string,
  ): string =>
    `CREATE (q:l1_inbox {id: '${id}', session_id: 'ro-session', kind: 'episodic', payload: '只读夹具草稿', ` +
    `status: '${status}', attempts: 1, lease_owner: ${lease(leaseOwner)}, ` +
    `lease_until: ${lease(leaseUntil)}, enqueued_at: '${at}', updated_at: '${at}'})`
  return [
    createMetaTableStatement(),
    createMemoryTableStatement(dim),
    createL0RawTableStatement(),
    // 缺表夹具（withInbox=false）刻意不建 l1_inbox：/memory status 读到它必须照抛。
    ...(withInbox ? [createL1InboxTableStatement()] : []),
    mergeMeta(META_KEYS.schemaVersion, SCHEMA_VERSION),
    mergeMeta(META_KEYS.embeddingDim, String(dim)),
    mergeMeta(META_KEYS.embeddingModelId, MODEL_ID),
    mergeMeta(META_KEYS.createdAt, TS(1)),
    ...(withInbox
      ? [
        // 过期 lease（lease_until 在 2026-11-01，远早于 now）：只读实例必须不回收它。
        inboxRow('ro-expired-lease', 'processing', 'dead-writer', TS(2), TS(1)),
        inboxRow('ro-pending', 'pending', '', '', TS(3)),
      ]
      : []),
  ]
}

async function startWriterInstance(dbPath: string, statements: string[]): Promise<{ stop(): Promise<void> }> {
  await ensureMemoryDbDirectory(dbPath)
  const child = spawn(process.execPath, [FIXTURE, dbPath], { stdio: 'pipe' })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('ready')) resolve()
    })
    void exited.then(() => reject(new Error(`夹具未就绪就退出（dbPath=${dbPath}）：${stderr}`)))
    child.stdin.write(`${JSON.stringify({ statements })}\n`)
  })

  return {
    async stop() {
      child.stdin.end()
      await exited
    },
  }
}

function makeCtx(
  profileDir: string,
  registeredDefs: MemoryCommandDefinition[],
  onEvents: string[],
  warnLog: string[],
  infoLog: string[],
): Parameters<typeof plugin.apply>[0] {
  return {
    logger: {
      warn: (message: string) => warnLog.push(String(message)),
      info: (message: string) => infoLog.push(String(message)),
    },
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
    on: (event: string) => {
      onEvents.push(event)
      return () => {}
    },
  } as unknown as Parameters<typeof plugin.apply>[0]
}

describe('AC7：只读实例不启动消费者、不回收 lease', () => {
  it('第二实例（写者持锁）：不注册监听、过期 lease 原样保留、readonly 标注', async () => {
    const dir = await makeTempDir('omw-inbox-ro-')
    const dbPath = resolveMemoryDbPath(dir)
    const writer = await startWriterInstance(dbPath, buildReadonlyStatements(DIM))
    try {
      const registeredDefs: MemoryCommandDefinition[] = []
      const onEvents: string[] = []
      const warnLog: string[] = []
      const infoLog: string[] = []
      await plugin.apply(makeCtx(dir, registeredDefs, onEvents, warnLog, infoLog), EMBEDDING_CONFIG)

      expect(registeredDefs).toHaveLength(1)
      expect(plugin.memoryRuntimeState().readonly).toBe(true)
      // 只读：不启动消费者（不接闸门/采集的 session/event 监听）；Story 3.1 起只读实例
      // 仍注册**召回配额重置**监听（memory_recall 在只读模式也可用，turn/start 恢复配额）。
      expect(onEvents).toEqual(['session/event'])
      expect(warnLog.join('\n')).toContain(READONLY_REASON)
      expect(infoLog.join('\n')).not.toContain('记忆库就绪')

      const store = await openMemoryDatabase({ dbPath, dim: DIM, modelId: MODEL_ID, readOnly: true })
      const rows = await queryAll(
        store.connection,
        'MATCH (q:l1_inbox) RETURN q.id AS id, q.status AS status, q.lease_owner AS lease_owner ORDER BY q.id ASC',
      )
      expect(rows.map((row) => [row.id, row.status, row.lease_owner ?? null])).toEqual([
        ['ro-expired-lease', 'processing', 'dead-writer'],
        ['ro-pending', 'pending', null],
      ])
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

describe('AC4 相邻：status 读队列表缺表时照抛（不静默报 0）', () => {
  it('只读实例的库没有 l1_inbox → /memory status 返回 error 且点名缺表', async () => {
    const dir = await makeTempDir('omw-inbox-no-table-')
    const dbPath = resolveMemoryDbPath(dir)
    const writer = await startWriterInstance(dbPath, buildReadonlyStatements(DIM, false))
    try {
      const registeredDefs: MemoryCommandDefinition[] = []
      await plugin.apply(makeCtx(dir, registeredDefs, [], [], []), EMBEDDING_CONFIG)
      expect(registeredDefs).toHaveLength(1)

      const result = await registeredDefs[0]!.handler({ rawInput: ' status' })

      // 缺表 → 错误可见（绝不静默返回 failed: 0）；消息点名 l1_inbox。
      expect(result.kind).toBe('error')
      expect(result.text).toMatch(/l1_inbox/)
      expect(result.text).not.toContain('failed: 0')
    } finally {
      await writer.stop()
    }
  }, 30_000)
})

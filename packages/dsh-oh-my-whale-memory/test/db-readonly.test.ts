/**
 * 只读降级打开（Story 1.5 / AC1、AC2、AC3、AC4 / AD-12）。
 *
 * 跨进程是 AD-12 的真实场景（两个 DSH 窗口 = 两个进程），所以第二实例用
 * `fixtures/hold-db-open.mjs` 扮演第一实例：它先抢写者锁，再按 `src/db/schema.ts`
 * 的同一批 DDL 以读写建库并持锁，直到父进程关闭 stdin（或被杀，用于陈旧锁场景）。
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openMemoryDatabase } from '../src/db/database'
import { MemoryDbError } from '../src/db/errors'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { READONLY_REASON, acquireWriterLock } from '../src/db/writer-lock'
import {
  META_KEYS,
  SCHEMA_VERSION,
  createFtsIndexStatement,
  createL0RawTableStatement,
  createMemoryTableStatement,
  createMetaTableStatement,
  createVectorIndexStatement,
} from '../src/db/schema'
import * as plugin from '../src/index'
import { injectOpenSslPath } from './openssl'

const FIXTURE = fileURLToPath(new URL('./fixtures/hold-db-open.mjs', import.meta.url))
const MODEL_ID = 'bge-m3'

const tempDirs: string[] = []

beforeAll(() => {
  injectOpenSslPath()
})

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

async function freshDbPath(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `omw-ro-${label}-`))
  tempDirs.push(dir)
  const dbPath = resolveMemoryDbPath(dir)
  await ensureMemoryDbDirectory(dbPath)
  return dbPath
}

function mergeMeta(key: string, value: string): string {
  return `MERGE (m:omw_meta {key: '${key}'}) ON CREATE SET m.value = '${value}' ON MATCH SET m.value = '${value}'`
}

/** 与 `initializeDatabase` 建库时执行的那批语句一致（DDL 单一事实来源：src/db/schema.ts）。 */
function buildSchemaStatements(dim: number): string[] {
  return [
    'INSTALL vector; LOAD vector;',
    'INSTALL fts; LOAD fts;',
    createMetaTableStatement(),
    createMemoryTableStatement(dim),
    createL0RawTableStatement(),
    mergeMeta(META_KEYS.schemaVersion, SCHEMA_VERSION),
    mergeMeta(META_KEYS.embeddingDim, String(dim)),
    mergeMeta(META_KEYS.embeddingModelId, MODEL_ID),
    mergeMeta(META_KEYS.createdAt, new Date().toISOString()),
    createVectorIndexStatement(),
    createFtsIndexStatement(),
  ]
}

interface WriterInstance {
  readonly pid: number
  /** 正常退出：释放锁、删除锁文件。 */
  stop(): Promise<void>
  /** 异常退出：锁文件残留（AC3 的陈旧锁场景）。 */
  kill(): Promise<void>
}

interface FixtureOptions {
  /** 建库语句；默认与生产建库一致（`buildSchemaStatements`）。 */
  statements?: string[]
  /** 抢到锁后、建库前的等待：复现"写者持锁但库文件尚未落盘"的启动竞态。 */
  delayMs?: number
  /** 抢到锁就打印 `ready`（不等 DDL 完成），让父进程在库文件出现前拿到控制权。 */
  readyEarly?: boolean
}

async function startWriterInstance(
  dbPath: string,
  dim: number,
  options: FixtureOptions = {},
): Promise<WriterInstance> {
  const statements = options.statements ?? buildSchemaStatements(dim)
  // 与生产路径一致的顺序：先建目录（锁文件 `<dbPath>.lock` 也在里面），再抢锁、再开库。
  await ensureMemoryDbDirectory(dbPath)
  const child = spawn(process.execPath, [FIXTURE, dbPath], { stdio: 'pipe' })
  const pid = child.pid!
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
    child.stdin.write(`${JSON.stringify({ statements, delayMs: options.delayMs ?? 0, readyEarly: options.readyEarly ?? false })}\n`)
  })

  return {
    pid,
    async stop() {
      child.stdin.end()
      await exited
    },
    async kill() {
      child.kill()
      await exited
    },
  }
}

describe('只读降级打开（Story 1.5 / AC1、AC2、AC4）', () => {
  it('写者持锁时第二实例以只读打开同一库：可读库内元数据、写入口抛 readonly_mode', async () => {
    const dbPath = await freshDbPath('second-instance')
    const writer = await startWriterInstance(dbPath, 8)
    try {
      const db = await openMemoryDatabase({ dbPath, dim: 8, modelId: MODEL_ID, readOnly: true })

      expect(db.readonly).toBe(true)
      // dim 与 modelId 都由只读连接从库里读出来（不是回显配置）：证明真的读到了别人建的库。
      expect(db.dim).toBe(8)
      expect(db.modelId).toBe(MODEL_ID)

      const error = await db
        .upsertMemory({ layer: 'L1_INBOX', text: '只读实例不该写入', embedding: Array(8).fill(0) })
        .then(() => null, (caught: unknown) => caught)
      expect(error).toBeInstanceOf(MemoryDbError)
      expect(error).toMatchObject({ code: 'readonly_mode', retryable: false })
      expect((error as MemoryDbError).message).toContain(READONLY_REASON)

      await db.close()
    } finally {
      await writer.stop()
    }
  }, 20_000)

  it('只读实例不创建空库：库文件不存在 → db_open_failed，且不留下文件', async () => {
    const dbPath = await freshDbPath('missing')

    await expect(openMemoryDatabase({ dbPath, dim: 4, modelId: MODEL_ID, readOnly: true }))
      .rejects.toMatchObject({ code: 'db_open_failed' })
    await expect(access(dbPath)).rejects.toThrow()
  })

  it('只读实例同样按 AD-14 fail-loud 校验维度：库 pin 8 而配置 4 → embedding_dim_mismatch', async () => {
    const dbPath = await freshDbPath('dim-mismatch')
    const writer = await startWriterInstance(dbPath, 8)
    try {
      await expect(openMemoryDatabase({ dbPath, dim: 4, modelId: MODEL_ID, readOnly: true }))
        .rejects.toMatchObject({ code: 'embedding_dim_mismatch' })
    } finally {
      await writer.stop()
    }
  }, 20_000)

  it('第一实例异常退出留下陈旧锁：新实例自动接管并以读写打开（AC3）', async () => {
    const dbPath = await freshDbPath('stale')
    const writer = await startWriterInstance(dbPath, 8)
    await writer.kill()

    // 进程已消失但锁文件还在、且记录着已退出的 pid —— 这就是 AC3 的陈旧锁。
    await expect(readFile(`${dbPath}.lock`, 'utf8')).resolves.toBe(`${writer.pid}\n`)
    expect(() => process.kill(writer.pid, 0)).toThrow()

    // 不需要手动删锁文件：withFileLock 的接管语义直接拿到写者锁（waitMs: 0 也立即成功）。
    const lock = await acquireWriterLock(dbPath)
    try {
      expect(lock.mode).toBe('writer')
      const db = await openMemoryDatabase({ dbPath, dim: 8, modelId: MODEL_ID })
      expect(db.readonly).toBe(false)
      await db.close()
    } finally {
      await lock.release()
    }
  }, 20_000)

  it('同进程先读写打开再尝试只读打开同一路径 → db_open_failed（模式冲突 fail-loud）', async () => {
    const dbPath = await freshDbPath('mode-conflict')
    const db = await openMemoryDatabase({ dbPath, dim: 4, modelId: MODEL_ID })
    expect(db.readonly).toBe(false)

    await expect(openMemoryDatabase({ dbPath, dim: 4, modelId: MODEL_ID, readOnly: true }))
      .rejects.toMatchObject({ code: 'db_open_failed' })
  })

  it('库文件存在但未完成初始化（只有 omw_meta 表、没有 memory 表）→ 只读打开报 schema_mismatch', async () => {
    const dbPath = await freshDbPath('half-initialized')
    // 复刻"写者刚建完元数据表就异常退出"的中间态：没有 memory 表，也没有 embedding_dim 键，
    // 所以校验不会提前抛错，必须由只读路径自己判定为未完成初始化（不猜维度、不建表）。
    const writer = await startWriterInstance(dbPath, 8, { statements: [createMetaTableStatement()] })
    try {
      await expect(openMemoryDatabase({ dbPath, dim: 8, modelId: MODEL_ID, readOnly: true }))
        .rejects.toMatchObject({ code: 'schema_mismatch' })
    } finally {
      await writer.stop()
    }
  }, 20_000)

  it('只读连接在原生层同样拒绝写语句（插件层 readonly_mode 之外的第二道防线）', async () => {
    const dbPath = await freshDbPath('native-write')
    const writer = await startWriterInstance(dbPath, 8)
    try {
      const db = await openMemoryDatabase({ dbPath, dim: 8, modelId: MODEL_ID, readOnly: true })
      // 绕过 facade 的 readonly_mode 短路，直接对只读连接发一条写语句：
      // 期望 LadybugDB 原生报 "Cannot execute write operations in a read-only database!"。
      // 这条断言保护的是"只读打开真的传了 readOnly=true"，而不是只在插件层假装只读。
      await expect(db.connection.query(mergeMeta('ro_probe', '1'))).rejects.toThrow(/read-only/i)
      await db.close()
    } finally {
      await writer.stop()
    }
  }, 20_000)

  it('apply 在第二实例下降级只读并标注 readonly: true / reason（AC1、AC2）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omw-ro-apply-'))
    tempDirs.push(dir)
    const dbPath = resolveMemoryDbPath(dir)
    const writer = await startWriterInstance(dbPath, 8)
    try {
      const warn = vi.fn()
      const info = vi.fn()
      const closers: Array<() => unknown> = []
      const ctx = {
        logger: { warn, info },
        get: (key: string) => (key === 'profileContext' ? { dir } : undefined),
        effect: (factory: () => () => unknown) => closers.push(factory()),
        // Story 1.6：memory_remember 经 ctx.tools.register 注册（真实宿主里它是 effect）。
        // 替身只需可调用；closers 仍只统计 ctx.effect 注册的收尾器。
        tools: { register: () => () => {} },
      } as unknown as Parameters<typeof plugin.apply>[0]

      await plugin.apply(ctx, { embedding: { token: 'sk-test', model: MODEL_ID, dim: 8 } })

      expect(plugin.memoryRuntimeState()).toMatchObject({
        readonly: true,
        reason: READONLY_REASON,
        dbPath,
      })
      // AC2：只读标注必须完整可读，后续 story 的 /memory status 直接复用同一文案。
      expect(warn.mock.calls.at(-1)?.[0]).toContain(
        "readonly: true, reason: 'another instance owns the writer lock'",
      )
      expect(info).not.toHaveBeenCalled()
      // Story 1.5：库 facade + 写者锁两个 disposer；Story 1.7 追加无条件注册的命令 effect → 3。
      expect(closers).toHaveLength(3)
    } finally {
      await writer.stop()
    }
  }, 20_000)

  it('写者持锁但库文件尚未落盘时，第二实例有界等待后仍降级只读（启动竞态）', async () => {
    const dbPath = await freshDbPath('writer-booting')
    // readyEarly + delayMs：夹具抢到锁就返回父进程，库文件要等 700ms 之后才被 DDL 建出来。
    // 这正是"两个窗口几乎同时启动"的真实窗口：写者已持锁，但 new Database() 是惰性打开，
    // 库文件还没落盘；只读方若立刻判 db_open_failed，就失去了降级只读的机会（AC1）。
    const writer = await startWriterInstance(dbPath, 8, { delayMs: 700, readyEarly: true })
    try {
      const db = await openMemoryDatabase({ dbPath, dim: 8, modelId: MODEL_ID, readOnly: true })

      expect(db.readonly).toBe(true)
      expect(db.dim).toBe(8)
      await db.close()
    } finally {
      await writer.stop()
    }
  }, 20_000)
})

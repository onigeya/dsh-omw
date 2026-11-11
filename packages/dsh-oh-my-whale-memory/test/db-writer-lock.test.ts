/**
 * 写者锁语义（Story 1.5 / AC1、AC3 / AD-12）。
 *
 * 单进程内即可覆盖"谁该成为写者、谁该降级只读、陈旧锁能否自动接管"；真正的
 * 跨进程第二实例（含 LadybugDB 的库文件级顺序约束）由 `db-readonly.test.ts` 覆盖。
 * 本文件不需要 LadybugDB。
 */
import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { READONLY_REASON, acquireWriterLock } from '../src/db/writer-lock'
import { ensureMemoryDbDirectory, resolveMemoryDbPath } from '../src/db/paths'
import { cleanupTempDirs, makeTempDir } from './tmp'

afterAll(cleanupTempDirs)

async function freshDbPath(label: string): Promise<string> {
  const dbPath = resolveMemoryDbPath(await makeTempDir(`omw-lock-${label}-`))
  await ensureMemoryDbDirectory(dbPath)
  return dbPath
}

function lockPathOf(dbPath: string): string {
  return `${dbPath}.lock`
}

/** 制造"持有者已退出"的陈旧锁：spawn 一个立即退出的子进程，把它的 pid 写进锁文件。 */
async function writeStaleLock(dbPath: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await writeFile(lockPathOf(dbPath), `${pid}\n`)
  return pid
}

describe('写者锁（Story 1.5 / AC1、AC3 / AD-12）', () => {
  it('首个申请者取得写者锁，锁文件记录本进程 pid', async () => {
    const dbPath = await freshDbPath('first')
    const lock = await acquireWriterLock(dbPath)

    expect(lock.mode).toBe('writer')
    expect(lock.reason).toBeUndefined()
    await expect(readFile(lockPathOf(dbPath), 'utf8')).resolves.toBe(`${process.pid}\n`)

    await lock.release()
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  })

  it('同进程重复申请复用同一把锁（引用计数），归零才移除并允许重新取得', async () => {
    const dbPath = await freshDbPath('refcount')
    const first = await acquireWriterLock(dbPath)
    const second = await acquireWriterLock(dbPath)
    expect(first.mode).toBe('writer')
    expect(second.mode).toBe('writer')

    // 释放一个引用后锁必须仍在：否则第二个调用方会丢掉写者身份
    // （`withFileLock` 对 `pid === process.pid` 永不接管，第二次申请必然失败）。
    await first.release()
    await expect(access(lockPathOf(dbPath))).resolves.toBeUndefined()

    await second.release()
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()

    const again = await acquireWriterLock(dbPath)
    expect(again.mode).toBe('writer')
    await again.release()
  })

  it('持有者进程存活时降级只读，且不夺取既有锁文件（AC1：不抛错阻断宿主）', async () => {
    const dbPath = await freshDbPath('live-holder')
    // 本进程自己的 pid 同样是"存活持有者"：atomic-write 的 holderExited 对
    // `pid === process.pid` 恒返回 false（永不接管自己的锁）。
    await writeFile(lockPathOf(dbPath), `${process.pid}\n`)

    const lock = await acquireWriterLock(dbPath)

    expect(lock.mode).toBe('readonly')
    expect(lock.reason).toBe(READONLY_REASON)
    await expect(lock.release()).resolves.toBeUndefined()
    await expect(readFile(lockPathOf(dbPath), 'utf8')).resolves.toBe(`${process.pid}\n`)
  })

  it('锁记录损坏（不能证明持有者已退出）时降级只读，不夺取', async () => {
    const dbPath = await freshDbPath('malformed')
    await writeFile(lockPathOf(dbPath), 'not-a-pid\n')

    const lock = await acquireWriterLock(dbPath)

    expect(lock.mode).toBe('readonly')
    expect(lock.reason).toBe(READONLY_REASON)
    await expect(readFile(lockPathOf(dbPath), 'utf8')).resolves.toBe('not-a-pid\n')
  })

  it('持有者异常退出留下陈旧锁 → 立即自动接管（AC3），无需手动删锁文件', async () => {
    const dbPath = await freshDbPath('stale')
    const stalePid = await writeStaleLock(dbPath)
    expect(() => process.kill(stalePid, 0)).toThrow()

    const lock = await acquireWriterLock(dbPath)

    // waitMs: 0 也照样接管——atomic-write 的接管分支 `continue` 在 deadline 判断之前。
    expect(lock.mode).toBe('writer')
    await expect(readFile(lockPathOf(dbPath), 'utf8')).resolves.toBe(`${process.pid}\n`)
    await lock.release()
  })

  it('锁目录不可用等 I/O 故障原样抛出，不伪装成"另一个实例"（fail-loud）', async () => {
    const missing = join(tmpdir(), `omw-lock-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await expect(acquireWriterLock(join(missing, 'lbug.db'))).rejects.toThrow(/ENOENT/)
  })

  it('并发申请同一路径共用同一次获取：两个调用方都拿到写者身份', async () => {
    const dbPath = await freshDbPath('concurrent')

    // 同一 tick 内两次申请：第二次若不复用 `acquisitions` 里在途的那次 withFileLock，
    // 就会看到自己写下的锁文件而被判成"第二实例"降级只读。
    const [first, second] = await Promise.all([acquireWriterLock(dbPath), acquireWriterLock(dbPath)])
    expect(first.mode).toBe('writer')
    expect(second.mode).toBe('writer')

    await first.release()
    await expect(access(lockPathOf(dbPath))).resolves.toBeUndefined()
    await second.release()
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  })

  it('争用超时的错误文案是上游契约（isLockTimeout 依赖它，升级时先在这里失败）', async () => {
    const dbPath = await freshDbPath('timeout-contract')
    await writeFile(lockPathOf(dbPath), `${process.pid}\n`)

    // writer-lock.ts 靠 `/timed out waiting for the writer lock/` 区分"争用"与"I/O 故障"。
    // 上游若改写文案，本断言先失败——而不是让第二实例把争用误报成硬错误、拒绝启动
    // （AD-12 明确禁止的降级失败）。升级 @deepseek-ai/dsh-atomic-write 后必须跑这条。
    await expect(withFileLock(dbPath, async () => {}, { waitMs: 0 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
  })

  it('release 未收尾时立即重新申请：仍拿到写者身份（dispose→apply 抖动）', async () => {
    const dbPath = await freshDbPath('release-race')
    const first = await acquireWriterLock(dbPath)

    // 故意不 await：模拟宿主 dispose 后立刻 apply（锁文件还在被 rm 的窗口内）。
    // 没有 releasing 屏障的话，withFileLock 会看到尚未删除的锁文件 + 本进程 pid
    // （holderExited 拒绝接管），waitMs:0 立即超时→降级只读，AC1 被无声破坏。
    const release = first.release()
    const again = await acquireWriterLock(dbPath)

    expect(again.mode).toBe('writer')
    await release
    await again.release()
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  })

  it('同一库文件的不同书写形式视为同一路径：不误判为第二实例', async () => {
    const dbPath = await freshDbPath('normalized')
    const first = await acquireWriterLock(dbPath)

    // `/./` 段 + 混合分隔符在 OS 层是同一个文件，但字符串不同。没有 resolve() 的话，
    // 第二次申请会把本进程写下的锁文件当成"别人的锁"而降级只读。
    const respelled = `${dirname(dbPath)}/./${basename(dbPath)}`
    const second = await acquireWriterLock(respelled)

    expect(second.mode).toBe('writer')

    await first.release()
    await second.release()
    await expect(access(lockPathOf(dbPath))).rejects.toThrow()
  })
})

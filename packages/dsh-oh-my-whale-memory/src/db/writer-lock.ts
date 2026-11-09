/**
 * 跨进程写者锁（Story 1.5 / AC1、AC3 / AD-12）。
 *
 * 复用宿主 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`：它自带 `<path>.lock`
 * （`wx` 独占创建 + 记录持有者 PID）与**陈旧锁接管**语义（记录里的 PID 已不存在时
 * 移除锁重试），是 AD-12 指定的锁来源，插件不自研文件锁。
 *
 * 与宿主用法的两点差异：
 * 1. 宿主是"锁内跑一段短操作"，本插件要**跨整个插件生命周期**持有——operation 是一个
 *    直到 release 才 resolve 的 promise；
 * 2. `waitMs: 0`：第二实例必须立刻降级只读，不空等默认的 2 秒。`withFileLock` 的
 *    接管分支 `continue` 在 deadline 判断之前，所以"立即失败"并不牺牲 AC3：
 *    陈旧锁仍会被立刻接管。
 *
 * 进程内引用计数：`withFileLock` 的锁是跨进程的，**同进程**再次申请会看到自己写下的
 * 锁文件（其 `holderExited` 明确拒绝 `pid === process.pid`）而误判为争用并降级只读。
 * 宿主 dispose→apply 抖动、同进程重复 apply 都会走到这里，故按路径计引用复用同一把锁。
 */
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** 只读降级的固定原因文案（AC2 要求原样展示，后续 story 直接复用本常量）。 */
export const READONLY_REASON = 'another instance owns the writer lock'

export interface MemoryWriterLock {
  readonly mode: 'writer' | 'readonly'
  /** 只读降级原因（仅 mode === 'readonly' 时存在）。 */
  readonly reason?: string
  /** 释放本调用方持有的引用；引用归零才真正移除锁文件。只读模式为 no-op。 */
  release(): Promise<void>
}

interface HeldLock {
  /** 本进程内经 acquireWriterLock 拿到的引用数。 */
  refCount: number
  /** resolve 后 `withFileLock` 的 operation 结束，锁文件随即被移除。 */
  open(): void
  /** `withFileLock` 的完整 promise：锁文件移除后 resolve。 */
  settled: Promise<void>
}

const held = new Map<string, HeldLock>()
/** 同路径正在申请中的锁：并发申请共用同一次 withFileLock（否则同进程第二次必然失败）。 */
const acquisitions = new Map<string, Promise<HeldLock | null>>()

/**
 * 申请 `dbPath` 的写者锁。
 *
 * 拿不到（另一个存活实例持有）不抛错——按 AD-12 返回只读降级结果，让宿主继续启动。
 * 其余失败（例如锁文件所在目录不可写）原样抛出：那是 I/O 故障，不能伪装成"第二实例"。
 */
export async function acquireWriterLock(dbPath: string): Promise<MemoryWriterLock> {
  const existing = held.get(dbPath)
  if (existing) {
    existing.refCount += 1
    return writerLease(dbPath, existing)
  }

  let inFlight = acquisitions.get(dbPath)
  if (inFlight === undefined) {
    inFlight = startAcquisition(dbPath).finally(() => {
      acquisitions.delete(dbPath)
    })
    acquisitions.set(dbPath, inFlight)
  }

  const entry = await inFlight
  if (entry === null) return readonlyLease()

  const current = held.get(dbPath) ?? entry
  current.refCount += 1
  held.set(dbPath, current)
  return writerLease(dbPath, current)
}

async function startAcquisition(dbPath: string): Promise<HeldLock | null> {
  let openLock!: () => void
  const gate = new Promise<void>((resolve) => {
    openLock = resolve
  })
  let markAcquired!: () => void
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve
  })

  // waitMs: 0 —— 立即试一次；陈旧锁仍会被立刻接管，活锁立刻以 timeout 报错。
  const settled = withFileLock(
    dbPath,
    async () => {
      markAcquired()
      await gate
    },
    { waitMs: 0 },
  )

  // `settled` 只在 operation 返回后才 resolve，而 operation 只在 release() 里返回，
  // release() 又必须先拿到本函数返回的 entry——所以此处 `settled` 只可能以 rejection 结束。
  const failure = await Promise.race([
    acquired.then(() => undefined),
    settled.catch((error: unknown) => error),
  ])
  if (failure === undefined) return { refCount: 0, open: openLock, settled }
  if (isLockTimeout(failure)) return null
  throw failure
}

/** `withFileLock` 争用超时的专用错误（见 atomic-write 源码的消息文本）。 */
function isLockTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out waiting for the writer lock/.test(error.message)
}

function writerLease(dbPath: string, entry: HeldLock): MemoryWriterLock {
  let released = false
  return {
    mode: 'writer',
    async release() {
      if (released) return
      released = true
      entry.refCount -= 1
      if (entry.refCount > 0) return
      held.delete(dbPath)
      entry.open()
      // `settled` 是 withFileLock 的完整 promise：正常在锁文件移除后 resolve，但它的
      // finally 里 `rm` 也可能失败（Windows 上文件被杀软/索引器短暂占用）。disposer
      // 不该把这种尾部失败抛给宿主的 dispose 流程，故只吞掉 `settled` 自身的 rejection
      // ——真正的争用/获取失败在 startAcquisition 里已经区分并抛出了。
      await entry.settled.catch(() => {})
    },
  }
}

function readonlyLease(): MemoryWriterLock {
  return { mode: 'readonly', reason: READONLY_REASON, async release() {} }
}

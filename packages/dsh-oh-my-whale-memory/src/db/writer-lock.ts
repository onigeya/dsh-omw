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
import { resolve } from 'node:path'
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
 * 正在收尾的释放（锁文件 `rm` 尚未完成）：`held` 删除与锁文件真正消失之间有一个窗口，
 * 期间新申请会看到本进程自己写下的锁文件而被误判成"第二实例"。新申请必须先等它结束。
 */
const releasing = new Map<string, Promise<void>>()

/**
 * 申请 `dbPath` 的写者锁。
 *
 * 拿不到（另一个存活实例持有）不抛错——按 AD-12 返回只读降级结果，让宿主继续启动。
 * 其余失败（例如锁文件所在目录不可写）原样抛出：那是 I/O 故障，不能伪装成"第二实例"。
 */
export async function acquireWriterLock(dbPath: string): Promise<MemoryWriterLock> {
  // 同一库文件可能以不同书写形式（`/` 与 `\`、`.` 段、冗余分隔符）传进来，而 OS 视其为
  // 同一个文件。按规范化后的绝对路径记账，否则第二次申请会把本进程写下的锁文件当成
  // "另一个实例的锁"而降级只读。
  const key = resolve(dbPath)

  // 上一次 release 可能还没收尾（`held` 已删、锁文件尚未 rm）：先等它结束，否则新申请
  // 会在这个窗口里看到自己进程写下的锁文件，被误判成"第二实例"降级只读。
  const pendingRemoval = releasing.get(key)
  if (pendingRemoval) await pendingRemoval

  const existing = held.get(key)
  if (existing) {
    existing.refCount += 1
    return writerLease(key, existing)
  }

  let inFlight = acquisitions.get(key)
  if (inFlight === undefined) {
    inFlight = startAcquisition(key).finally(() => {
      acquisitions.delete(key)
    })
    acquisitions.set(key, inFlight)
  }

  const entry = await inFlight
  if (entry === null) return readonlyLease()

  const current = held.get(key) ?? entry
  current.refCount += 1
  held.set(key, current)
  return writerLease(key, current)
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
      // 同时把这次收尾登记进 `releasing`：锁文件真正消失之前，新申请必须先等它
      // 结束，否则会把尚未删除的锁文件当成"另一个实例的锁"（见 acquireWriterLock）。
      const removal = entry.settled.catch(() => {})
      releasing.set(dbPath, removal)
      try {
        await removal
      } finally {
        if (releasing.get(dbPath) === removal) releasing.delete(dbPath)
      }
    },
  }
}

function readonlyLease(): MemoryWriterLock {
  return { mode: 'readonly', reason: READONLY_REASON, async release() {} }
}

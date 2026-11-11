/**
 * 显式事务原语（Story 1.10 / AD-10）。
 *
 * LadybugDB 的 Connection 没有 begin/commit/rollback API，事务只能靠语句级
 * BEGIN TRANSACTION / COMMIT / ROLLBACK（2026-11-11 实测可用）。三条实测语义
 * 决定了本文件的形态：
 *
 * 1. 事务内任一语句出错时，引擎**自动中止并回滚**整个事务；此后再 ROLLBACK 会抛
 *    「No active transaction for ROLLBACK.」。故这里静默容忍回滚失败、只把原始错误
 *    上抛——不能因为「回滚也失败了」把真正的病根换成一句无关的报错。
 * 2. 同一连接上不能嵌套事务：第二次 BEGIN TRANSACTION 抛
 *    「Connection already has an active transaction…」。故同一连接上的并发写入在本层用
 *    per-connection promise 链串行化（src/ 没有别的写串行化设施）。
 * 3. DDL 同样在事务内、异常时一并回滚——一次迁移建两张表因此是 all-or-nothing。
 */
import type * as lbug from '@ladybugdb/core'

/** 每个连接一条串行链，保证同一时刻至多一个显式事务。 */
const writeChains = new WeakMap<object, Promise<unknown>>()

/**
 * 在显式事务内执行 work：成功即 COMMIT 并返回其结果；work（或 COMMIT）抛错时回滚
 * 并**重新抛出原错误**。
 *
 * 同一 connection 上的多次调用按调用顺序串行执行，调用方不必自己加锁。
 *
 * **不得重入**：在本事务的 work 里再次调用 runInTransaction（或任何自开事务的原语，如
 * upsertMemory）会让内层排在外层尚未结算的 promise 之后——外层 await 内层，内层的
 * BEGIN TRANSACTION 永远等不到，调用静默挂起。同一事务内的复合写入请直接用
 * writeMemoryVersion 这类「由调用方开事务」的原语。
 */
export async function runInTransaction<T>(
  connection: lbug.Connection,
  work: () => Promise<T>,
): Promise<T> {
  const previous = writeChains.get(connection) ?? Promise.resolve()
  const run = previous.then(async () => {
    await connection.query('BEGIN TRANSACTION')
    try {
      const result = await work()
      await connection.query('COMMIT')
      return result
    } catch (error) {
      try {
        await connection.query('ROLLBACK')
      } catch {
        // 见文件头第 1 条：语句出错时引擎已自动回滚，这里的 ROLLBACK 必然报
        // 「无活动事务」。原始错误才是要上抛的那个。
      }
      throw error
    }
  })
  // 链上只留**已结算**的 promise：一次写入失败不能卡死后续写入，也不能让下一个
  // BEGIN 撞上尚未结束的事务。
  writeChains.set(connection, run.then(() => undefined, () => undefined))
  return run
}

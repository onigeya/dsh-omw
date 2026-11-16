// Story 7.3 第 2 轮补丁 2：access 的 getStrategyStats + status 装配 + index 接线。
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const K = (s) => s.replaceAll('\n', eol)
  for (const [from, to] of pairs) {
    if (!text.includes(K(from))) {
      console.error('MISS in ' + file + ':\n' + from.slice(0, 200))
      process.exit(1)
    }
    text = text.replace(K(from), K(to))
  }
  writeFileSync(file, text, 'utf8')
  console.log('patched ' + file)
}

patch('src/wire/access.ts', [
  // imports
  [
    `import { slowQueueStats } from '../strategy/slow-queue.js'`,
    `import { slowQueueStats } from '../strategy/slow-queue.js'
import { expireStrategyCandidates, strategyStats } from '../strategy/candidates.js'`,
  ],
  // 依赖类型
  [
    `  /** Story 7.1：裁决待裁决冲突（写路径，只读实例先拒）。 */
  readonly resolvePendingDecision: MemoryCommandDependencies['resolvePendingDecision']`,
    `  /** Story 7.1：裁决待裁决冲突（写路径，只读实例先拒）。 */
  readonly resolvePendingDecision: MemoryCommandDependencies['resolvePendingDecision']
  /** Story 7.3：策略候选区与采纳门计数（只读可查；过期扫描是写动作，只在非只读实例执行）。 */
  readonly getStrategyStats: MemoryCommandDependencies['getStrategyStats']`,
  ],
  // 实现（放在 resolvePendingDecision 之后）
  [
    `  return {
    readConnection,`,
    `  /**
   * Story 7.3：候选区计数。先做一次过期扫描（只读实例跳过，因为它会写库），再统计；
   * 表缺失（旧库未迁移）时返回全 0 而不是抛错 —— status/命令面不该因缺表整体失败。
   */
  const getStrategyStats: MemoryAccess['getStrategyStats'] = async () => {
    const database = options.getDb()
    if (!database) throw new Error(DB_NOT_READY_WRITE)
    if (!database.readonly) {
      await expireStrategyCandidates(database.connection, new Date().toISOString()).catch(() => 0)
    }
    const stats = await strategyStats(database.connection).catch(() => null)
    const gate = options.resolved.strategyGate
    return {
      candidates: stats?.candidates ?? 0,
      pending: stats?.pending ?? 0,
      adopted: stats?.adopted ?? 0,
      rejected: stats?.rejected ?? 0,
      expired: stats?.expired ?? 0,
      noEvidence: stats?.noEvidence ?? 0,
      minConfidence: gate.minConfidence,
      expiryDays: gate.expiryDays,
      maxPendingPerSession: gate.maxPendingPerSession,
    }
  }

  return {
    readConnection,`,
  ],
  // status 装配
  [
    `      reflection: options.reflectionView?.() ?? null,`,
    `      reflection: options.reflectionView?.() ?? null,
      // Story 7.3：策略采纳门（AC:1494/1498）；缺表时全 0，不阻塞 status。
      strategyGate: await getStrategyStats().catch(() => null),`,
  ],
  // 返回对象
  [
    `return { readConnection, writeInbox, listMemories, getMemoryById, getStatus, forgetMemory, resolvePendingDecision }`,
    `return {
    readConnection,
    writeInbox,
    listMemories,
    getMemoryById,
    getStatus,
    forgetMemory,
    resolvePendingDecision,
    getStrategyStats,
  }`,
  ],
])

patch('src/index.ts', [
  [
    `    resolvePendingDecision: access.resolvePendingDecision,`,
    `    resolvePendingDecision: access.resolvePendingDecision,
    // Story 7.3：策略候选区与采纳门计数（只读可查）。
    getStrategyStats: access.getStrategyStats,`,
  ],
])

/**
 * Story 9.3 / T7：`situated_recall:` 行的真实装配接线测试。
 *
 * 命令层渲染（`renderMemoryStatus` 的格式）已由 command-status.test.ts 覆盖；这里守的是
 * **接线根因**：`createMemoryAccess().getStatus()` 是否把 `retrieval.situatedRecallView()` 的
 * 进程内指标真的放进 `MemoryStatusSnapshot`。
 *
 * - 提供 `situatedRecallView` 且 `resolved.situatedRecallEnabled=true` ⇒ 快照带 `situatedRecall`，
 *   `/memory status` 出现该行；
 * - 开关关闭（默认）⇒ 即使提供了提供者，快照也不带该字段（v1 逐行输出逐字不变）。
 *
 * 用假库（空库）走 `getStatus` 的只读分支，不触发任何网络/写。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { resolveRuntimeConfig } from '../src/config'
import { openMemoryDatabase } from '../src/db/database'
import { resolveMemoryDbPath } from '../src/db/paths'
import { createInjectionStore } from '../src/injection/state'
import { createMemoryAccess } from '../src/wire/access'
import { renderMemoryStatus, type MemorySituatedRecallView } from '../src/command'
import { cleanupTempDirs, makeTempDir } from './tmp'

const DIM = 4
const MODEL = 'test-embed'

function resolvedWith(situatedRecallEnabled: boolean, systemOneRerankEnabled = false) {
  return resolveRuntimeConfig({
    embedding: { endpoint: 'http://127.0.0.1:1/v1', token: 'sk-test', model: MODEL, dim: DIM },
    situatedRecallEnabled,
    systemOneRerankEnabled,
  })
}

/** 一段假指标视图（enabled=true、有样本）。 */
function view(): MemorySituatedRecallView {
  return {
    enabled: true,
    degraded: true,
    reason: 'rerank:http-500',
    mode: 'rrf',
    p50Ms: 900,
    p95Ms: 2800,
    degradeRate: 0.4,
    slowRate: 0.2,
    samples: 40,
  }
}

async function buildAccess(resolved: ReturnType<typeof resolvedWith>) {
  const store = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-situated-wiring-')),
    dim: DIM,
    modelId: MODEL,
  })
  const access = createMemoryAccess({
    getDb: () => store,
    resolved,
    readonlyState: () => ({ readonly: false }),
    getSystemOneClient: () => null,
    injectionStore: createInjectionStore(),
    situatedRecallView: () => view(),
  })
  return { access, store }
}

afterAll(cleanupTempDirs)

describe('situated_recall: 行的接线（access → snapshot → render）', () => {
  it('开态 + 提供者：快照带 situatedRecall，/memory status 出现该行', async () => {
    const { access, store } = await buildAccess(resolvedWith(true))
    const snapshot = await access.getStatus()
    expect(snapshot.situatedRecall).toMatchObject({ enabled: true, mode: 'rrf', degraded: true, reason: 'rerank:http-500' })
    const text = renderMemoryStatus(snapshot)
    expect(text).toContain('situated_recall: enabled mode=rrf p50=900ms p95=2800ms degraded=40% slow=20% samples=40')
    expect(text).toContain('situated_recall: 最近一次降级（rerank:http-500）')
    await store.close()
  }, 60_000)

  it('关态（默认）：快照不带 situatedRecall（undefined），/memory status 无该行，逐字不变', async () => {
    const { access, store } = await buildAccess(resolvedWith(false))
    const snapshot = await access.getStatus()
    expect(snapshot.situatedRecall).toBeUndefined()
    expect(renderMemoryStatus(snapshot)).not.toContain('situated_recall:')
    await store.close()
  }, 60_000)

  it('不提供视图提供者：快照同样不带（既有装配不变），不渲染行', async () => {
    const store = await openMemoryDatabase({
      dbPath: resolveMemoryDbPath(await makeTempDir('omw-situated-wiring-noview-')),
      dim: DIM,
      modelId: MODEL,
    })
    const access = createMemoryAccess({
      getDb: () => store,
      resolved: resolvedWith(true),
      readonlyState: () => ({ readonly: false }),
      getSystemOneClient: () => null,
      injectionStore: createInjectionStore(),
    })
    const snapshot = await access.getStatus()
    expect(snapshot.situatedRecall).toBeUndefined()
    expect(renderMemoryStatus(snapshot)).not.toContain('situated_recall:')
    await store.close()
  }, 60_000)
})
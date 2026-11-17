/**
 * Self-Knowledge 候选区 / 晋升门 / 隔离（Story 11.3 / T2–T4、T7；矩阵 1–10）。
 *
 * 分层：
 * 1. 状态机（矩阵 1–6）：候选落库、独立信号晋升、仅自评拒绝、无信号 record-only、
 *    空正文/空来源拒绝、同观察幂等；
 * 2. 隔离与跨会话回归（矩阵 7–10）：candidate/rejected 永不进 recall/注入；accepted 只进
 *    常驻层且与 User Portrait / Persona Spec 分域；四类输入（用户事实误归属 / 错误反思 /
 *    与 Spec 冲突 / 无信号）不串域、不提前注入、不改写 Spec。
 *
 * 开库预算：2 个库（状态机一组、隔离一组）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMemoryDatabase, type MemoryDatabase } from '../src/db/database'
import { queryAll, upsertMemory } from '../src/db/memory'
import { resolveMemoryDbPath } from '../src/db/paths'
import { queryRows } from '../src/db/rows'
import {
  SELF_KNOWLEDGE_HEADER,
  SKELETON_HEADER,
  createSkeletonRefresher,
  createSkeletonStore,
  readSkeletonFacts,
  renderSkeleton,
} from '../src/injection/skeleton'
import {
  KNOWLEDGE_SIGNALS,
  SELF_KNOWLEDGE_STATES,
  SELF_KNOWLEDGE_SURFACES,
  canRewritePersonaSpec,
  isVisible,
} from '../src/persona/contract'
import { PERSONA_SPEC_TEXT, PERSONA_SPEC_VERSION } from '../src/persona/spec'
import {
  SELF_KNOWLEDGE_LIST_LIMIT,
  countsByState,
  decidePersistence,
  listAccepted,
  readSelfKnowledge,
  recordCandidate,
  selfKnowledgeId,
} from '../src/persona/self-knowledge'
import { runRecallCore } from '../src/recall/core'
import { cleanupTempDirs, makeTempDir } from './tmp'

const NOW = new Date('2026-11-18T00:00:00.000Z')
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

let stateStore: MemoryDatabase
let isolationStore: MemoryDatabase

beforeAll(async () => {
  stateStore = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-selfknow-state-')),
    dim: 4,
    modelId: 'test-embed',
  })
  isolationStore = await openMemoryDatabase({
    dbPath: resolveMemoryDbPath(await makeTempDir('omw-selfknow-isolation-')),
    dim: 4,
    modelId: 'test-embed',
  })
})

afterAll(async () => {
  try { await stateStore?.close() } catch { /* ignore */ }
  try { await isolationStore?.close() } catch { /* ignore */ }
  await cleanupTempDirs()
})

/** 直接查一条候选的列值（绕过模块，证明落库形态）。 */
async function rawRow(
  connection: MemoryDatabase['connection'],
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await queryRows(
    connection,
    'MATCH (k:agent_self_knowledge {id: $id}) RETURN k.id AS id, k.state AS state, k.text AS text, ' +
    'k.source_refs AS source_refs, k.signal AS signal, k.decision_reason AS decision_reason, ' +
    'k.created_at AS created_at, k.decided_at AS decided_at',
    { id },
  )
  return rows[0]
}

describe('矩阵 1：反思观察落候选（append-only + L0 溯源）', () => {
  it('state=candidate、source_refs 指向 L0（去掉 l0: 前缀）、created_at UTC、decided_at 空', async () => {
    const { id } = await recordCandidate(stateStore.connection, {
      text: '  我倾向于先跑门禁再提交  ',
      sourceRefs: ['l0:l0-aaa', ' l0:l0-bbb ', 'l0-aaa'],
      now: NOW,
    })
    expect(id).toBe(selfKnowledgeId('我倾向于先跑门禁再提交'))
    const row = await rawRow(stateStore.connection, id)
    expect(row).toMatchObject({
      state: 'candidate',
      text: '我倾向于先跑门禁再提交',
      created_at: NOW.toISOString(),
      signal: null,
      decision_reason: null,
      decided_at: null,
    })
    // 归一化：去 `l0:` 前缀、去空白、去重（与 memory.source_refs 同形态）。
    expect((row?.source_refs as unknown[]).map(String)).toEqual(['l0-aaa', 'l0-bbb'])
    expect(String(row?.created_at)).toMatch(UTC_ISO)
  })
})

describe('矩阵 5：空正文 / 空 sourceRefs 拒绝写入（不造无源候选）', () => {
  it('空正文（含纯空白）⇒ self_knowledge_invalid，不落行', async () => {
    for (const text of ['', '   ', '\n\t']) {
      await expect(recordCandidate(stateStore.connection, { text, sourceRefs: ['l0-x'] }))
        .rejects.toMatchObject({ code: 'self_knowledge_invalid' })
    }
    const rows = await queryAll(stateStore.connection, 'MATCH (k:agent_self_knowledge) RETURN count(k) AS c')
    // 只允许上面矩阵 1 的那一条。
    expect(Number(rows[0]?.c)).toBe(1)
  })

  it('空 sourceRefs（含只有空串/空前缀的数组）⇒ self_knowledge_invalid', async () => {
    for (const sourceRefs of [[], [''], ['   '], ['l0:']]) {
      await expect(recordCandidate(stateStore.connection, { text: '无来源观察', sourceRefs }))
        .rejects.toMatchObject({ code: 'self_knowledge_invalid' })
    }
  })
})

describe('矩阵 6：重复同一观察幂等（同 id 不新增、不改写历史正文）', () => {
  it('同正文两次落库 ⇒ 同一 id、只有一行、正文与创建时刻保留首次值', async () => {
    const first = await recordCandidate(stateStore.connection, {
      text: '幂等观察：同一句话',
      sourceRefs: ['l0-first'],
      now: new Date('2026-11-18T01:00:00.000Z'),
    })
    const second = await recordCandidate(stateStore.connection, {
      text: '幂等观察：同一句话',
      sourceRefs: ['l0-second'],
      now: new Date('2026-11-18T02:00:00.000Z'),
    })
    expect(second.id).toBe(first.id)
    const rows = await queryRows(
      stateStore.connection,
      'MATCH (k:agent_self_knowledge {id: $id}) RETURN count(k) AS c',
      { id: first.id },
    )
    expect(Number(rows[0]?.c)).toBe(1)
    const row = await rawRow(stateStore.connection, first.id)
    // append-only：重放不改写既有行（来源与创建时刻仍是首次值）。
    expect((row?.source_refs as unknown[]).map(String)).toEqual(['l0-first'])
    expect(String(row?.created_at)).toBe('2026-11-18T01:00:00.000Z')
  })
})

describe('矩阵 2 / 3 / 4：独立晋升门（accepted / rejected / record-only）', () => {
  it('独立信号（outcome）⇒ accepted + decided_at + 原因，常驻层可见（矩阵 2）', async () => {
    const { id } = await recordCandidate(stateStore.connection, {
      text: '有外部结果支撑的观察',
      sourceRefs: ['l0-outcome'],
    })
    const decision = await decidePersistence(stateStore.connection, {
      id,
      signal: 'outcome',
      selfScoreOnly: false,
      reason: 'generation_log.outcome=success',
      now: NOW,
    })
    expect(decision.state).toBe('accepted')
    expect(decision.decision).toBe('accepted')
    expect(decision.decidedAt).toBe(NOW.toISOString())
    const row = await rawRow(stateStore.connection, id)
    expect(row?.state).toBe('accepted')
    expect(String(row?.signal)).toBe('outcome')
    expect(String(row?.decision_reason)).toContain('independent-signal:outcome')
    expect(String(row?.decision_reason)).toContain('generation_log.outcome=success')
    expect(String(row?.decided_at)).toBe(NOW.toISOString())
    // 常驻层收集面（AD-39）只返回 accepted。
    const accepted = await listAccepted(stateStore.connection)
    expect(accepted.map((item) => item.id)).toContain(id)
  })

  it('仅自我评分（即使报了信号名）⇒ rejected，不得 accepted（矩阵 3）', async () => {
    const { id } = await recordCandidate(stateStore.connection, {
      text: '只有反思自评的观察',
      sourceRefs: ['l0-self-score'],
    })
    const decision = await decidePersistence(stateStore.connection, {
      id,
      signal: 'tool-result',
      selfScoreOnly: true,
      now: NOW,
    })
    expect(decision.state).toBe('rejected')
    expect(decision.reasons.join(' ')).toContain('self-score-only')
    const row = await rawRow(stateStore.connection, id)
    expect(row?.state).toBe('rejected')
    expect(String(row?.decided_at)).toBe(NOW.toISOString())
    const accepted = await listAccepted(stateStore.connection)
    expect(accepted.map((item) => item.id)).not.toContain(id)
  })

  it('无独立信号 ⇒ record-only：保持 candidate、原因可见、decided_at 仍空（矩阵 4）', async () => {
    const before = await countsByState(stateStore.connection)
    const { id } = await recordCandidate(stateStore.connection, {
      text: '无验证信号的观察',
      sourceRefs: ['l0-no-signal'],
    })
    const decision = await decidePersistence(stateStore.connection, {
      id,
      signal: null,
      selfScoreOnly: false,
      now: NOW,
    })
    expect(decision.state).toBe('candidate')
    expect(decision.decision).toBe('record-only')
    expect(decision.decidedAt).toBeNull()
    const row = await rawRow(stateStore.connection, id)
    expect(row?.state).toBe('candidate')
    expect(String(row?.decision_reason)).toContain('no-independent-signal')
    expect(row?.decided_at).toBeNull()
    // record-only 的可观测判据：candidate 计数 +1，其中 record-only 也 +1。
    const after = await countsByState(stateStore.connection)
    expect(after.candidate - before.candidate).toBe(1)
    expect(after.recordOnly - before.recordOnly).toBe(1)
    expect(after.accepted).toBe(before.accepted)
    expect(after.rejected).toBe(before.rejected)
  })

  it('accepted / rejected 是终态：二次判定抛 self_knowledge_decided，正文不改写', async () => {
    const accepted = await recordCandidate(stateStore.connection, {
      text: '终态守卫：已接受',
      sourceRefs: ['l0-terminal-a'],
    })
    await decidePersistence(stateStore.connection, {
      id: accepted.id,
      signal: 'user-feedback',
      selfScoreOnly: false,
      now: NOW,
    })
    await expect(decidePersistence(stateStore.connection, {
      id: accepted.id,
      signal: 'user-feedback',
      selfScoreOnly: false,
    })).rejects.toMatchObject({ code: 'self_knowledge_decided' })

    const rejected = await recordCandidate(stateStore.connection, {
      text: '终态守卫：已拒绝',
      sourceRefs: ['l0-terminal-r'],
    })
    await decidePersistence(stateStore.connection, {
      id: rejected.id,
      signal: 'tool-result',
      selfScoreOnly: true,
    })
    await expect(decidePersistence(stateStore.connection, {
      id: rejected.id,
      signal: 'outcome',
      selfScoreOnly: false,
    })).rejects.toMatchObject({ code: 'self_knowledge_decided' })
    expect(String((await rawRow(stateStore.connection, accepted.id))?.text)).toBe('终态守卫：已接受')
  })

  it('未知 id ⇒ self_knowledge_not_found（不静默造行）', async () => {
    await expect(decidePersistence(stateStore.connection, {
      id: 'no-such-self-knowledge',
      signal: 'outcome',
      selfScoreOnly: false,
    })).rejects.toMatchObject({ code: 'self_knowledge_not_found' })
    expect(await readSelfKnowledge(stateStore.connection, 'no-such-self-knowledge')).toBeNull()
  })
})

describe('契约面：可见性矩阵 / 信号清单 / Spec 只读（11.1 的唯一判据）', () => {
  it('candidate / rejected 四类面全不可见；accepted 只对 injection / query 可见', () => {
    for (const state of SELF_KNOWLEDGE_STATES) {
      for (const surface of SELF_KNOWLEDGE_SURFACES) {
        const visible = isVisible(state, surface)
        if (state === 'accepted') {
          expect(visible).toBe(surface === 'injection' || surface === 'query')
        } else {
          expect(visible).toBe(false)
        }
      }
    }
    // 未列明输入 fail-closed。
    expect(isVisible('bogus' as never, 'injection')).toBe(false)
  })

  it('独立信号清单不含自评；Persona Spec 无任何运行时写路径', () => {
    expect([...KNOWLEDGE_SIGNALS]).toEqual(['outcome', 'tool-result', 'user-feedback'])
    for (const source of ['runtime', 'reflection', 'user-memory', 'tool-call'] as const) {
      expect(canRewritePersonaSpec(source)).toBe(false)
    }
  })
})

describe('矩阵 7–10 / T7：隔离与跨会话回归（4 类输入）', () => {
  /** 隔离组：User Portrait 行 + 一条普通事实（骨架只取 priority=-1 / instruction）。 */
  const PORTRAIT_TEXT = '用户喜欢浅色主题（画像）'
  const FACT_TEXT = '普通工作事实'
  const MISATTRIBUTED = '用户喜欢深色主题（被误记为 Agent 属性）'
  const WRONG_REFLECTION = '我总是在合并前跳过测试（错误反思）'
  const CONFLICTS_WITH_SPEC = '我会在回答里编造来源（与 Spec 冲突的观察）'
  const NO_SIGNAL = '我偏好短回答（无验证信号）'

  it('前置：画像/事实落 memory；四类输入落候选区（不写 memory）', async () => {
    await upsertMemory(isolationStore.connection, {
      layer: 'L1',
      kind: 'user_portrait',
      priority: -1,
      text: PORTRAIT_TEXT,
      embedding: null,
      embeddingModelId: null,
      actor: 'user',
    })
    await upsertMemory(isolationStore.connection, {
      layer: 'L1',
      kind: 'work_fact',
      text: FACT_TEXT,
      embedding: null,
      embeddingModelId: null,
      actor: 'user',
    })

    // ① 用户事实误归属：无独立信号 ⇒ record-only（永不 accepted）。
    const misattributed = await recordCandidate(isolationStore.connection, {
      text: MISATTRIBUTED,
      sourceRefs: ['l0-misattributed'],
      now: NOW,
    })
    expect((await decidePersistence(isolationStore.connection, {
      id: misattributed.id,
      signal: null,
      selfScoreOnly: false,
    })).state).toBe('candidate')

    // ② 错误反思：仅自评 ⇒ rejected。
    const wrong = await recordCandidate(isolationStore.connection, {
      text: WRONG_REFLECTION,
      sourceRefs: ['l0-wrong'],
      now: NOW,
    })
    expect((await decidePersistence(isolationStore.connection, {
      id: wrong.id,
      signal: 'tool-result',
      selfScoreOnly: true,
    })).state).toBe('rejected')

    // ③ 与 Persona Spec 冲突：有独立信号 ⇒ accepted，但 Spec 不被改写。
    const conflicts = await recordCandidate(isolationStore.connection, {
      text: CONFLICTS_WITH_SPEC,
      sourceRefs: ['l0-conflict'],
      now: NOW,
    })
    expect((await decidePersistence(isolationStore.connection, {
      id: conflicts.id,
      signal: 'user-feedback',
      selfScoreOnly: false,
    })).state).toBe('accepted')

    // ④ 无信号 ⇒ record-only。
    const noSignal = await recordCandidate(isolationStore.connection, {
      text: NO_SIGNAL,
      sourceRefs: ['l0-no-signal'],
      now: NOW,
    })
    expect((await decidePersistence(isolationStore.connection, {
      id: noSignal.id,
      signal: null,
      selfScoreOnly: false,
    })).state).toBe('candidate')

    // 不串域：自省候选从不写入 memory（User Portrait / 普通事实之外没有新行）。
    const memoryTexts = await queryAll(isolationStore.connection, 'MATCH (m:memory) RETURN m.text AS text')
    const texts = memoryTexts.map((row) => String(row.text))
    expect(texts).toEqual(expect.arrayContaining([PORTRAIT_TEXT, FACT_TEXT]))
    for (const candidateText of [MISATTRIBUTED, WRONG_REFLECTION, CONFLICTS_WITH_SPEC, NO_SIGNAL]) {
      expect(texts).not.toContain(candidateText)
    }
  })

  it('矩阵 7：candidate 走 recall / 注入 ⇒ 不可见（recall 只读 memory 表）', async () => {
    const recall = await runRecallCore({
      connection: isolationStore.connection,
      query: MISATTRIBUTED,
      queryVector: null,
      embeddingModelId: 'test-embed',
      rrfK: 60,
      retrievalTopK: 50,
      layerWeights: { l2: 0.7, l1: 0.4 },
      priorityWeight: 0.5,
      limit: 10,
      now: NOW.toISOString(),
    })
    expect(recall.results.map((item) => item.text)).not.toContain(MISATTRIBUTED)
    // 注入面：常驻层收集只返回 accepted。
    const accepted = await listAccepted(isolationStore.connection)
    expect(accepted.map((item) => item.text)).not.toContain(MISATTRIBUTED)
    expect(isVisible('candidate', 'recall')).toBe(false)
    expect(isVisible('candidate', 'injection')).toBe(false)
  })

  it('矩阵 8：rejected 走任何路径 ⇒ 不可见（不在常驻层、不在 recall）', async () => {
    const accepted = await listAccepted(isolationStore.connection)
    expect(accepted.map((item) => item.text)).not.toContain(WRONG_REFLECTION)
    const recall = await runRecallCore({
      connection: isolationStore.connection,
      query: WRONG_REFLECTION,
      queryVector: null,
      embeddingModelId: 'test-embed',
      rrfK: 60,
      retrievalTopK: 50,
      layerWeights: { l2: 0.7, l1: 0.4 },
      priorityWeight: 0.5,
      limit: 10,
      now: NOW.toISOString(),
    })
    expect(recall.results.map((item) => item.text)).not.toContain(WRONG_REFLECTION)
    expect(isVisible('rejected', 'query')).toBe(false)
  })

  it('矩阵 9：accepted 与 User Portrait 冲突 ⇒ 不覆盖画像，只是常驻层另一成员', async () => {
    // 画像行原样（正文/分类/优先级都不被自省观察改写）。
    const portrait = await queryAll(
      isolationStore.connection,
      "MATCH (m:memory {kind: 'user_portrait'}) RETURN m.text AS text, m.priority AS priority",
    )
    expect(portrait).toHaveLength(1)
    expect(String(portrait[0]?.text)).toBe(PORTRAIT_TEXT)
    expect(Number(portrait[0]?.priority)).toBe(-1)

    // 常驻层渲染：画像在骨架区块，accepted 自省在**独立区块**（分域、不合并成同一节点）。
    const facts = await readSkeletonFacts(isolationStore.connection)
    const accepted = await listAccepted(isolationStore.connection)
    const rendered = renderSkeleton(facts, 2000, accepted)
    expect(rendered.text).toContain(SKELETON_HEADER)
    expect(rendered.text).toContain(PORTRAIT_TEXT)
    expect(rendered.text).toContain(SELF_KNOWLEDGE_HEADER)
    expect(rendered.text).toContain(CONFLICTS_WITH_SPEC)
    // 画像行在前、自省区块在后（分离渲染，不混排成骨架事实行）。
    expect(rendered.text.indexOf(PORTRAIT_TEXT)).toBeLessThan(rendered.text.indexOf(SELF_KNOWLEDGE_HEADER))
    // 自省不是 User Portrait：冲突面不可见（accepted 也不能当冲突一方）。
    expect(isVisible('accepted', 'conflict')).toBe(false)
  })

  it('矩阵 10：accepted 与 Persona Spec 冲突 ⇒ Spec 只读、版本与正文不变', async () => {
    expect(PERSONA_SPEC_VERSION).toBe('draft-0')
    expect(PERSONA_SPEC_TEXT).toBe('')
    expect(canRewritePersonaSpec('reflection')).toBe(false)
    // accepted 的观察只出现在自省区块，不回流到任何 Spec 文本。
    const accepted = await listAccepted(isolationStore.connection)
    expect(accepted.map((item) => item.text)).toContain(CONFLICTS_WITH_SPEC)
    expect(PERSONA_SPEC_TEXT).not.toContain(CONFLICTS_WITH_SPEC)
  })

  it('注入装配：readAccepted 只喂 accepted，candidate/rejected 永不进骨架文本', async () => {
    const store = createSkeletonStore()
    const refresh = createSkeletonRefresher({
      store,
      readFacts: () => readSkeletonFacts(isolationStore.connection),
      readAccepted: () => listAccepted(isolationStore.connection),
      capTokens: () => 2000,
    })
    await refresh('s-isolation')
    const text = store.textFor('s-isolation')
    expect(text).toContain(PORTRAIT_TEXT)
    expect(text).toContain(CONFLICTS_WITH_SPEC)
    for (const hidden of [MISATTRIBUTED, WRONG_REFLECTION, NO_SIGNAL]) {
      expect(text).not.toContain(hidden)
    }
  })

  it('fail-closed：伪造状态（非三态）即使叫 accepted 也不进常驻层', async () => {
    await queryAll(
      isolationStore.connection,
      "CREATE (:agent_self_knowledge {id: 'bogus-state', state: 'accepted-ish', text: '伪造状态观察', " +
      "source_refs: ['l0-bogus'], created_at: '2026-11-18T00:00:00.000Z'}) RETURN 1 AS ok",
    )
    const accepted = await listAccepted(isolationStore.connection)
    expect(accepted.map((item) => item.id)).not.toContain('bogus-state')
    expect(accepted.every((item) => item.state === 'accepted')).toBe(true)
  })
})

describe('常驻层渲染：accepted 独立区块与预算', () => {
  const accepted = (id: string, text: string, decidedAt: string | null) => ({ id, text, decidedAt })

  it('只有 accepted 时也成块（首行是自省首行，不渲染空骨架首行）', () => {
    const rendered = renderSkeleton([], 2000, [accepted('k1', '已晋升观察', '2026-11-18T00:00:00.000Z')])
    expect(rendered.text.startsWith(SELF_KNOWLEDGE_HEADER)).toBe(true)
    expect(rendered.text).not.toContain(SKELETON_HEADER)
    expect(rendered.kept).toBe(1)
    expect(rendered.truncated).toBe(false)
  })

  it('accepted 排序确定（decided_at 升序、id 升序），同输入同字节', () => {
    const input = [
      accepted('k2', '后晋升', '2026-11-18T02:00:00.000Z'),
      accepted('k1', '先晋升', '2026-11-18T01:00:00.000Z'),
      accepted('k0', '同刻', '2026-11-18T01:00:00.000Z'),
    ]
    const first = renderSkeleton([], 2000, input)
    const second = renderSkeleton([], 2000, [...input].reverse())
    expect(first.text).toBe(second.text)
    expect(first.text.indexOf('先晋升')).toBeLessThan(first.text.indexOf('后晋升'))
    expect(first.text.indexOf('同刻')).toBeLessThan(first.text.indexOf('先晋升'))
  })

  it('预算不足 ⇒ 整块丢弃并标 truncated（不渲染半行）', () => {
    const rendered = renderSkeleton([], 3, [accepted('k1', '已晋升观察', null)])
    expect(rendered.text).toBe('')
    expect(rendered.truncated).toBe(true)
  })

  it('缺省 accepted ⇒ 输出与 8.5 逐字一致（既有钉死断言不受影响）', () => {
    const fact = {
      id: 'pin', layer: 'L1', kind: 'work_fact', priority: -1, text: '不推送', recordedAt: '2026-11-18T00:00:00.000Z',
    }
    expect(renderSkeleton([fact], 2000).text)
      .toBe(`${SKELETON_HEADER}\n- [L1] pin: 不推送`)
    expect(SELF_KNOWLEDGE_LIST_LIMIT).toBe(50)
  })
})

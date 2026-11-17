/**
 * Agent 身份契约原型的单元测试（Story 11.1 / AD-38、AD-39）。
 *
 * 纯函数，0 开库、0 宿主。覆盖 spec 的 I/O & Edge-Case 矩阵 1–5 与 T3 的 5 个跨会话用例：
 * candidate 全不可见、accepted 只进常驻层、rejected 全不可见、仅自评不晋升、运行时不可改写。
 * 另加一条「原型没有被装配进 index.ts」的结构钉，以及确定性自检。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_SIGNALS,
  PERSONA_SECTION_NAME,
  PERSONA_SPEC_VERSION,
  PERSONA_SPEC_WRITE_SOURCES,
  SELF_KNOWLEDGE_STATES,
  SELF_KNOWLEDGE_SURFACES,
  canRewritePersonaSpec,
  decidePromotion,
  isVisible,
  type KnowledgeSignal,
  type PersonaSpecWriteSource,
  type PromotionState,
  type SelfKnowledgeState,
} from '../src/persona/contract'

/** 逐状态取矩阵整行，便于「全部不可见」这类断言。 */
function row(state: SelfKnowledgeState): boolean[] {
  return SELF_KNOWLEDGE_SURFACES.map((surface) => isVisible(state, surface))
}

describe('可见性矩阵（spec 矩阵 1–3 / AD-38）', () => {
  // 矩阵 1：candidate 在普通 recall / 注入 / 专用查询全部不可见；冲突处理也不得参与。
  it('candidate：四个面全部不可见', () => {
    expect(isVisible('candidate', 'recall')).toBe(false)
    expect(isVisible('candidate', 'injection')).toBe(false)
    expect(isVisible('candidate', 'query')).toBe(false)
    expect(isVisible('candidate', 'conflict')).toBe(false)
    expect(row('candidate')).toEqual([false, false, false, false])
  })

  // 矩阵 2：accepted 只进常驻层注入；不得进普通召回候选竞争，也不得作为用户事实冲突的一方。
  it('accepted：注入可见，普通召回 / 冲突处理不可见，专用查询可审计', () => {
    expect(isVisible('accepted', 'injection')).toBe(true)
    expect(isVisible('accepted', 'recall')).toBe(false)
    expect(isVisible('accepted', 'conflict')).toBe(false)
    expect(isVisible('accepted', 'query')).toBe(true)
    expect(row('accepted')).toEqual([false, true, true, false])
  })

  // 矩阵 3：rejected 所有注入/召回路径不可见。
  it('rejected：四个面全部不可见', () => {
    expect(row('rejected')).toEqual([false, false, false, false])
  })

  it('三态 × 四面全矩阵与 ADR 一致（逐格，不靠「全部 false」蒙过）', () => {
    const expected: Record<SelfKnowledgeState, boolean[]> = {
      candidate: [false, false, false, false],
      accepted: [false, true, true, false],
      rejected: [false, false, false, false],
    }
    for (const state of SELF_KNOWLEDGE_STATES) {
      expect(row(state)).toEqual(expected[state])
    }
  })
})

describe('晋升门（spec 矩阵 4 / T2-T3）', () => {
  it('只有反思自我评分：不晋升；无独立信号时是 record-only，自评被当唯一依据时 rejected', () => {
    expect(decidePromotion({ signal: null, selfScoreOnly: true }).state).toBe('record-only')
    expect(decidePromotion({ signal: 'outcome', selfScoreOnly: true }).state).toBe('rejected')
    expect(decidePromotion({ signal: 'user-feedback', selfScoreOnly: true }).state).toBe('rejected')
  })

  it('无独立信号：record-only（只记录不晋升，不当作 rejected 丢弃）', () => {
    expect(decidePromotion({ signal: null, selfScoreOnly: false })).toMatchObject({ state: 'record-only' })
    expect(decidePromotion({ signal: null, selfScoreOnly: false }).reasons.join()).toContain('no-independent-signal')
  })

  it('有独立信号且非自评：accepted；三类信号都被认可', () => {
    expect(KNOWLEDGE_SIGNALS).toEqual(['outcome', 'tool-result', 'user-feedback'])
    for (const signal of KNOWLEDGE_SIGNALS) {
      expect(decidePromotion({ signal, selfScoreOnly: false }).state).toBe('accepted')
    }
  })

  it('判定结果只有三种，且自评路径永远到不了 accepted', () => {
    const states: PromotionState[] = []
    const signals: readonly (KnowledgeSignal | null)[] = [null, ...KNOWLEDGE_SIGNALS]
    for (const signal of signals) {
      for (const selfScoreOnly of [false, true]) {
        const decision = decidePromotion({ signal, selfScoreOnly })
        states.push(decision.state)
        expect(decision.reasons.length).toBeGreaterThan(0)
        if (selfScoreOnly) expect(decision.state).not.toBe('accepted')
      }
    }
    expect(new Set(states)).toEqual(new Set(['accepted', 'record-only', 'rejected']))
  })
})

describe('Persona Spec 运行时只读（spec 矩阵 5 / T2-T3）', () => {
  it('任何来源都不能改写 Persona Spec', () => {
    expect(PERSONA_SPEC_WRITE_SOURCES).toEqual(['runtime', 'reflection', 'user-memory', 'tool-call'])
    for (const source of PERSONA_SPEC_WRITE_SOURCES) {
      expect(canRewritePersonaSpec(source)).toBe(false)
    }
  })

  it('即使把来源写成任意字符串，也不返回 true', () => {
    for (const source of ['runtime', 'reflection', 'user-memory', 'tool-call', 'product-owner', '']) {
      expect(canRewritePersonaSpec(source as unknown as PersonaSpecWriteSource)).toBe(false)
    }
  })
})

describe('跨会话用例（spec T3 ①–⑤）', () => {
  // ① 同版本 Persona Spec 稳定：版本常量 + section 名固定 + 不可写 ⇒ 两个「会话」读到同一身份。
  it('① 同版本 Persona Spec 跨会话稳定', () => {
    const sessionA = { version: PERSONA_SPEC_VERSION, section: PERSONA_SECTION_NAME }
    const sessionB = { version: PERSONA_SPEC_VERSION, section: PERSONA_SECTION_NAME }
    expect(sessionA).toEqual(sessionB)
    expect(PERSONA_SPEC_VERSION).toBe('draft-0')
    expect(PERSONA_SECTION_NAME).toBe('omw-persona')
    expect(PERSONA_SECTION_NAME).not.toBe('omw-memory')
    expect(canRewritePersonaSpec('runtime')).toBe(false)
  })

  // ② 用户事实被误写为 Agent 属性 ⇒ 只能是 candidate，且候选处处不可见、不能自我晋升为身份。
  it('② 用户事实误写为 Agent 属性：候选不晋升、不可见', () => {
    const decision = decidePromotion({ signal: null, selfScoreOnly: true })
    const state: SelfKnowledgeState = 'candidate'
    expect(decision.state).not.toBe('accepted')
    expect(row(state).every((visible) => visible === false)).toBe(true)
  })

  // ③ 错误反思候选（仅自我评分）⇒ rejected / record-only，绝不 accepted。
  it('③ 仅自评的错误候选：rejected 或 record-only，绝不 accepted', () => {
    for (const signal of [null, 'outcome'] as const) {
      const decision = decidePromotion({ signal, selfScoreOnly: true })
      expect(['rejected', 'record-only']).toContain(decision.state)
      expect(decision.state).not.toBe('accepted')
    }
    expect(decidePromotion({ signal: null, selfScoreOnly: false }).state).toBe('record-only')
  })

  // ④ 与 Persona Spec 冲突的新观察 ⇒ 即使晋升成 accepted，也不能覆盖 Spec 或当作身份改写。
  it('④ 与 Persona Spec 冲突的新观察：不覆盖 Spec', () => {
    const before = PERSONA_SPEC_VERSION
    const decision = decidePromotion({ signal: 'user-feedback', selfScoreOnly: false })
    expect(decision.state).toBe('accepted')
    // accepted 只进常驻层的自省区；Spec 版本与写权限都不因它改变。
    expect(PERSONA_SPEC_VERSION).toBe(before)
    expect(canRewritePersonaSpec('reflection')).toBe(false)
    expect(isVisible('accepted', 'conflict')).toBe(false)
  })

  // ⑤ 尝试运行时改写 Spec ⇒ 被 canRewritePersonaSpec 拒绝。
  it('⑤ 运行时改写尝试被拒绝', () => {
    const attempts = ['runtime', 'reflection', 'user-memory', 'tool-call'] as const
    expect(attempts.filter((source) => canRewritePersonaSpec(source))).toEqual([])
  })
})

describe('原型边界（T2 / spec 矩阵 6-7）', () => {
  it('不被 index.ts 装配（设计原型不接宿主、不进 apply）', () => {
    // 11.1 的边界钉：原型不接运行时。Story 11.2 真正接线时必须**显式改这条钉**（连同 ADR 与
    // 契约一起），而不是删掉它来让测试变绿。
    const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(indexSource).not.toContain('persona/contract')
    expect(indexSource).not.toContain('PERSONA_SECTION_NAME')
  })

  it('同输入同输出（纯函数确定性，无时钟/随机）', () => {
    const first = decidePromotion({ signal: 'tool-result', selfScoreOnly: false })
    const second = decidePromotion({ signal: 'tool-result', selfScoreOnly: false })
    expect(first).toEqual(second)
    expect(isVisible('accepted', 'injection')).toBe(isVisible('accepted', 'injection'))
  })
})

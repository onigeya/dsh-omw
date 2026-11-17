/**
 * 冲突 policy 的旧/新身份等价（Story 11.4 / T4、AC:2393）。纯函数，0 开库。
 */
import { describe, expect, it } from 'vitest'
import {
  USER_PORTRAIT_CONFLICT_POLICY,
  conflictPendingIdentities,
  resolveConflictPolicy,
} from '../src/db/pending'

const OLD_ID = 'old-1'
const NEW_ID = 'new-1'

describe('conflictPendingIdentities / resolveConflictPolicy', () => {
  it('同一 (old,new) 同时给出历史 persona-conflict 与新 user-portrait-conflict 两种身份', () => {
    const forms = conflictPendingIdentities(OLD_ID, NEW_ID)
    const policies = new Set(forms.map((form) => form.policy))
    expect(policies.has('persona-conflict')).toBe(true)
    expect(policies.has(USER_PORTRAIT_CONFLICT_POLICY)).toBe(true)
    // 历史键可能含「带 action / 不带 action」两种形态；每个 id 都必须能解析回自己的 policy。
    expect(forms.length).toBeGreaterThanOrEqual(2)
    for (const form of forms) expect(resolveConflictPolicy(form.id, OLD_ID, NEW_ID)).toBe(form.policy)
  })

  it('历史 persona-conflict 行可被识别为同一逻辑冲突（policy 原值保留）', () => {
    const legacy = conflictPendingIdentities(OLD_ID, NEW_ID).find((form) => form.policy === 'persona-conflict')
    expect(legacy).toBeDefined()
    expect(resolveConflictPolicy(legacy!.id, OLD_ID, NEW_ID)).toBe('persona-conflict')
  })

  it('新 policy 行解析为新值；不一致的 id 返回 null（不得静默当新决策）', () => {
    const current = conflictPendingIdentities(OLD_ID, NEW_ID).find((form) => form.policy === USER_PORTRAIT_CONFLICT_POLICY)
    expect(current).toBeDefined()
    expect(resolveConflictPolicy(current!.id, OLD_ID, NEW_ID)).toBe(USER_PORTRAIT_CONFLICT_POLICY)
    expect(resolveConflictPolicy('not-a-known-key', OLD_ID, NEW_ID)).toBeNull()
  })
})


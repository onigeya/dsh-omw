import { describe, expect, it } from 'vitest'
import { createStepCounter } from '../src/capture/step-counter'

describe('步数计数器（AC①：满 N 且期间无其他采集）', () => {
  it('满 N 才返回 true，且达阈值即清零', () => {
    const counter = createStepCounter({ limit: 3 })
    expect(counter.recordStep('s1')).toBe(false)
    expect(counter.recordStep('s1')).toBe(false)
    expect(counter.recordStep('s1')).toBe(true)
    expect(counter.recordStep('s1')).toBe(false)
  })

  it('按 session 隔离', () => {
    const counter = createStepCounter({ limit: 2 })
    expect(counter.recordStep('s1')).toBe(false)
    expect(counter.recordStep('s2')).toBe(false)
    expect(counter.recordStep('s1')).toBe(true)
    expect(counter.recordStep('s2')).toBe(true)
  })

  it('reset 清零（期间发生其它采集）', () => {
    const counter = createStepCounter({ limit: 2 })
    counter.recordStep('s1')
    counter.reset('s1')
    expect(counter.recordStep('s1')).toBe(false)
  })

  it('limit 至少 1（0/负数收敛为 1）', () => {
    expect(createStepCounter({ limit: 0 }).recordStep('s1')).toBe(true)
  })
})

/**
 * 压缩运行态注册表（Story 8.3 / AC:1683）：写者注册 writer，只读实例清空并置标记。
 *
 * 模块级状态在 vitest 同进程内跨用例共享 ⇒ 每个用例前显式复位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getHandleWriter,
  isCompactionReadonly,
  registerHandleWriter,
  setCompactionReadonly,
} from '../src/context/handle-writer'

beforeEach(() => {
  registerHandleWriter(null)
  setCompactionReadonly(true)
})

describe('handle-writer：写者 / 只读两态', () => {
  it('未注册时默认只读且无 writer（fail-closed）', () => {
    expect(isCompactionReadonly()).toBe(true)
    expect(getHandleWriter()).toBeNull()
  })

  it('写者注册 writer 并置 readonly=false', () => {
    const writer = vi.fn()
    registerHandleWriter(writer)
    setCompactionReadonly(false)
    expect(getHandleWriter()).toBe(writer)
    expect(isCompactionReadonly()).toBe(false)
  })

  it('注册 null 撤销 writer（teardown 后回到 fail-open）', () => {
    registerHandleWriter(vi.fn())
    registerHandleWriter(null)
    expect(getHandleWriter()).toBeNull()
  })
})

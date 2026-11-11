/**
 * 流折叠单测（Story 2.3 / N1）。
 *
 * 运行期不 import 宿主 llm 值，所以折叠自己实现；契约：只累加 text-delta、
 * 只认最后一个 finish 块、其余 chunk（reasoning/tool-call/usage/block）一律忽略。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { foldChunks, foldStream } from '../src/distill/stream-fold'

const chunk = (value: unknown): StreamChunk => value as StreamChunk

describe('foldChunks', () => {
  it('只累加 text-delta，忽略 reasoning/usage/block 类 chunk', () => {
    expect(foldChunks([
      chunk({ type: 'block-start', index: 0 }),
      chunk({ type: 'reasoning-delta', index: 0, text: '内部推理' }),
      chunk({ type: 'text-delta', index: 0, text: '甲' }),
      chunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }),
      chunk({ type: 'text-delta', index: 0, text: '乙' }),
      chunk({ type: 'finish', reason: { kind: 'stop' } }),
    ])).toEqual({ text: '甲乙', finish: { kind: 'stop' } })
  })

  it('没有 finish 时 finish 为 undefined；空序列亦然', () => {
    expect(foldChunks([])).toEqual({ text: '', finish: undefined })
    expect(foldChunks([chunk({ type: 'text-delta', index: 0, text: 'x' })])).toEqual({ text: 'x', finish: undefined })
  })

  it('多个 finish 取最后一个（错误终态带 failure）', () => {
    const failure = { message: 'boom', code: 'provider_error', status: 503 }
    expect(foldChunks([
      chunk({ type: 'finish', reason: { kind: 'stop' } }),
      chunk({ type: 'finish', reason: { kind: 'error', failure } }),
    ])).toEqual({ text: '', finish: { kind: 'error', failure } })
  })
})

describe('foldStream', () => {
  it('异步流与同步内核同形（adapter 契约保证 finish 之后不再有 chunk，故不额外设守卫）', async () => {
    const stream = (async function* generate() {
      yield chunk({ type: 'text-delta', index: 0, text: '甲' })
      yield chunk({ type: 'text-delta', index: 0, text: '乙' })
      yield chunk({ type: 'finish', reason: { kind: 'stop' } })
    })()
    expect(await foldStream(stream)).toEqual({ text: '甲乙', finish: { kind: 'stop' } })
  })
})

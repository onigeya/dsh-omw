/**
 * 流折叠单测（Story 2.3 / N1）。
 *
 * 运行期不 import 宿主 llm 值，所以折叠自己实现；契约：只累加 text-delta、
 * **见到首个 finish 即停止**（评审 T10）、其余 chunk（reasoning/tool-call/usage/block）一律忽略。
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

  it('评审 T10：首个 finish 生效，其后的 text-delta 与第二个 finish 都不再计入', () => {
    const failure = { message: 'boom', code: 'provider_error', status: 503 }
    expect(foldChunks([
      chunk({ type: 'text-delta', index: 0, text: '甲' }),
      chunk({ type: 'finish', reason: { kind: 'stop' } }),
      chunk({ type: 'text-delta', index: 0, text: '不应计入' }),
      chunk({ type: 'finish', reason: { kind: 'error', failure } }),
    ])).toEqual({ text: '甲', finish: { kind: 'stop' } })
  })
})

describe('foldStream', () => {
  it('异步流与同步内核同形；见到 finish 即止（评审 T10）', async () => {
    const stream = (async function* generate() {
      yield chunk({ type: 'text-delta', index: 0, text: '甲' })
      yield chunk({ type: 'text-delta', index: 0, text: '乙' })
      yield chunk({ type: 'finish', reason: { kind: 'stop' } })
      yield chunk({ type: 'text-delta', index: 0, text: '不应计入' })
    })()
    expect(await foldStream(stream)).toEqual({ text: '甲乙', finish: { kind: 'stop' } })
  })
})

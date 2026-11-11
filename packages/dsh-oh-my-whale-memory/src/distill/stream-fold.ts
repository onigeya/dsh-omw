/**
 * Minimal fold over `ctx.llm.stream()` chunks（Story 2.3，runbook 裁决 N1）。
 *
 * 运行期不得 import `@deepseek-ai/dsh-llm` 的任何**值**：它是 devDependency，
 * tsdown 会把值内联进 `lib/index.js`。所以这里自带折叠，只 `import type` 消费 chunk 联合。
 */
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 一次流式模型调用的折叠结果。 */
export interface FoldedStream {
  /** 按流内顺序拼接的 `text-delta` 文本。 */
  readonly text: string
  /** 终止原因；流未给终止块时为 `undefined`。 */
  readonly finish: FinishReason | undefined
}

/** 折叠一个已物化的 chunk 序列（也是 {@link foldStream} 的同步内核）。 */
export function foldChunks(chunks: Iterable<StreamChunk>): FoldedStream {
  let text = ''
  let finish: FinishReason | undefined
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, finish }
}

/**
 * 把异步 chunk 流抽干为 {@link FoldedStream}。终止 `finish` 之后的 chunk 一律忽略
 * （adapter 契约保证不会再有）。
 */
export async function foldStream(stream: AsyncIterable<StreamChunk>): Promise<FoldedStream> {
  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return { text, finish }
}

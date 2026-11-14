/**
 * 流式 chunk 折叠（Story 2.3，runbook 裁决 N1）。
 *
 * 放在 shared/ 而不是 distill/：distill 与 wiki 都要折叠 `ctx.llm.stream()`，
 * 而 wiki 反向 import distill 会造出 `distill ↔ wiki` 的目录级环（AD-33）。
 * 本模块是被双方共用的**纯函数叶子**，不依赖包内任何其它目录。
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

/**
 * 折叠一个已物化的 chunk 序列（也是 {@link foldStream} 的同步内核）。
 *
 * 见到首个 `finish` 即停止累加（评审 T10）：终止块之后的内容不属于本次回答文本。
 * adapter 契约本就不会在 finish 之后再发 chunk，这里是防御性收敛，保证实现与文档一致。
 */
export function foldChunks(chunks: Iterable<StreamChunk>): FoldedStream {
  let text = ''
  let finish: FinishReason | undefined
  for (const chunk of chunks) {
    if (chunk.type === 'finish') {
      finish = chunk.reason
      break
    }
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return { text, finish }
}

/**
 * 把异步 chunk 流抽干为 {@link FoldedStream}。终止 `finish` 之后不再累加文本、
 * 只保留首个 finish（评审 T10；adapter 契约保证不会再有 chunk，这里是防御性收敛）。
 */
export async function foldStream(stream: AsyncIterable<StreamChunk>): Promise<FoldedStream> {
  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'finish') {
      finish = chunk.reason
      break
    }
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return { text, finish }
}

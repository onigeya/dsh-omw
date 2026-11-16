// Story 8.2 第 4 轮：把折叠接到 memory_related 的成功值上（additive：新增一个 oneOf 分支）。
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/tools/memory-related.ts'
let text = readFileSync(file, 'utf8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const K = (s) => s.replaceAll('\n', eol)

function must(from, to) {
  if (!text.includes(K(from))) {
    console.error('MISS:\n' + from.slice(0, 200))
    process.exit(1)
  }
  text = text.replace(K(from), K(to))
}

// 1) imports：折叠入口
must(
  `import { quotaOwnerOf, toolSignalOf } from './recall-shared.js'`,
  `import { quotaOwnerOf, toolSignalOf } from './recall-shared.js'
import { foldToolResult } from '../context/fold.js'`,
)

// 2) options：折叠所需的三项（阈值 / 只读 / 会话与幂等键）
must(
  `  /** 与 memory_recall 同一实例/同一桶的每轮配额。 */`,
  `  /**
   * Story 8.2：结果超阈值时折叠成句柄（全文入图，表面只留句柄）。
   * 缺省 = 不折叠（命令面与既有单测路径保持原行为）。
   */
  readonly fold?: {
    readonly thresholdTokens: number
    readonly readonly: boolean
    readonly sessionId: () => string
    /** 幂等键：同一会话 + 同一起点 + 同一 depth 视为「同一条工具结果」。 */
    readonly seqKey: (input: { readonly id: string, readonly depth: number }) => string
  }
  /** 与 memory_recall 同一实例/同一桶的每轮配额。 */`,
)

// 3) schema：新增「已折叠」分支（追加在成功分支之后，保持既有两分支不变）
must(
  `        partial: { type: 'boolean', description: 'true = 遍历超时，已降级为 depth=1 的部分结果' },`,
  `        partial: { type: 'boolean', description: 'true = 遍历超时，已降级为 depth=1 的部分结果' },
      },
      additionalProperties: false,
    },
    {
      // Story 8.2：结果过长时只回句柄（全文已入图，用 memory_expand 可 100% 还原）。
      type: 'object',
      properties: {
        folded: { type: 'boolean', required: true, description: '固定 true：本次结果已折叠为句柄' },
        handle: { type: 'string', required: true, description: '句柄 id（可直接传给 memory_expand）' },
        hint: { type: 'string', required: true, description: '如何还原：调 memory_expand(handle)' },
      },
      additionalProperties: false,`,
)
writeFileSync(file, text, 'utf8')
console.log('patched schema/options in ' + file)

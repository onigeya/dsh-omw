/**
 * 压缩区间的「判据 → 执行副本」规划测试（Story 8.6 / T3、T6、矩阵行 9/13）。
 *
 * 断言面：
 * - T2/T3 的执行副本已净化，T1 折叠用**净化前原文**（AC:1882-1884）；
 * - 判据一律在原文上算 ⇒ 净化不改变档位（INV-16 / AC:1886-1888）；
 * - user 原话永不净化（INV-15）。
 *
 * 为什么测 `planSummarizeExecution` 而不是 `OmwCompactionEngine.summarize`：引擎入口
 * import 的 `@deepseek-ai/dsh-compaction-basic` 运行期依赖 `@deepseek-ai/dsh-session`，
 * 本仓纯 Node 测试环境里不可解析（与 story 8.3/8.4 的既有口径一致）。规划函数是引擎里
 * 唯一的判定/净化逻辑，引擎自身只剩路由。
 */
import { describe, expect, it } from 'vitest'
import { planSummarizeExecution, type ExecutionMessageLike } from '../src/context/compaction-execution'
import { decideTier, planRegionTier, type CompactionCriteria } from '../src/context/compaction-tier'
import { renderRegionText } from '../src/context/compaction-t1'
import { estimateTokens } from '../src/context/fold'
import { DEFAULT_PURIFY_OPTIONS } from '../src/context/purify'

function assistant(text: string): ExecutionMessageLike {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** R3 压的对象：连续 6 行逐字相同（塌缩成一行）。 */
const DUP_LINE = 'Repeated statement line for the collapse rule.'

/** 实质正文：净化后仍然保留（证明净化不是「乱删」）。 */
const REAL_LINES = [
  'The migration ordering is documented in AD-34 and the schema version must equal the largest migration number in the migrations directory.',
  'Compaction keeps the retained tail and prices every decision with the effective token meter so the budget stays honest.',
]

/**
 * 高填充密度的正文（约 438 tokens）：40 行 `Let me…`（R1）+ 6 行复读（R3）+ 两行实质正文。
 * 净化后约 142 tokens —— 落在 lengthMin 200 之下，正是矩阵行 13 要的「净化前后档位不变」。
 */
const FILLER_TEXT = [
  ...Array.from({ length: 40 }, () => 'Let me…'),
  ...Array.from({ length: 6 }, () => DUP_LINE),
  ...REAL_LINES,
].join('\n')

/** 合法三带（lengthMin 不低于硬下界 200；无 user 消息时 requiredMin = 200）。 */
const ALWAYS_T3: CompactionCriteria = { lengthMin: 200, t3Threshold: 250 }

describe('T2/T3：执行副本是净化后的消息（AC:1859-1864）', () => {
  it('stock 执行副本已净化，T1 折叠副本仍是原文（句柄存净化前原文）', () => {
    const messages = [assistant(FILLER_TEXT)]
    const plan = planSummarizeExecution({ messages, criteria: ALWAYS_T3, purifyOptions: DEFAULT_PURIFY_OPTIONS })

    expect(plan.planned.tier).toBe('T3')
    expect(plan.purify.changed).toBe(true)
    // 执行副本：R1 填充行被删、R3 复读塌缩
    const stockText = renderRegionText(plan.stockMessages as never)
    expect(stockText).not.toContain('Let me…')
    expect(stockText.split(DUP_LINE).length - 1).toBe(1)
    expect(stockText).toContain('The migration ordering is documented in AD-34')
    // 折叠副本 = 净化前原文
    expect(plan.foldMessages).toBe(messages)
    expect(renderRegionText(plan.foldMessages as never)).toContain('Let me…')
    // 原文数组未被改写（INV-1：只改内存副本）
    expect(renderRegionText(messages as never)).toBe(renderRegionText(plan.foldMessages as never))
  })

  it('净化关掉（R1/R2/R3 全关）⇒ 执行副本与原文逐字相同', () => {
    const messages = [assistant(FILLER_TEXT)]
    const plan = planSummarizeExecution({
      messages,
      criteria: ALWAYS_T3,
      purifyOptions: { r1: false, r2: false, r3: false, minRemainder: 24 },
    })
    expect(plan.purify.changed).toBe(false)
    expect(renderRegionText(plan.stockMessages as never)).toBe(renderRegionText(messages as never))
  })

  it('user 原话永不净化（INV-15）；只净化 assistant 段', () => {
    const userMessage: ExecutionMessageLike = { role: 'user', content: [{ type: 'text', text: 'Let me…\nGo.' }] }
    const messages = [userMessage, assistant(FILLER_TEXT)]
    const plan = planSummarizeExecution({ messages, criteria: ALWAYS_T3, purifyOptions: DEFAULT_PURIFY_OPTIONS })
    expect(plan.stockMessages[0]).toBe(userMessage)
    expect(renderRegionText([plan.stockMessages[0] as never])).toContain('Let me…')
  })
})

describe('T1：折叠副本永远是净化前原文（AC:1882-1884）', () => {
  it('判据未注册（fail-closed T1）⇒ 不净化折叠正文', () => {
    const messages = [assistant(FILLER_TEXT)]
    const plan = planSummarizeExecution({ messages, criteria: null, purifyOptions: DEFAULT_PURIFY_OPTIONS })
    expect(plan.planned.tier).toBe('T1')
    expect(plan.planned.reason).toBe('criteria-unavailable')
    expect(plan.foldMessages).toBe(messages)
    expect(renderRegionText(plan.foldMessages as never)).toContain('Let me…')
  })

  it('含 user 原话的区间 ⇒ T1（受保护内容），折叠正文仍逐字原文', () => {
    const messages: ExecutionMessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'Keep my words exactly.' }] },
      assistant(FILLER_TEXT),
    ]
    const plan = planSummarizeExecution({ messages, criteria: ALWAYS_T3, purifyOptions: DEFAULT_PURIFY_OPTIONS })
    expect(plan.planned.tier).toBe('T1')
    expect(plan.planned.reason).toBe('protected-content')
    expect(renderRegionText(plan.foldMessages as never)).toContain('Let me…')
  })
})

describe('T6 / 矩阵行 13：判据在净化前原文上算（INV-16）', () => {
  it('净化后 token 掉到长度下限之下，档位仍按原文判定（净化前后档位不变）', () => {
    const messages = [assistant(FILLER_TEXT)]
    const rawTokens = estimateTokens(renderRegionText(messages as never))
    // 三带卡在「原文刚好落进 T2」的位置（lengthMin 200 = 无 user 消息时的硬下界）
    const criteria: CompactionCriteria = { lengthMin: 200, t3Threshold: rawTokens + 20 }

    const plan = planSummarizeExecution({ messages, criteria, purifyOptions: DEFAULT_PURIFY_OPTIONS })
    expect(plan.planned.tier).toBe('T2')
    expect(plan.planned.tokens).toBe(rawTokens)

    // 同一段净化后的 token 数确实已经跌到下带（证明「按净化后算会改档」）
    const purifiedTokens = estimateTokens(renderRegionText(plan.stockMessages as never))
    expect(purifiedTokens).toBeLessThan(rawTokens)
    expect(decideTier({ tokens: purifiedTokens }, criteria).tier).toBe('T1')

    // 而真正的判定入口（planRegionTier）只用原文 ⇒ 档位稳定
    expect(planRegionTier({ messages: messages as never, criteria }).tier).toBe('T2')
  })
})

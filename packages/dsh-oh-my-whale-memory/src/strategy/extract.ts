/**
 * 策略候选的提炼输入/输出（Story 7.3 / AC:1455-1458、AD-20）。
 *
 * 纯函数：prompt 文本、消息构造、LLM 输出的容错解析。LLM 调用本身在 `reflection/executor.ts`
 * （走宿主 `ctx.llm` 单通道，AD-5），这样解析规则可以脱离网络与模型单测。
 *
 * 为什么要求「引用步骤」：外部一手依据（dsh-mnemon `skills.md:123`）逐字要求建议必须
 * 「citing the steps it rests on」——证据锚定是噪声过滤的第一道闸；因此解析时 **没有 refs 的候选直接丢弃**。
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** 结构化输出的 sentinel（§14：字段说明永远不是有效值）。 */
export const STRATEGY_SENTINEL =
  'Field descriptions are never valid values; set them to null when the field does not apply.'

/**
 * 提炼指令（与解析 schema 同文件保存，改一处必须改另一处——§14 的约定）。
 *
 * 四条硬约束：①只输出 JSON；②每条候选必须给 `sourceRefs`（指向样本的 ref）；③`outcome` 三态；
 * ④没有可复用经验时输出空数组（**不要编造**）。
 */
export const STRATEGY_EXTRACT_INSTRUCTION = [
  '你是一个「经验提炼器」。输入是最近若干条会话轨迹样本（每条带 ref 与正文）。',
  '任务：从这些样本里提炼**可复用的策略**——「在什么处境下应该怎么做」的一句话陈述。',
  STRATEGY_SENTINEL,
  '',
  '输出要求：',
  '1. 只输出一个 JSON 对象，形如 {"candidates":[{"text":"...","outcome":"success|failure|uncertain","sourceRefs":["ref1"]}]}；',
  '2. 每条候选必须给出至少一个 sourceRefs，且只能是输入样本里出现过的 ref（没有可引用样本的候选一律不要输出）；',
  '3. outcome 描述该经验来自成功、失败还是不确定的轨迹（失败经验要保留，不要美化）；',
  '4. 没有值得复用的经验时输出 {"candidates":[]}，**不要编造**。',
  '5. 候选正文必须是可独立理解的完整陈述，不引用「上面」「刚才」这类上下文指代。',
].join('\n')

export interface StrategySample {
  /** 样本引用（`l0:<id>` / `log:<id>` / `inbox:<id>`），必须能回溯到 L0。 */
  readonly ref: string
  readonly text: string
}

export type StrategyCandidateOutcome = 'success' | 'failure' | 'uncertain'

export interface ExtractedStrategyCandidate {
  readonly text: string
  readonly outcome: StrategyCandidateOutcome
  readonly sourceRefs: readonly string[]
}

export interface ExtractionResult {
  readonly candidates: readonly ExtractedStrategyCandidate[]
  /** 被丢弃的原因（无 refs / 正文空 / 非法 outcome），用于账本与 status 解释。 */
  readonly dropped: readonly string[]
}

/** 构造请求消息：样本以 `[ref] 正文` 逐行给出（每条截断到 800 字符，防止单条撑爆上下文）。 */
export function buildStrategyMessages(samples: readonly StrategySample[]): RequestMessage[] {
  const body = samples
    .map((sample) => `[${sample.ref}] ${sample.text.length > 800 ? sample.text.slice(0, 800) + '…' : sample.text}`)
    .join('\n')
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: STRATEGY_EXTRACT_INSTRUCTION + '\n\n样本：\n' + body }],
    },
  ]
}

function isOutcome(value: unknown): value is StrategyCandidateOutcome {
  return value === 'success' || value === 'failure' || value === 'uncertain'
}

/**
 * 容错解析：允许模型在 JSON 前后加说明文字（取首个 `{` 到末个 `}`），逐条校验。
 * 无 refs / 正文空 / outcome 非法 / refs 不在样本集内 ⇒ 丢弃并记原因（**不猜、不补**）。
 */
export function parseStrategyCandidates(raw: string, knownRefs: readonly string[]): ExtractionResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { candidates: [], dropped: ['no-json-object'] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { candidates: [], dropped: ['invalid-json'] }
  }
  const list = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) return { candidates: [], dropped: ['missing-candidates-array'] }
  const allowed = new Set(knownRefs)
  const candidates: ExtractedStrategyCandidate[] = []
  const dropped: string[] = []
  for (const [index, entry] of list.entries()) {
    const record = entry as { text?: unknown, outcome?: unknown, sourceRefs?: unknown }
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (text === '') {
      dropped.push(`candidate[${String(index)}]:empty-text`)
      continue
    }
    if (!isOutcome(record.outcome)) {
      dropped.push(`candidate[${String(index)}]:bad-outcome`)
      continue
    }
    const refs = Array.isArray(record.sourceRefs)
      ? record.sourceRefs.filter((ref): ref is string => typeof ref === 'string' && allowed.has(ref))
      : []
    if (refs.length === 0) {
      dropped.push(`candidate[${String(index)}]:no-source-refs`)
      continue
    }
    candidates.push({ text, outcome: record.outcome, sourceRefs: [...new Set(refs)] })
  }
  return { candidates, dropped }
}

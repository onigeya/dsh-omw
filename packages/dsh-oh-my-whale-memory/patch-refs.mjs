// 修补：strategy_candidate 缺 source_refs 列（AC:1458 要求候选可回溯到产生它的轨迹）。
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const K = (s) => s.replaceAll('\n', eol)
  for (const [from, to] of pairs) {
    if (!text.includes(K(from))) {
      console.error('MISS in ' + file + ':\n' + from.slice(0, 160))
      process.exit(1)
    }
    text = text.replace(K(from), K(to))
  }
  writeFileSync(file, text, 'utf8')
  console.log('patched ' + file)
}

patch('src/db/schema.ts', [
  [
    `    'id STRING, strategy_id STRING, payload STRING, state STRING, rewrites INT64, score DOUBLE, ' +
    'outcome STRING, reasons STRING, created_at STRING, expires_at STRING, updated_at STRING, ' +`,
    `    'id STRING, strategy_id STRING, payload STRING, state STRING, rewrites INT64, score DOUBLE, ' +
    // AC:1458：候选必须能回溯到产生它的轨迹 / 反思（可回溯到 L0）——没有这列就是口头满足。
    'outcome STRING, reasons STRING, source_refs STRING[], created_at STRING, expires_at STRING, ' +
    'updated_at STRING, ' +`,
  ],
])

patch('src/strategy/candidates.ts', [
  [
    `  readonly payload: string
  readonly state: StrategyCandidateState`,
    `  readonly payload: string
  /** 回溯引用（l0:<id> 等，AC:1458）。 */
  readonly sourceRefs: readonly string[]
  readonly state: StrategyCandidateState`,
  ],
  [
    `    '  score: $score, outcome: $outcome, reasons: $reasons, created_at: $created_at,',
    '  expires_at: $expires_at, updated_at: $updated_at',`,
    `    '  score: $score, outcome: $outcome, reasons: $reasons, source_refs: $source_refs,',
    '  created_at: $created_at, expires_at: $expires_at, updated_at: $updated_at',`,
  ],
  [
    `  '  c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
  '  c.created_at AS created_at, c.expires_at AS expires_at',
].join('\\n')`,
    `  '  c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
  '  c.source_refs AS source_refs, c.created_at AS created_at, c.expires_at AS expires_at',
].join('\\n')`,
  ],
  [
    `    state: String(row.state ?? 'pending') as StrategyCandidateState,`,
    `    sourceRefs: Array.isArray(row.source_refs) ? row.source_refs.map(String) : [],
    state: String(row.state ?? 'pending') as StrategyCandidateState,`,
  ],
  [
    `    readonly outcome: StrategyOutcome
    readonly createdAt: string`,
    `    readonly outcome: StrategyOutcome
    readonly sourceRefs: readonly string[]
    readonly createdAt: string`,
  ],
  [
    `    outcome: input.outcome,
    reasons: '',`,
    `    outcome: input.outcome,
    reasons: '',
    source_refs: [...input.sourceRefs],`,
  ],
  [
    `      '    c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
      '    c.created_at AS created_at, c.expires_at AS expires_at',`,
    `      '    c.rewrites AS rewrites, c.score AS score, c.outcome AS outcome, c.reasons AS reasons,',
      '    c.source_refs AS source_refs, c.created_at AS created_at, c.expires_at AS expires_at',`,
  ],
])

patch('src/reflection/executor.ts', [
  [
    `        payload: candidate.text,
        outcome: candidate.outcome,`,
    `        payload: candidate.text,
        outcome: candidate.outcome,
        // AC:1458：把解析阶段验过的 refs 一并落库（可回溯到产生它的 L0 行）。
        sourceRefs: candidate.sourceRefs,`,
  ],
])

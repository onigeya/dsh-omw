// Story 7.3 评审 R73 修补：status 三项可见、复算强制、状态守卫、reasons 追加。
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const K = (s) => s.replaceAll('\n', eol)
  for (const [from, to] of pairs) {
    if (!text.includes(K(from))) {
      console.error('MISS in ' + file + ':\n' + from.slice(0, 180))
      process.exit(1)
    }
    text = text.replace(K(from), K(to))
  }
  writeFileSync(file, text, 'utf8')
  console.log('patched ' + file)
}

// 1) status 行补 expiryDays / maxPendingPerSession / expired（AC:1493-1494 要求三项可见）
patch('src/command.ts', [
  [
    `  const line =
    \`strategy_gate: candidates=\${String(view.candidates)} pending=\${String(view.pending)} adopted=\${String(view.adopted)} \` +
    \`rejected=\${String(view.rejected)} noEvidence=\${String(view.noEvidence)} minConfidence=\${String(view.minConfidence)}\``,
    `  // AC:1493-1494：三项配置都要可见（评审 R73 FAIL 第 5 条：原先只输出 minConfidence）。
  const line =
    \`strategy_gate: candidates=\${String(view.candidates)} pending=\${String(view.pending)} adopted=\${String(view.adopted)} \` +
    \`rejected=\${String(view.rejected)} expired=\${String(view.expired)} noEvidence=\${String(view.noEvidence)} \` +
    \`minConfidence=\${String(view.minConfidence)} expiryDays=\${String(view.expiryDays)} \` +
    \`maxPendingPerSession=\${String(view.maxPendingPerSession)}\``,
  ],
])

// 2) 复算强制：没有第二次独立计算就不算「measured」，不得采纳（AD-20 要求两轮独立回测）
patch('src/strategy/gate.ts', [
  [
    `  const recomputed = input.recomputedScore !== undefined
  if (input.recomputedScore !== undefined && !recomputeMatches(challengerScore, input.recomputedScore)) {`,
    `  const recomputed = input.recomputedScore !== undefined
  // AD-20：「必须对既有 champion 做**两轮独立回测**」；评审 R73 第 2 条指出原先省略复算仍可采纳，
  // 等于把强制判据降级为调用方自觉。这里改为「未提供复算值 ⇒ 不采纳」，并在 reasons 里说明。
  if (!recomputed) {
    reasons.push('no-recompute：缺少第二次独立计算，按 AD-20 不得采纳（回测必须两轮）')
  }
  if (input.recomputedScore !== undefined && !recomputeMatches(challengerScore, input.recomputedScore)) {`,
  ],
  // 注释里「AD-20 的公式是后者」是错的（代码是摊平），按评审第 1 条改正
  [
    `/** 跨 case 汇总：把所有 check 摊平后按权重求和（与逐 case 平均不同，AD-20 的公式是后者）。 */`,
    `/** 跨 case 汇总：把所有 check **摊平**后按权重求和（AD-20 的公式是「Σ通过权重/Σ全部权重」）。 */`,
  ],
])

// 3) 候选区状态守卫 + reasons 追加（评审 R73 第 3/4 条）
patch('src/strategy/candidates.ts', [
  [
    `  const candidate = await readStrategyCandidate(connection, input.id)
  if (candidate === null) {
    throw new MemoryDbError('strategy_candidate_not_found', '策略候选不存在（id=' + input.id + '）')
  }
  const statement = await connection.prepare(
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      '  SET c.state = $state, c.score = $score, c.reasons = $reasons, c.updated_at = $now',
    ].join('\\n'),
  )`,
    `  const candidate = await readStrategyCandidate(connection, input.id)
  if (candidate === null) {
    throw new MemoryDbError('strategy_candidate_not_found', '策略候选不存在（id=' + input.id + '）')
  }
  // 状态守卫（评审 R73 第 3 条）：只有 pending 能被门判定；已 adopted/rejected/expired 不得被改成别的状态
  // （否则一条已采纳的候选能被第二次判定「改判」，审计上等于篡改历史）。
  if (candidate.state !== 'pending') {
    throw new MemoryDbError(
      'strategy_candidate_not_pending',
      \`策略候选状态为 \${candidate.state}，只有 pending 可被采纳门判定\`,
    )
  }
  const statement = await connection.prepare(
    [
      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      '  SET c.state = $state, c.score = $score, c.reasons = $reasons, c.updated_at = $now',
    ].join('\\n'),
  )`,
  ],
  [
    `      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      \`  SET c.state = 'rejected', c.outcome = 'failure', c.reasons = $reason, c.updated_at = $now\`,`,
    `      'MATCH (c:' + STRATEGY_CANDIDATE_TABLE + ' {id: $id})',
      // reasons 追加而不是覆盖（评审 R73 第 4 条：覆盖会丢掉 'no-cases'，让 noEvidence 计数静默归零）。
      "  SET c.state = 'rejected', c.outcome = 'failure',",
      "    c.reasons = CASE WHEN c.reasons = '' THEN $reason ELSE c.reasons + '；' + $reason END,",
      '    c.updated_at = $now',`,
  ],
  // 重写只允许 pending
  [
    `  if (candidate.rewrites >= MAX_STRATEGY_REWRITES) {`,
    `  if (candidate.state !== 'pending') {
    throw new MemoryDbError(
      'strategy_candidate_not_pending',
      \`策略候选状态为 \${candidate.state}，只有 pending 可重写\`,
    )
  }
  if (candidate.rewrites >= MAX_STRATEGY_REWRITES) {`,
  ],
])

// 4) 新错误码
patch('src/db/errors.ts', [
  [
    `  /** 候选重写次数用尽（Story 7.3 / AC:1490：2 次后丢弃）。 */
  | 'strategy_rewrite_exhausted'`,
    `  /** 候选重写次数用尽（Story 7.3 / AC:1490：2 次后丢弃）。 */
  | 'strategy_rewrite_exhausted'
  /** 候选不在 pending 状态（Story 7.3：只有 pending 可被判定/重写，评审 R73）。 */
  | 'strategy_candidate_not_pending'`,
  ],
])

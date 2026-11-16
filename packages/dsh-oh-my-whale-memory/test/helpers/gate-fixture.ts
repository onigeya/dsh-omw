// 测试夹具：无 case 集时的采纳门判定（AD-20 的 evidence=none 降级态）。
import { evaluateCandidate } from '../../src/strategy/gate'

export function firstGateDecision() {
  return evaluateCandidate({ cases: [], minConfidence: 0.6 })
}

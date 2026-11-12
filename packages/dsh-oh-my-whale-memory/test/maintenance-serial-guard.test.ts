/**
 * 静态守卫（Story 2.6 评审 P18a / T19 / EC-07）：`maintenance` 里两个回填必须**串行** await。
 *
 * 为什么不写成行为测试：两个回填都在事务外做裸 prepare/execute（`evidence-backfill.ts` 的
 * readCursor/writeCursor、`embedding/backfill.ts` 同族），并发跑在同一条连接上时，语句可能
 * 落进对方尚未结算的连接级事务——要确定性观测到差异必须能在「对方事务未提交」的窗口里挂起，
 * 当前实现没有注入缝（属变异审计 M10 判定的「不可黑盒观测」情形）。
 *
 * 因此这里钉**源码形状**：maintenance 块内必须是两条顺序 await，不得改回 `Promise.all`。
 * 这是「宁可同义反复也要拦住回归」的一次例外裁决（Lead，2026-11-13），理由同 P7 的双保险：
 * 并发写者/游标交叉是数据正确性问题，不是性能问题，代价远高于一条静态断言。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

/** 取 `maintenance: async () => { ... }` 的函数体（按花括号配平，避免被后续代码干扰）。 */
function maintenanceBody(): string {
  const start = SOURCE.indexOf('maintenance: async () => {')
  if (start < 0) throw new Error('找不到 maintenance 定义：index.ts 结构变了，请同步本守卫')
  const open = SOURCE.indexOf('{', start)
  let depth = 0
  for (let i = open; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(open, i + 1)
    }
  }
  throw new Error('maintenance 函数体花括号不配平')
}

describe('P18a：maintenance 的两个回填串行执行（静态守卫）', () => {
  it('函数体内是顺序 await，且没有 Promise.all / allSettled / race', () => {
    const body = maintenanceBody()
    // 回归钉：改回并发时这里立刻变红。
    expect(body).not.toMatch(/Promise\.(all|allSettled|race|any)\s*\(/)
    // 两个回填都要真的被跑到（防「为了过守卫把某一路删掉」）。
    expect(body).toContain('embeddingBackfill')
    expect(body).toContain('evidenceBackfill')
    // 串行 = 两条 await 出现在不同的语句里（并发写法通常只有一条 await）。
    const awaits = body.match(/await\s/g) ?? []
    expect(awaits.length).toBeGreaterThanOrEqual(2)
  })
})
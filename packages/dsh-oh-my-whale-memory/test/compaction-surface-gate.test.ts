/**
 * INV-11 漂移锁的自检（Story 8.3 / AC:1691、AC:1703）。
 *
 * 门禁脚本本身必须被测试：一个永远 PASS 的检查等于没有检查（8.1 的教训）。
 * 这里钉住判定规则的正反两面，并断言真实源码树当前是合规的。
 */
import { describe, expect, it } from 'vitest'
import {
  checkSources,
  classifySpecifier,
  extractSpecifiers,
} from '../../scripts/check-compaction-surface.mjs'

describe('漂移锁判定（classifySpecifier）', () => {
  it('拒绝压缩后端的深路径（lib/ 与 src/）', () => {
    expect(classifySpecifier('@deepseek-ai/dsh-compaction-basic/lib/index.js')).toMatch(/deep path/)
    expect(classifySpecifier('@deepseek-ai/dsh-compaction-basic/lib/types/index.js')).toMatch(/deep path/)
    expect(classifySpecifier('@deepseek-ai/dsh-compaction-basic/src/region.ts')).toMatch(/deep path/)
  })

  it('拒绝任何 region 模块 import（AC:1691 明文）', () => {
    expect(classifySpecifier('./region.js')).toMatch(/region module/)
    expect(classifySpecifier('../dsh-compaction-basic/region.js')).not.toBeNull()
  })

  it('允许包根（公共面）与无关依赖', () => {
    expect(classifySpecifier('@deepseek-ai/dsh-compaction-basic')).toBeNull()
    expect(classifySpecifier('@deepseek-ai/dsh-compaction')).toBeNull()
    expect(classifySpecifier('@deepseek-ai/cordis')).toBeNull()
    expect(classifySpecifier('../context/handle.js')).toBeNull()
  })
})

describe('说明符提取（extractSpecifiers）', () => {
  it('静态 import / 副作用 import / export … from 都能取到', () => {
    const source = [
      "import { a } from '@deepseek-ai/dsh-compaction'",
      "import type { B } from '../db/backend.js'",
      "import './side-effect.js'",
      "export { c } from './other.js'",
      "export type { D } from './types.js'",
    ].join('\n')
    expect(extractSpecifiers(source).sort()).toEqual([
      '../db/backend.js',
      './other.js',
      './side-effect.js',
      './types.js',
      '@deepseek-ai/dsh-compaction',
    ].sort())
  })

  it('注释里的 import 不会被误判（只匹配行首语句）', () => {
    const source = "// import { x } from './region.js'\nconst a = 1\n"
    expect(extractSpecifiers(source)).toEqual([])
  })
})

describe('真实源码树当前合规', () => {
  it('零违规（若这里红了，说明有人往 src 里加了深路径依赖）', () => {
    const result = checkSources()
    expect(result.files).toBeGreaterThan(80)
    expect(result.violations).toEqual([])
  })
})

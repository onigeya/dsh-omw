/**
 * 覆盖缺口检测（Story 8.3 / AC:1675、NFR19）：三态 + 告警文案逐字。
 */
import { describe, expect, it } from 'vitest'
import { compactionOverlayGapWarning, detectCompactionOverlayGap } from '../src/context/compaction-gap'

class OmwCompactionEngine {}
class StockCompactionEngine {}

describe('detectCompactionOverlayGap', () => {
  it('宿主没有压缩服务 ⇒ absent（web profile 的 stock 被禁用时不该误报）', () => {
    expect(detectCompactionOverlayGap({})).toBe('absent')
    expect(detectCompactionOverlayGap({ get: () => undefined })).toBe('absent')
  })

  it('解析到我们的引擎 ⇒ own', () => {
    expect(detectCompactionOverlayGap({ get: () => new OmwCompactionEngine() })).toBe('own')
  })

  it('解析到别的引擎 ⇒ foreign（A1 装配被宿主拒绝的失败形态）', () => {
    expect(detectCompactionOverlayGap({ get: () => new StockCompactionEngine() })).toBe('foreign')
  })
})

describe('compactionOverlayGapWarning', () => {
  it('只有 foreign 产生告警，且文案点名 patch 检查', () => {
    expect(compactionOverlayGapWarning('own')).toBeNull()
    expect(compactionOverlayGapWarning('absent')).toBeNull()
    expect(compactionOverlayGapWarning('foreign')).toContain('压缩引擎未被本插件接管')
    expect(compactionOverlayGapWarning('foreign')).toContain('cordis.patch.yml')
  })
})

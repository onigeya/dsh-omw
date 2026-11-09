/**
 * 指纹 id 测试（Story 1.4 / AC3 / AD-4）。
 *
 * 契约：`id = uuid5(layer + ':' + 归一化 text)`；归一化 = NFKC + 小写 + 去标点 +
 * 空白折叠。指纹含 layer，不含 source_refs 与时间戳——同一事实重复写入必然命中同一 id。
 */
import { describe, expect, it } from 'vitest'
import { MEMORY_ID_NAMESPACE, memoryNodeId, normalizeFingerprintText, uuid5 } from '../src/db/id'

describe('记忆指纹 id（AC3）', () => {
  it('uuid5 对 RFC 4122 示例向量给出已知结果', () => {
    // RFC 4122 附录 B：DNS 命名空间下的 "www.example.com"
    expect(uuid5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
      .toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('归一化：NFKC + 小写 + 去标点 + 空白折叠', () => {
    expect(normalizeFingerprintText('  Hello,   World!  ')).toBe('hello world')
    expect(normalizeFingerprintText('ＦｕｌｌＷｉｄｔｈ')).toBe('fullwidth')
    expect(normalizeFingerprintText('a\n\tb')).toBe('a b')
    expect(normalizeFingerprintText('数据库：测试。')).toBe('数据库测试')
  })

  it('同一文本的大小写/标点/空白差异产生同一 id', () => {
    expect(memoryNodeId('L1_INBOX', 'Hello, World!')).toBe(memoryNodeId('L1_INBOX', 'hello world'))
    expect(memoryNodeId('L1_INBOX', '  空格  折叠 ')).toBe(memoryNodeId('L1_INBOX', '空格 折叠'))
  })

  it('layer 参与指纹：同文本的 L1 与 L2 不撞节点', () => {
    expect(memoryNodeId('L1_INBOX', 'same text')).not.toBe(memoryNodeId('L2_WIKI', 'same text'))
  })

  it('返回合法 uuid v5 形态', () => {
    const id = memoryNodeId('L1_INBOX', 'x')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('归一化后为空 → 抛 empty_fingerprint_text', () => {
    expect(() => memoryNodeId('L1_INBOX', '   ')).toThrow(/归一化后为空/)
    expect(() => normalizeFingerprintText('!!!???')).toThrow(/归一化后为空/)
    // code 是 I/O 矩阵第 6 行的契约值（spec 唯一事实来源）。
    expect(() => memoryNodeId('L1_INBOX', '   ')).toThrow(
      expect.objectContaining({ code: 'empty_fingerprint_text' }),
    )
  })

  it('layer 非法 → 抛 invalid_layer', () => {
    expect(() => memoryNodeId('', 'x')).toThrow(/layer/)
    expect(() => memoryNodeId('L1:INBOX', 'x')).toThrow(/冒号/)
  })

  it('命名空间常量为固定值（改动即破坏已建库的 id 兼容性）', () => {
    expect(MEMORY_ID_NAMESPACE).toBe('f2f0c1b4-6c3a-5d8e-9a7b-1c2d3e4f5a6b')
  })
})

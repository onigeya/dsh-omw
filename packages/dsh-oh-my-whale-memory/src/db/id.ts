/**
 * 节点 id = uuid5(layer + ':' + 归一化 text)（AD-4）。
 *
 * - 指纹只含 layer 与归一化 text：不含 source_refs、不含任何时间戳，所以同内容
 *   跨源、跨时间都命中同一 id，天生幂等（FR-15）。
 * - 归一化：NFKC（全角→半角）→ 小写 → 去标点（Unicode \p{P}）→ 空白折叠 trim。
 * - layer 不做归一化（大小写敏感），但禁止为空或含冒号——冒号是 layer 与 text 的分隔符。
 */
import { createHash } from 'node:crypto'
import { MemoryDbError } from './errors.js'

/**
 * uuid5 命名空间。任意固定 UUID 常量，作用只是让 id 稳定可复现；
 * 一旦改动，所有已存在节点 id 全部失效——视为破坏性变更，永不修改。
 */
export const MEMORY_ID_NAMESPACE = 'f2f0c1b4-6c3a-5d8e-9a7b-1c2d3e4f5a6b'

/** RFC 4122 v5：SHA-1(namespace bytes + name)，设 version=5 与 variant 位。 */
export function uuid5(name: string, namespace: string = MEMORY_ID_NAMESPACE): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 供指纹使用的文本归一化。空结果抛错——空指纹无法作为节点主键。 */
export function normalizeFingerprintText(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{P}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) {
    throw new MemoryDbError('empty_fingerprint_text', '记忆文本归一化后为空（只含标点或空白），拒绝建节点')
  }
  return normalized
}

/** 节点 id 计算：uuid5(layer + ':' + 归一化 text)。 */
export function memoryNodeId(layer: string, text: string): string {
  const normalizedLayer = layer.trim()
  if (!normalizedLayer) throw new MemoryDbError('invalid_layer', '记忆层（layer）不能为空')
  if (normalizedLayer.includes(':')) {
    throw new MemoryDbError('invalid_layer', `记忆层（layer）不能包含冒号，实际 ${normalizedLayer}`)
  }
  return uuid5(`${normalizedLayer}:${normalizeFingerprintText(text)}`)
}

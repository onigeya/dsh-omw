/**
 * resolveEmbeddingProfile 直接单测（AC2 / AC5 / AD-14）。
 *
 * 维度优先级：显式 embedding.dim > 已知模型表（baai/bge-m3 = 1024）> 默认 1024。
 * 该解析决定建库时 FLOAT[DIM] 的 pin，错一个维度就是整库不可写，所以四个分支都要
 * 直接断言，而不是只经由 openMemoryDatabase 间接覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMBEDDING_DIM,
  resolveEmbeddingProfile,
} from '../src/db/embedding-profile'

describe('resolveEmbeddingProfile：维度解析优先级', () => {
  it('显式 dim 优先于已知模型表', () => {
    const profile = resolveEmbeddingProfile({ model: 'BAAI/bge-m3', dim: 4 })
    expect(profile.dim).toBe(4)
    expect(profile.warnings).toEqual([])
  })

  it('已知模型 baai/bge-m3（大小写不敏感）解析为 1024 且无 warning', () => {
    for (const model of ['baai/bge-m3', 'BAAI/bge-m3', 'Baai/BGE-M3']) {
      const profile = resolveEmbeddingProfile({ model })
      expect(profile.dim, model).toBe(DEFAULT_EMBEDDING_DIM)
      expect(profile.dim, model).toBe(1024)
      expect(profile.warnings, model).toEqual([])
      // modelId 保留调用方原文，不悄悄改写成小写
      expect(profile.modelId, model).toBe(model)
    }
  })

  it('模型缺失时回落到默认模型 id 的已知维度，无 warning', () => {
    const profile = resolveEmbeddingProfile({})
    expect(profile.dim).toBe(1024)
    expect(profile.modelId).toBe('BAAI/bge-m3')
    expect(profile.warnings).toEqual([])
  })

  it('未知模型且无 dim → 1024 且恰好一条 warning', () => {
    const profile = resolveEmbeddingProfile({ model: 'some/unknown-model' })
    expect(profile.dim).toBe(1024)
    expect(profile.warnings).toHaveLength(1)
    expect(profile.warnings[0]).toContain('some/unknown-model')
    expect(profile.warnings[0]).toContain('embedding.dim')
  })

  it('显式 dim 8 + 已知模型 → 8 且无 warning（配置说了算）', () => {
    const profile = resolveEmbeddingProfile({ model: 'BAAI/bge-m3', dim: 8 })
    expect(profile.dim).toBe(8)
    expect(profile.warnings).toEqual([])
  })
})

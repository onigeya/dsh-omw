/**
 * 本体加载（Story 9.2 / AD-31、AD-40）：settings `ontology.path` → 一次同步读 + 解析 → 冻结索引。
 *
 * 三条纪律：
 * 1. **加载期一次**：本模块只在 apply 时调用；请求期不得重新读文件/解析（INV-17）。
 * 2. **失败不静默**：文件缺失 / 读失败 / 解析失败 / 空本体 ⇒ 返回结构化错误，调用方按
 *    AD-31 的「闸门不可用 ⇒ 整闸 fail-open + 告警 + status 可见」处理，**不得当成空本体**
 *    （空体会让六维拒绝全部候选，静默丢弃 100%）。
 * 3. **路径只来自 settings**：相对路径相对 profile 目录解析；不猜 `.sessions/`、不读第二位置。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { OntologyIndex } from './index.js'
import { OntologyParseError, parseOntologyTurtle, type OntologyEntry } from './turtle.js'

export interface LoadedOntology {
  readonly index: OntologyIndex
  readonly entries: readonly OntologyEntry[]
  readonly path: string
}

export type OntologyLoadResult =
  | { readonly ok: true; readonly value: LoadedOntology }
  /** 失败也带上解析后的绝对路径：status 要能显示「配置了哪个文件但不可用」。 */
  | { readonly ok: false; readonly reason: string; readonly path: string }

/**
 * 解析配置路径：未配置 ⇒ null（闸门 off，不加载）；相对路径相对 profile 目录。
 * 绝对路径原样使用（settings 指向 profile 内文件时通常是相对形式）。
 */
export function resolveOntologyPath(profileDir: string, configured: string | null | undefined): string | null {
  if (configured === null || configured === undefined) return null
  const trimmed = configured.trim()
  if (trimmed.length === 0) return null
  return isAbsolute(trimmed) ? trimmed : join(profileDir, trimmed)
}

/**
 * 读文件并解析。**同步**（AD-31 的 `n3` 同步 Parser + 加载期一次），调用方在 apply 阶段调用。
 *
 * 不抛错：任何失败都收敛成 `{ ok:false, reason }`，由调用方决定 fail-open 的告警与 status。
 */
export function loadOntologyFile(path: string): OntologyLoadResult {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code
    return { ok: false, reason: '本体文件不可读（' + String(code ?? 'read_failed') + '）：' + path, path }
  }
  try {
    const parsed = parseOntologyTurtle(text)
    return { ok: true, value: { ...parsed, path } }
  } catch (error) {
    const reason = error instanceof OntologyParseError ? error.message : '本体解析失败：' + String(error)
    return { ok: false, reason, path }
  }
}

/** 组合入口：路径解析 + 加载；未配置返回 `{ ok:true, value:null }`（off 是合法状态，不是错误）。 */
export function loadOntology(
  profileDir: string,
  configuredPath: string | null | undefined,
): { readonly ok: true; readonly value: LoadedOntology | null } | { readonly ok: false; readonly reason: string; readonly path: string } {
  const path = resolveOntologyPath(profileDir, configuredPath)
  if (path === null) return { ok: true, value: null }
  return loadOntologyFile(path)
}

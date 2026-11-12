/**
 * LLM Wiki 关系维护（Story 2.6 / FR-17、AD-4、AD-21）。
 *
 * 三件事，全部围绕「记忆进正式区时一次性决定关系」：
 * 1. `recallNeighbors`：临时直连 KNN（复用 memory_embedding_hnsw），给关系识别当邻接候选；
 *    Epic 3 的 RRF 内核落地后**只换实现、不动调用点**，故单独成函数而非内联。
 * 2. `identifyRelations`：一次 ctx.llm 调用，prompt 与输出 schema 同文件，输出
 *    `[{target_id, edge_type:'RELATED'|'EVIDENCE', reason?}]`（epics.md:763）。
 * 3. `applyRelations`：应用层校验后写 RELATED 边——**LLM 提议的 EVIDENCE 一律拒绝建边并记审计**
 *    （裁决 U4：EVIDENCE 的唯一写者是精炼结构，见 distill/processor.ts）。
 *
 * 校验口径（裁决 U5 + epics.md:773）：
 * - RELATED 同层（两端 layer 相等），跨层提议一律拒绝；
 * - 优先同 kind（排序权重，不是过滤）：同 kind 候选先于不同 kind，组内按 ANN distance 升序；
 * - 每条新记忆最多 5 条 RELATED 边（RELATED_MAX_EDGES）；
 * - 目标必须来自本次 recall 的邻接集（不信任 LLM 编造的 id）。
 *
 * 降级（AC:779-782、brief §5.1）：embedding 禁用或候选无向量 ⇒ **整体跳过 RELATED**，
 * 记忆照常进库；LLM 不可用 / 超时 / 输出不可解析 ⇒ 同样整体跳过。两种降级都落一条
 * `skip_related` 审计行，供 /memory status 可见。
 */
import type * as lbug from '@ladybugdb/core'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  CAPTURE_KIND,
  DEFAULT_CAPTURE_POLICY,
  REJECT_EVIDENCE_ACTION,
  SKIP_RELATED_ACTION,
  WRITE_RELATED_ACTION,
  insertGenerationLog,
} from '../db/audit.js'
import { readPinnedEmbeddingDim } from '../db/dedup.js'
import { writeRelatedEdges, type RelatedEdgeInput } from '../db/edges.js'
import { collectRows } from '../db/rows.js'
import { MEMORY_TABLE, META_TABLE, VECTOR_INDEX_NAME } from '../db/schema.js'
import { runInTransaction } from '../db/transaction.js'
import { foldStream } from '../distill/stream-fold.js'

/** 邻接召回条数（AC:763 写死 top-K=8）。 */
export const RELATION_RECALL_TOP_K = 8

/** 每条新记忆最多写出的 RELATED 边数（AC:773）。 */
export const RELATED_MAX_EDGES = 5

/** 关系识别 prompt 版本（与输出 schema 同文件、同版本号，改一个必须改另一个）。 */
export const RELATION_PROMPT_VERSION = '1'

/** 关系识别 LLM 调用预算：精炼 LLM 已吃 20s，总上界 30s，这里最多再拿 8s。 */
export const RELATION_LLM_TIMEOUT_MS = 8_000

/** 结构化输出统一 sentinel preamble（AGENTS.md §14）。 */
export const RELATION_SENTINEL_PREAMBLE =
  'Field descriptions are never valid values; set them to null'

/** embedding 缺失/禁用导致整体跳过 RELATED 的原因串。 */
export const SKIP_RELATED_EMBEDDING_REASON = 'embedding-disabled'

/** LLM 不可用 / 超时 / 输出不可解析导致整体跳过 RELATED 的原因串。 */
export const SKIP_RELATED_LLM_REASON = 'relation-llm-failed'

/** LLM 提议 EVIDENCE 被拒绝建边的原因串（裁决 U4）。 */
export const REJECT_EVIDENCE_REASON = 'llm-proposed-evidence'

export interface RecallNeighbor {
  readonly id: string
  readonly layer: string
  readonly kind: string
  /** ANN 距离 = 1 − cosine（越小越像）。 */
  readonly distance: number
}

export interface RecallNeighborsInput {
  /** 复用写入时已算的 embedding（AC:764），不重新发网络请求。 */
  readonly embedding: readonly number[]
  readonly k?: number
  readonly excludeId?: string
  readonly now: string
}

/** ANN 粗筛：谓词顺序照 dedup.ts 的锁定形态（WITH node, distance MATCH (node) WHERE …）。 */
const RECALL_STATEMENT = [
  "CALL QUERY_VECTOR_INDEX('" + MEMORY_TABLE + "', '" + VECTOR_INDEX_NAME + "', $q, $k)",
  'WITH node, distance',
  'MATCH (node)',
  'WHERE node.valid_at <= $now AND node.recorded_at <= $now',
  '  AND node.invalid_at IS NULL AND node.expired_at IS NULL',
  'RETURN node.id AS id, node.layer AS layer, node.kind AS kind, distance',
  'ORDER BY distance',
].join('\n')

async function queryRows(
  connection: lbug.Connection,
  statement: string,
  params: Record<string, lbug.LbugValue>,
): Promise<Record<string, unknown>[]> {
  const prepared = await connection.prepare(statement)
  return collectRows(await connection.execute(prepared, params))
}

/**
 * 临时直连 KNN（brief §5.1）：不经 Epic 3 的 RRF 融合，不新增索引、不新增存储。
 * embedding 为空 / 库内未 pin 维度 / k 非正 ⇒ 返回空数组（调用方据此整体跳过 RELATED）。
 */
export async function recallNeighbors(
  connection: lbug.Connection,
  input: RecallNeighborsInput,
): Promise<RecallNeighbor[]> {
  const k = Math.max(0, Math.trunc(input.k ?? RELATION_RECALL_TOP_K))
  if (k === 0 || input.embedding.length === 0) return []
  const dim = await readPinnedEmbeddingDim(connection)
  if (dim === null || dim !== input.embedding.length) return []
  const rows = await queryRows(connection, RECALL_STATEMENT, {
    q: [...input.embedding],
    k,
    now: input.now,
  })
  const neighbors: RecallNeighbor[] = []
  for (const row of rows) {
    const id = String(row.id)
    if (input.excludeId !== undefined && id === input.excludeId) continue
    neighbors.push({
      id,
      layer: String(row.layer)
      ,
      kind: row.kind === null || row.kind === undefined ? '' : String(row.kind),
      distance: Number(row.distance ?? Number.POSITIVE_INFINITY),
    })
  }
  return neighbors.slice(0, k)
}

export interface RelationProposal {
  readonly targetId: string
  readonly edgeType: 'RELATED' | 'EVIDENCE'
  readonly reason: string | null
}

/** 输出 schema 与 prompt 同文件保存（AGENTS.md §14：改 prompt 必须同步改 schema）。 */
export const RELATION_OUTPUT_SCHEMA = JSON.stringify([
  { target_id: 'string', edge_type: 'RELATED | EVIDENCE', reason: 'string | null' },
])

export const RELATION_INSTRUCTION = [
  '你是记忆关系识别器。给定一条新记忆与若干邻接候选，判断新记忆与哪些候选存在语义关系。',
  '只允许输出 JSON 数组，元素形如 {"target_id": string, "edge_type": "RELATED", "reason": string|null}。',
  '- edge_type 只允许 RELATED 或 EVIDENCE 两个字面值；',
  '- target_id 必须来自候选列表，不得编造；',
  '- 同层语义关联用 RELATED；跨层证据关系用 EVIDENCE；',
  '- 没有关系时输出空数组 []。',
].join('\n')

export interface RelationCandidate {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly text: string
}

export function buildRelationMessages(candidate: RelationCandidate, neighbors: readonly RecallNeighbor[]): RequestMessage[] {
  const instruction = [
    RELATION_SENTINEL_PREAMBLE,
    '',
    RELATION_INSTRUCTION,
    '',
    '输出 JSON schema：',
    RELATION_OUTPUT_SCHEMA,
    '',
    '新记忆：' + JSON.stringify({ id: candidate.id, layer: candidate.layer, kind: candidate.kind, text: candidate.text }),
    '邻接候选：' + JSON.stringify(neighbors.map((n) => ({ id: n.id, layer: n.layer, kind: n.kind }))),
  ].join('\n')
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}

/** 只用到 ctx.llm.stream 的结构端口（运行期不 import 宿主的任何值）。 */
export interface RelationLlmPort {
  stream(options: {
    provider: string
    model: string
    messages: RequestMessage[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

export interface RelationRoute {
  readonly provider: string
  readonly model: string
}

/** LLM 输出的原始元素形状（snake_case，与 schema 字面一致）。 */
interface RawProposal {
  readonly target_id: string
  readonly edge_type: 'RELATED' | 'EVIDENCE'
  readonly reason?: string | null
}

function isProposal(value: unknown): value is RawProposal {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const targetId = record.target_id
  const edgeType = record.edge_type
  if (typeof targetId !== 'string' || targetId.length === 0) return false
  if (edgeType !== 'RELATED' && edgeType !== 'EVIDENCE') return false
  const reason = record.reason
  return reason === undefined || reason === null || typeof reason === 'string'
}

/** 解析 LLM 的关系输出；非数组 / 元素不合法 ⇒ null（调用方整体跳过）。 */
export function parseRelationOutput(text: string): RelationProposal[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: RelationProposal[] = []
  for (const item of parsed) {
    if (!isProposal(item)) continue
    out.push({
      targetId: item.target_id,
      edgeType: item.edge_type,
      reason: item.reason ?? null,
    });
  }
  return out
}

export interface RelationSelection {
  /** 通过应用层校验、可写边的 RELATED 目标（按同 kind 优先 + 距离升序排好，≤5 条）。 */
  readonly accepted: readonly RelatedEdgeInput[];
  /** LLM 提议的 EVIDENCE（裁决 U4：一律拒绝建边，只记审计）。 */
  readonly rejectedEvidence: readonly string[];
  /** 其它被拒的提议：目标不在邻接集 / 跨层 / 超出 5 条上限。 */
  readonly rejectedOther: readonly string[];
}

/**
 * 应用层校验（不信任 LLM 输出）：目标必须来自邻接集、同层、同 kind 优先、最多 5 条。
 * 纯函数——写库前可单测。
 */
export function selectRelatedTargets(
  candidate: { readonly id: string; readonly layer: string; readonly kind: string },
  proposals: readonly RelationProposal[],
  neighbors: readonly RecallNeighbor[],
): RelationSelection {
  const byId = new Map(neighbors.map((neighbor) => [neighbor.id, neighbor]))
  const accepted: RelatedEdgeInput[] = []
  const rejectedEvidence: string[] = []
  const rejectedOther: string[] = []
  const seen = new Set<string>()
  const ranked: { readonly target: RecallNeighbor; readonly reason: string | null }[] = []
  for (const proposal of proposals) {
    if (proposal.edgeType === 'EVIDENCE') {
      rejectedEvidence.push(proposal.targetId)
      continue
    }
    const target = byId.get(proposal.targetId)
    if (target === undefined || target.id === candidate.id) {
      rejectedOther.push(proposal.targetId)
      continue
    }
    if (target.layer.trim() !== candidate.layer.trim()) {
      rejectedOther.push(proposal.targetId)
      continue
    }
    if (seen.has(target.id)) continue
    seen.add(target.id)
    ranked.push({ target, reason: proposal.reason });
  }
  ranked.sort((a, b) => {
    const sameKindA = a.target.kind === candidate.kind ? 0 : 1
    const sameKindB = b.target.kind === candidate.kind ? 0 : 1
    if (sameKindA !== sameKindB) return sameKindA - sameKindB
    return a.target.distance - b.target.distance
  });
  for (const entry of ranked) {
    if (accepted.length >= RELATED_MAX_EDGES) {
      rejectedOther.push(entry.target.id)
      continue
    }
    accepted.push({ fromId: candidate.id, toId: entry.target.id, reason: entry.reason });
  }
  return { accepted, rejectedEvidence, rejectedOther }
}

export interface IdentifyRelationsInput {
  readonly llm: RelationLlmPort
  readonly route: RelationRoute
  readonly candidate: RelationCandidate;
  readonly neighbors: readonly RecallNeighbor[]
  readonly signal: AbortSignal
  readonly maxTokens?: number
}

export type IdentifyRelationsResult =
  | { readonly ok: true; readonly proposals: readonly RelationProposal[] }
  | { readonly ok: false; readonly reason: string; readonly message: string }

/** 一次关系识别 LLM 调用（单次尝试，重试不在本次尝试内——与精炼同纪律）。 */
export async function identifyRelations(input: IdentifyRelationsInput): Promise<IdentifyRelationsResult> {
  if (input.neighbors.length === 0) return { ok: true, proposals: [] }
  let folded: { text: string }
  try {
    folded = await foldStream(
      input.llm.stream({
        provider: input.route.provider,
        model: input.route.model,
        messages: buildRelationMessages(input.candidate, input.neighbors),
        maxTokens: input.maxTokens ?? 1024,
        signal: input.signal,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: SKIP_RELATED_LLM_REASON, message }
  }
  const proposals = parseRelationOutput(folded.text.trim())
  if (proposals === null) {
    return { ok: false, reason: SKIP_RELATED_LLM_REASON, message: '模型输出不是合法 JSON 数组' }
  }
  return { ok: true, proposals }
}

/** 一条关系写入的审计行（skip / reject / write 三种动作复用同一形状）。 */
async function insertRelationAudit(
  connection: lbug.Connection,
  candidateId: string,
  action: string,
  outcome: 'success' | 'failure' | 'uncertain',
  reason: string | null,
  now: string,
): Promise<void> {
  await insertGenerationLog(connection, {
    recordedAt: now,
    actor: 'system',
    kind: CAPTURE_KIND,
    action,
    policy: DEFAULT_CAPTURE_POLICY,
    l0Refs: [candidateId],
    outcome,
    reason,
  })
}

export interface ApplyRelationsResult {
  readonly written: number
  readonly skippedReason: string | null
  readonly rejectedEvidence: number
}

/**
 * 应用层校验 + 写边 + 记账，全部在一个事务里（AD-10：先写日志后写状态）。
 * 任何一步失败都**不回滚已提交的记忆**——本函数的调用点在 L1 事务之外（AC:779-782）。
 */
export async function applyRelations(
  connection: lbug.Connection,
  args: {
    readonly candidate: { readonly id: string; readonly layer: string; readonly kind: string }
    readonly proposals: readonly RelationProposal[]
    readonly neighbors: readonly RecallNeighbor[]
    readonly now: string
  },
): Promise<ApplyRelationsResult> {
  const selection = selectRelatedTargets(args.candidate, args.proposals, args.neighbors)
  let written = 0
  await runInTransaction(connection, async () => {
    for (const targetId of selection.rejectedEvidence) {
      await insertRelationAudit(
        connection,
        args.candidate.id,
        REJECT_EVIDENCE_ACTION,
        'uncertain',
        REJECT_EVIDENCE_REASON + ': target=' + targetId,
        args.now,
      )
    }
    if (selection.accepted.length > 0) {
      written = await writeRelatedEdges(connection, selection.accepted)
      await insertRelationAudit(
        connection,
        args.candidate.id,
        WRITE_RELATED_ACTION,
        'success',
        'edges=' + String(written) + (selection.rejectedOther.length > 0 ? ' rejected=' + String(selection.rejectedOther.length) : ''),
        args.now,
      )
    }
  })
  return {
    written,
    skippedReason: null,
    rejectedEvidence: selection.rejectedEvidence.length,
  }
}

/** 整体跳过 RELATED 的唯一记账入口（embedding 禁用 / LLM 失败 / 无邻接）。 */
export async function recordRelatedSkip(
  connection: lbug.Connection,
  candidateId: string,
  reason: string,
  now: string,
): Promise<void> {
  await runInTransaction(connection, () =>
    insertRelationAudit(connection, candidateId, SKIP_RELATED_ACTION, 'uncertain', reason, now),
  )
}

/** `/memory status` 用的计数：被跳过/拒绝的关系写入条数（AD-21：必须可见）。 */
export async function countRelatedSkips(connection: lbug.Connection): Promise<number> {
  const rows = await queryRows(
    connection,
    'MATCH (g:' + 'generation_log' + " {action: '" + SKIP_RELATED_ACTION + "'}) RETURN count(*) AS c",
    {},
  )
  return Number(rows[0]?.c ?? 0)
}

/** 一个 L1 节点进入关系识别的输入（embedding 来自写时嵌入，不重算）。 */
export interface RelationEntry {
  readonly id: string
  readonly layer: string
  readonly kind: string
  readonly text: string
  readonly embedding: readonly number[] | null
}

export interface RelationRunnerInput {
  /** 来源 INBOX 条目 id（审计的 l0Refs 与 candidate 行）。 */
  readonly itemId: string
  readonly route: RelationRoute
  readonly entries: readonly RelationEntry[]
  readonly now: string
  /** 精炼任务的总预算 signal（关系识别跟随它，AC:782）。 */
  readonly signal: AbortSignal
}

export type RelationRunner = (input: RelationRunnerInput) => Promise<void>

export interface RelationRunnerOptions {
  readonly connection: () => lbug.Connection | null
  readonly llm: RelationLlmPort
  /** embedding 是否可用（enabled 且有 model）。false = 整体跳过 RELATED 并记一条审计。 */
  readonly embeddingEnabled: boolean
  readonly logger?: { warn(message: string): void }
  /** 关系识别的子预算；缺省 RELATION_LLM_TIMEOUT_MS。 */
  readonly llmTimeoutMs?: number
}

/**
 * 生产用的关系跑者：在每个新 L1 节点上跑一次 KNN + LLM 识别 + 应用层校验 + 写边。
 *
 * 调用点在精炼事务**之外**（AC:779-782：关系失败不影响记忆进库）。逐节点串行，
 * 首个 LLM 失败即整体中止（同一次故障没必要每个节点各等一份超时），并落一条 skip 审计。
 */
export function createRelationRunner(options: RelationRunnerOptions): RelationRunner {
  const llmTimeoutMs = Math.max(1, Math.trunc(options.llmTimeoutMs ?? RELATION_LLM_TIMEOUT_MS))
  return async (input: RelationRunnerInput): Promise<void> => {
    const connection = options.connection()
    if (!connection) return
    if (!options.embeddingEnabled) {
      // 降级：embedding 禁用 ⇒ 整体跳过 RELATED，记忆照常进库；必须可见（AC:779-782 / brief §5.1）。
      await recordRelatedSkip(connection, input.itemId, SKIP_RELATED_EMBEDDING_REASON, input.now)
      return
    }
    for (const entry of input.entries) {
      if (input.signal.aborted) return
      const embedding = entry.embedding
      if (embedding === null || embedding.length === 0) {
        // 本节点没有向量（写时嵌入失败）：只跳过它，其余节点照常。
        await recordRelatedSkip(connection, input.itemId, SKIP_RELATED_EMBEDDING_REASON + ': node=' + entry.id, input.now)
        continue
      }
      try {
        const neighbors = await recallNeighbors(connection, {
          embedding,
          k: RELATION_RECALL_TOP_K,
          excludeId: entry.id,
          now: input.now,
        })
        // 没有邻接候选 = 没有关系可写，不是降级，不记 skip 审计。
        if (neighbors.length === 0) continue
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(llmTimeoutMs)])
        const identified = await identifyRelations({
          llm: options.llm,
          route: input.route,
          candidate: { id: entry.id, layer: entry.layer, kind: entry.kind, text: entry.text },
          neighbors,
          signal,
        })
        if (!identified.ok) {
          await recordRelatedSkip(connection, input.itemId, identified.reason + ': ' + identified.message, input.now)
          return
        }
        await applyRelations(connection, {
          candidate: { id: entry.id, layer: entry.layer, kind: entry.kind },
          proposals: identified.proposals,
          neighbors,
          now: input.now,
        })
      } catch (error) {
        // 关系写入是 best-effort：绝不让它把已提交的记忆拖成失败（AC:779-782）。
        const message = error instanceof Error ? error.message : String(error)
        options.logger?.warn('关系识别/写入失败（node=' + entry.id + '）：' + message)
      }
    }
  }
}
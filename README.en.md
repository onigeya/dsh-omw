# dsh-oh-my-whale

One line: **a memory pipeline that grows its own memory for DeepSeek Harness** — Zettelkasten atomic memory + LLM Wiki relation graph + SCD-2 bitemporal graph storage, with capture, refinement, recall and governance all running on a local database.

> [中文](README.md) | English

## What it is

`dsh-oh-my-whale` installs a memory plugin into the DSH host. Three layers:

| Layer | Content | Written by |
|---|---|---|
| **L0** | Raw stream (conversation slices, observations). Append-only, never rewritten | Capture hooks (`turn/start`, `turn/end`, …) |
| **L1** | Atomic facts (one preference, one decision, one constraint) | LLM refinement of the INBOX queue / `memory_remember` / `/memory remember` |
| **L2** | Consolidated statements (synthesis over several L1 facts) | L1→L2 promotion (quality gate + faithfulness check) |

- **Zettelkasten atomic memory**: one fact per node; the node id is a content fingerprint, so writing the same content twice does not create a duplicate.
- **LLM Wiki**: nodes are linked by typed edges — `EVIDENCE` (lower evidence → upper conclusion) and `RELATED` (same-layer semantic links).
- **SCD-2 bitemporal**: every memory carries both when the fact holds (`valid_at` / `invalid_at`) and when it was recorded (`recorded_at`); deletion is soft (`expired_at`), so history stays reconstructable.

## Install

### Once published on npm

```bash
dsh plugin --profile <name> add dsh-oh-my-whale
```

`dsh-oh-my-whale` is the host **bundle package**; it registers the real plugin `dsh-oh-my-whale-memory` into the profile through `cordis.patch.yml`. Verify the patch layer landed without starting the host:

```bash
dsh --profile <name> --dump-config
```

### From local tarballs (the repo is not published yet)

```bash
pnpm -r build
pnpm --dir packages/dsh-oh-my-whale-memory pack --pack-destination ./packs
pnpm --dir packages/dsh-oh-my-whale pack --pack-destination ./packs
```

Then point the memory dependency at the local tarball in the target profile's `pnpm-workspace.yaml` (the bundle's `workspace:*` becomes a version that does not exist on the registry once packed):

```yaml
overrides:
  dsh-oh-my-whale-memory: "file:<absolute-path>/dsh-oh-my-whale-memory-0.1.0.tgz"
allowBuilds:
  "@ladybugdb/core": true
```

Finally run `dsh plugin --profile <name> add <absolute-path>/dsh-oh-my-whale-0.1.0.tgz`. The repo ships `node scripts/publish-smoke.mjs`, which drives exactly this path and writes a log.

## Configuration

Configuration lives in the host settings namespace **`dsh-oh-my-whale-memory`** (editable in `/settings`, or written through the profile patch layer). Credential fields are always named `token`; the table below uses placeholders — put in your own values.

| Field | Default | Meaning |
|---|---|---|
| `embedding.endpoint` | — | Embedding service URL (OpenAI-compatible `/embeddings`) |
| `embedding.token` | — | Embedding credential; missing it (or `model`) degrades recall to **keyword-only** |
| `embedding.model` | — | Embedding model name; changing it must match the dimension or startup fails loudly |
| `embedding.dim` | — | Vector dimension, pinned in the database at creation; cannot change later (migrate or rebuild) |
| `rerank.endpoint` / `rerank.token` / `rerank.model` | — | Rerank configuration (v1 placeholder: schema exists, runtime does **not** use it) |
| `captureSteps` | `50` | Take an L0 snapshot every N conversation steps |
| `inboxRefineConcurrency` | `4` | Concurrent refinement consumers |
| `injectOnNewSession` | `true` | Inject a memory summary at the start of a new session |
| `rrfK` | `60` | RRF k for hybrid retrieval |
| `retrievalTopK` | `50` | Candidates per retrieval path |
| `layerWeights.l2` / `layerWeights.l1` | `0.7` / `0.4` | Layer weights (L2 conclusions outrank L1 evidence) |
| `priorityWeight` | `0.5` | Secondary priority weighting (`priority: -1` is a global strong rule, always on top) |
| `llmProvider` / `llmModel` | — | Model channel for refinement and judging (`ctx.llm`; the plugin brings no key) |
| `systemOne.enabled` / `.endpoint` / `.model` / `.token` | `true` | Faithfulness-check channel; when unavailable the plugin falls back to `ctx.llm` |

Example (placeholders, not real credentials):

```yaml
embedding:
  endpoint: https://api.example.com/v1
  token: sk-****
  model: bge-m3
  dim: 1024
```

## Slash commands

The single source of truth is PRD §11.2 — 9 commands. The command is `memory` (lowercase, no leading slash); in a session you write `/memory <subcommand>`.

| Command | Purpose | Status |
|---|---|---|
| `/memory status` | Memory health view: layer counts, both INBOX depths, dead letters, `audit_gap`, `evidence_gap`, `evidence_degraded`, embedding / System One degradation, read-only reason, backlog age and last refinement time, storage backend | Implemented |
| `/memory recall <query>` | Hybrid retrieval (semantic vectors + keywords, RRF fusion) | Implemented |
| `/memory related <id> [depth]` | Traverse neighbours over evidence links and semantic relations (1–3 hops, at most 20) | Implemented |
| `/memory show <id>` | Show every field of one memory (including invalidated tombstones) | Implemented |
| `/memory list [query]` | List recent memories (literal substring match, 20 by default) | Implemented |
| `/memory remember [--kind=..] [--priority=..] <content>` | Manually write one L1 memory | Implemented |
| `/memory forget <id> [--redact]` | Soft-delete a memory and cascade-invalidate its dependents; `--redact` also replaces the L0 raw text on its evidence chain with a tombstone and marks `evidence_degraded` | Implemented |
| `/memory resolve <id>` | Resolve an `await-confirmation` conflict (accept new value / keep both) | Planned (not implemented, Epic 7) |
| `/memory strategy` | List strategy candidates and adoption-gate results | Planned (not implemented, Epic 7) |

## Model tools

The single source of truth is PRD §11.1 — 6 tools, callable by the agent.

| Tool | Purpose | Status |
|---|---|---|
| `memory_remember` | Write one long-lived L1 fact (same content is idempotent, no duplicate node) | Implemented |
| `memory_recall` | Hybrid semantic + keyword recall, returning layer/kind/priority per hit | Implemented |
| `memory_related` | Graph traversal from one memory to its neighbours | Implemented |
| `memory_forget` | **Only** returns `confirmation_required` plus a summary; there is no agent-side execution path — confirmation happens through the user's `/memory forget` | Implemented |
| `memory_status` | Structured form of status (counts instead of prose) | Planned (not implemented) |
| `memory_expand` | Expand a collapsed handle `[omw:handle=<id> ~<n> tokens]` back to the full content, byte-for-byte | Planned (not implemented, Epic 8) |

Recall tools (`memory_recall` + `memory_related`, plus `memory_expand` later) share a **3 calls per turn** quota.

## Read-only mode and degradation

Design rule: **degradation must be visible, never a silent no-op**.

- **Single writer**: only one window per profile holds the writer lock. A second window drops to **read-only**: no capture, no refinement, writes rejected. `/memory status` shows `readonly: true, reason: '...'`, and `/memory remember` / `/memory forget` return an explicit read-only error.
- **Embedding unavailable** (`endpoint` / `token` / `model` missing): recall falls back to **keyword-only**, results are marked `degraded`, and `/memory status` shows `embedding: disabled（降级检索）`. Refinement still writes L1, just without vectors (those nodes show up as `未嵌入 N 条`).
- **System One unavailable**: the faithfulness check falls back to `ctx.llm`; `/memory status` shows `systemOne: degraded` or `disabled-by-config`.
- **Database not ready / no profile**: commands return a readable error, tools return a `db_unavailable` envelope (never throw, never silently return empty).
- **Dimension mismatch** (switching embedding models): startup fails loudly; the database is not rebuilt and nothing degrades silently.
- **Credential hygiene**: credentials exist only in the embedding / systemOne `token` fields (schema marks `role: secret`); they never reach logs, events or the audit ledger.

## Development and verification

```bash
pnpm install
pnpm verify            # constraints → typecheck → check:deps → check:migrations → test
pnpm test:coverage     # coverage summary (coverage/coverage-summary.json)
pnpm check:coverage    # per-file coverage ratchet (must not drop below scripts/coverage-baseline.json)
pnpm pack:smoke        # publish form: exact tarball content assertions
node scripts/publish-smoke.mjs   # end-to-end publish smoke (temp profile → install → dump-config → remove)
pnpm test:e2e          # Playwright + a real dsh web (needs local dsh and chromium)
```

Requirements: Node ≥ 24.9.0, pnpm 12.18.0. On Windows the tests need OpenSSL 3 on `PATH` (for example `C:\Program Files\Git\mingw64\bin`), otherwise LadybugDB's vector/fts extensions fail to load.

Package details: [`packages/dsh-oh-my-whale/README.md`](packages/dsh-oh-my-whale/README.md) and [`packages/dsh-oh-my-whale-memory/README.md`](packages/dsh-oh-my-whale-memory/README.md).

## License

[MIT](LICENSE) © 2026 DSH Oh My Whale contributors

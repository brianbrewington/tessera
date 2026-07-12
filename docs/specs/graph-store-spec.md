# Spec — Graph Store (tessera's sole writable authority)

*Isolated implementation spec. **Build from this document alone** — no dependency on any prior-prototype code.
Derived from `plan-v3.md` §3–§4. This is the contract every other module (Ingest, Embedder, Connector,
Resonator, Dream, Viewer) is a client of. Status: **draft for the reviewer gate** (Codex + Grok + blind-Claude +
local). Reviewers: I like / I wish / I wonder; prefer concrete failure scenarios.*

## 1. Purpose & boundaries

The Graph Store is the **single source of truth** for tessera's typed idea-graph and the **only** component that
writes it. It owns: nodes, edges, edge-assertions, their vector indices, the `proposed→durable` status
lifecycle, prominence, provenance, and the mutation log. Everything else reads/writes **only** through its API.

**It does NOT:** ingest files, discover connections, run dreams, cluster, or render. It does **not** compute
embeddings itself — embedding is an **injected dependency** (`Embedder` interface), so the Store owns vector
*storage* but not the model call.

## 2. Stack & storage

- **TypeScript**, single process (per plan-v3 all-TS decision).
- **SQLite** (one file, the portable source of truth) via **better-sqlite3** (synchronous, single-process).
- **sqlite-vec** for vector search.
- **WAL mode, single writer.** All mutations serialize through one writer connection; reads may use additional
  read-only connections. No method returns mutable internal state — return copies/DTOs.
- The validation/decode path (any JSON in/out of columns) is a **heavily-tested, non-negotiable invariant**
  (Zod/TypeBox schema at every boundary).

## 3. Data model (owned tables)

- **`nodes`**: `id` (uuid), `type` (enum, §plan-v3 §4), `subtype`, `text`, `strength` (raw, float),
  `timestamp`, `provenance` (json: source refs), `metadata` (json), `status` (`proposed|durable`),
  `pinned` (bool, non-decaying), `version` (int, optimistic concurrency). For `SOURCE`:
  `last_observed`, `observation_budget` (kept **separate from `strength`**).
- **`edges`**: `id`, `from_id`, `to_id`, `kind` (`RELATED|ORIGINATED_FROM|APPEARED_IN|HEBBIAN_ASSOC|RESONATES_WITH`),
  `polarity` (`null|elaborates|supports|contradicts|depends_on`), `semantic_weight` (immutable cosine),
  `hebbian_weight` (learned), `status`, `version`. **`semantic_weight` and `hebbian_weight` never overwrite each other.**
- **`edge_assertions`**: `id`, `edge_id`, `reason` (names both endpoints), `origin` (`connector|dream|user`),
  `grounding` (json: citation spans), `expert_surprise` (int 0–3, **computed structurally or by a separate
  critic — never self-scored by the generating model**), `status`.
- **Vectors — two tiers** (the load-bearing fix): every node/edge-assertion embedding is **always written to the
  `quarantine` vector index**; the **`shared` (retrieval) index receives a vector ONLY via `promote`.**
  Implement as two sqlite-vec virtual tables (`vec_quarantine`, `vec_shared`) keyed by node/assertion id.
- **`patterns`**: cluster-summary nodes; `sticky_id`, `lineage` (which cluster/version/run produced it).
- **`mutation_log`**: `event_id`, `ts`, `actor`, `cause`, `op`, `target_id`, `before`, `after` — append-only,
  for deterministic replay + audit.

## 4. API (verbs)

Every write logs to `mutation_log` and bumps `version`.

- `upsertNode(node, {actor, cause}) → {id, reinforced: bool}` — dedup on cosine **> 0.99** against the
  **quarantine** index; if match, **reinforce** the existing node (strength += boost, capped) instead of
  creating — **idempotent** (re-ingest must not inflate prominence past the cap); else create. Always compute
  (via `Embedder`) + write embedding to **quarantine**. New nodes default `status=proposed` unless `origin=user`.
- `proposeNode(node)` / `proposeEdge(edge, assertion)` — create with `status=proposed` (quarantine embedding only).
- **`promote(id, grounding, {actor, cause}) → PromoteResult`** — **the central trust operation.** Validates
  grounding by origin: `connector` → citation 3-layer check; `dream` → human-`apt` OR N independent resurfacings;
  `user` → immediate. On success: `status→durable`, **copy embedding quarantine→shared**, count toward
  prominence + Hebbian. **Store-internal circuit breaker** over ALL promotions: sampled hallucination
  **>5% pauses auto-promotion, >10% disables proposal indexing** (returns a typed `BreakerTripped`).
- `link(from, to, {kind, polarity, reason, origin})` — create an edge + assertion (proposed by default).
- `querySimilar(embedding, k, filters, index: 'quarantine'|'shared') → Node[]|Edge[]` — vector search against
  the chosen tier. Connector/dedup read **quarantine**; RAG/viewer read **shared**.
- **`getTile(zoom, bbox, filters) → Subgraph`** — the LOD slice: nodes whose **rank-normalized prominence**
  clears the **top-N budget for that zoom** within the tile, plus their edges. (NOT `min_strength` — absolute
  strength can't tile a pyramid.)
- `reinforce(id, delta)` · `decay()` (lazy, computed on access — no background sweep) · `prune()` (GC:
  unpromoted `proposed` nodes past their τ are removed) · `export(format) → blob`.
- Reads: `getNode(id)`, `getEdges(nodeId)`, `query(...)`.

## 5. Invariants (the hard contract — what the tests enforce)

1. **Single writer + WAL;** no method returns mutable internal state.
2. **Embeddings always computed → quarantine; `shared` index populated ONLY by `promote`.** "Not embedded"
   means "not in the shared/retrieval index," never "no vector exists."
3. **`promote` is the only path to `durable`;** the circuit breaker is Store-internal over all promotions.
4. **Every mutation logged** (`event_id, actor, cause`) → deterministic replay reproduces the graph.
5. **Prominence is rank-normalized within a tile** (top-N per zoom), never an absolute threshold.
6. **Optimistic concurrency via `version`** — a stale write is rejected, never silently clobbers.
7. **Re-ingest idempotency** — re-`upsertNode` of the same content dedup-reinforces (capped), never inflates.

## 6. Prominence & tiling

`S_raw = S_last · exp(-Δt/τ)` (τ per type/mode: SESSION`dream`≈10min, MEMORY≈7d, CONCEPT≈1yr), computed on
access. **Elevation = `rank(S_raw)` within a tile/cluster**, and `getTile` returns the **top-N per zoom level**
— a fixed elevation budget. Pattern `sticky_id`s keep zoom-out geography stable across runs.

## 7. Required tests (the review gate must see these pass)

- Contract test per verb (happy path + error).
- **Two-tier chicken-and-egg:** a `proposed` node IS returned by `querySimilar(..., 'quarantine')` but NOT by
  `querySimilar(..., 'shared')`; after `promote`, it appears in `shared`. (This is *the* fix — test it explicitly.)
- **`promote` breaker:** with a seeded hallucination rate >5%, auto-promotion pauses; >10% disables proposal indexing.
- **Re-ingest idempotency:** upsert the same 3 notes twice → node count unchanged, strength within the reinforce cap.
- **No mutable state:** `getNode(id)` returns a copy; mutating it does not change the store.
- **Deterministic replay:** replay `mutation_log` into a fresh Store → identical graph (hash-equal).
- **Tiling:** `getTile` returns top-N by rank per zoom; pattern ids stable across two runs on the same data.
- **Schema migration:** a v1→v2 migration test (the persistent graph *will* change schema mid-build).

## 8. Open questions for reviewers

- Two sqlite-vec tables vs. one table + `tier` column + a view — which is cleaner and avoids double-writes?
- Where does the `Embedder` boundary sit — injected into the Store, or does the Store take pre-computed vectors
  and stay embedding-agnostic entirely? (Leaning: injected interface, so the two-tier write is atomic with the node.)
- `getTile` cost: rank-within-tile needs a per-tile top-N — precompute per zoom on write, or compute on read
  over the dirty set? What keeps it O(tile), not O(n)?
- Circuit-breaker sampling: how is the "hallucination rate" measured cheaply enough to gate every promote?

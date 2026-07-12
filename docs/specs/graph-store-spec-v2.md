# Spec — Graph Store v2 (hardened by the full-fleet gate)

*Isolated implementation spec — **build from this alone.** v2 folds the four-reviewer gate (Codex, Grok,
blind-Claude, local; raw in `reviews/`) into v1. Tests are **part of the spec** (§7) — the reviewers' demonstrated
failing sequences ARE the tests (the flipside of demonstrate-don't-describe). Decisions locked with Brian:
tiling = **(A) fixed budget per tile** + **upward K-promotion** (§6); Embedder = injected *and* accepts a
pre-computed vector (§8.2); `get_tile` = compute-on-read over a top-2N cache (§6, §8.3).*

## 1. Purpose & boundaries

Sole writable authority for tessera's typed graph. Owns nodes, edges, edge-assertions, their **two-tier** vector
indices, the `proposed→durable` lifecycle, prominence, the pyramid, provenance, the mutation log, and
backup/restore. Everything else is a client of its API. It does **not** ingest, connect, dream, cluster-layout
(the Resonator writes layout via the API), or render.

**Embedder boundary (resolves the v1 §1↔§4 contradiction):** the Store is given an injected `Embedder` for the
live path, **and** every write verb also accepts an optional pre-computed `vector` (used by Ingest batch-embed
and by replay). A write with neither is an error. The Store owns vector *storage*, atomically with the row.

## 2. Stack & storage

TypeScript, single process, **SQLite (one file) via better-sqlite3**, **sqlite-vec**. **WAL, single writer**
(one writer connection; reads may use read-only connections). No verb returns mutable internal state (DTO copies
only). One validated decode path (Zod) at every boundary — heavily tested, non-negotiable.

## 3. Data model

- **`nodes`**: `id, type(+subtype), origin('user'|'connector'|'dream'|'ingest'), text, content_hash, strength,
  timestamp, provenance(json), metadata(json), status('proposed'|'durable'), pinned(bool), version(int)`.
  For SOURCE: `last_observed, observation_budget` (separate from `strength`). **`origin` is on the node** (v1
  keyed a rule on a field the verb couldn't see).
- **`layout`**: `node_id, x, y, tile_id, zoom_min, version` — written only via `putLayout` (Resonator client).
  Nodes have coordinates so `get_tile(bbox)` means something.
- **`edges`**: `id, from_id, to_id, kind, polarity, semantic_weight(immutable), hebbian_weight, status, version`.
  **UNIQUE `(from_id, to_id, kind, polarity)`** — edges are idempotent (v1 had none).
- **`edge_assertions`**: `id, edge_id, reason, origin, grounding(json), expert_surprise(int, Store-computed),
  status, version`.
- **Vectors — four tiers, split by kind (never co-mingled):** `vec_node_quarantine`, `vec_node_shared`,
  `vec_assert_quarantine`, `vec_assert_shared`. Every embedding is written to its *quarantine* table; a **`promote`
  transaction** copies it to the matching *shared* table. `querySimilar` returns a **discriminated union**
  (`kind` on every hit) so callers can hydrate from the right table.
- **`mutation_log`**: `event_id, effective_at, actor, cause, op, target_id, before, after` — append-only. `after`
  carries **column bytes incl. the vector blob (or a content-addressed ref)** so replay never calls Embedder.
- **`breaker_state`**: `window_size, good_count, bad_count, state, last_transition` — the breaker is data, not a
  guess.
- **`pyramid`**: per zoom level, `tile_id → node_id, rank, promoted_from(child_tile)` — the top-2N cache (§6).

## 4. API (verbs)

Every mutating verb takes `{actor, cause}` (mandatory — v1 dropped it on some) and logs. Write verbs take a
`vector?` (else the Store embeds).

**One write family** (v1's `upsertNode`/`proposeNode`/`link` overlapped):
- `putNode(input, meta) → {id, reinforced}` — always lands `proposed`, embed → node-quarantine. **Dedup primary
  key = `content_hash` (normalized text) / provenance ref; cosine >0.99 is a *secondary* near-dup merge** (v1's
  cosine-only dedup drifts below 0.99 on a real/upgraded embedder → duplicate → prominence doubles). On dedup:
  reinforce, do NOT create.
- `putEdge(from, to, {kind, polarity, reason, origin}, meta)` — upsert edge on `(from,to,kind,polarity)`; attach
  a new assertion to the existing edge (idempotent); embed reason → assert-quarantine. **`expert_surprise` is
  computed by the Store** (pre-edge embedding/hop distance) — never accepted from the caller (the generating
  model must not launder surprise through the sole authority).
- `putLayout(nodeId, {x, y, zoom_min}, {expectedVersion}, meta)` — Resonator writes coordinates.

**Graduation (the only path to `durable`):**
- `promoteNode(nodeId, grounding, meta)` and `promoteAssertion(assertionId, grounding, meta)` — split (v1's
  single `promote(id)` promoted half-objects). **Each runs in ONE `BEGIN IMMEDIATE` transaction**: set
  `status=durable`, copy quarantine→shared, update prominence/Hebbian, append log — all-or-nothing (v1 could
  crash after `status` before the vector copy → durable-but-unretrievable). `promoteAssertion` **requires both
  endpoint nodes durable** (else a durable edge cites untrusted/prunable endpoints). Grounding by origin:
  `connector` → citation 3-layer check; `user` → immediate; `dream` → **N independent resurfacings keyed on
  distinct dream-run ids AND distinct grounding contexts within a decay window** (a looping run must never
  self-promote). **User writes go through `promoteNode` too** — no `origin=user` durable shortcut (v1's shortcut
  left user notes out of `shared`, invisible to retrieval).

**Mutation:**
- `reinforce(id, delta)` / `decay()` — **atomic server-side deltas, NO `expectedVersion`** (blind-Claude's
  correction: version-rejecting a *commutative* reinforce is data loss, not protection). `decay` is lazy
  (computed on access; never persisted on a read).
- Content-replacing writes (text/type/status edits) **require `expectedVersion` → typed `VersionConflict{id,
  expected, actual}`**. On any text change to a **durable** node, re-embed → quarantine **and, same txn,** update
  the shared vector (a durable node must never have two different vectors across the tiers — v1's reinforce
  desynced them). Simpler default: **a durable node's embedding is immutable**; re-embedding = re-propose→re-promote.

**Read / retrieval:**
- `querySimilar(vector, k, filters, index:'quarantine'|'shared') → (Node|Edge){kind}[]` — vector search against
  the chosen tier; returns a discriminated union. Empty index → `[]` (never crash).
- `getTile(zoom, bbox, {includeProposed?}) → Subgraph` — serves the **pre-computed pyramid** (§6): top-N durable
  nodes by rank within the tile, **induced edges only** (drop edges to nodes outside the tile, or return
  id-only ghost stubs — never a dangling edge). `includeProposed` returns dashed nodes under a **separate small
  cap** (they never starve the durable budget).
- `getNode/getEdges/query/export`.

**Lifecycle / ops:**
- `prune()` — removes unpromoted `proposed` nodes past their τ, **cascading to incident edges/assertions/vectors
  in one txn** (no orphans/dangling — v1 left them). Refuses to prune a node with a live durable edge (tombstone
  instead).
- `backup()/restore()` — §8.
- **Circuit breaker (Store-internal, over non-user auto-promotions):** meter = rolling window of last N
  auto-promote attempts; a "hallucination" = a promote rejected by grounding **or** an out-of-band
  `reportHallucination(id, evidence, criticId)` (critic ≠ generator) — never inline LLM sampling on every
  promote. Gating with **hysteresis + a Wilson lower bound + min-sample** (v1 tripped a fresh store on
  1-bad-in-8): trip auto-promotion when the Wilson-lower-bound rate >5%, **resume only <3%**; scope
  **per-origin** (a noisy connector never blocks `user` or a clean source). **Never disable quarantine writes or
  dedup** (v1's ">10% disables proposal indexing" bricked the store — nothing could be vetted, rate could never
  recover). A manual/aging reset exists.

## 5. Invariants (each has a §7 test)

1. Single writer + WAL; no mutable internal state returned.
2. Embeddings always → quarantine; **shared populated ONLY by a `promote` txn.** "Not embedded" = "not in the
   *shared* index."
3. `promoteNode`/`promoteAssertion` are the only paths to `durable`, each atomic; assertion promote requires
   durable endpoints.
4. Every mutation logged; **replay = pure application of logged `before→after` columns** — never re-run Embedder,
   grounding, the breaker, or `Date.now()`. The graph hash covers durable stored columns **excluding `S_raw`/rank**.
5. Prominence = **rank within a tile, fixed budget** (never absolute threshold).
6. `reinforce`/`decay` = commutative atomic deltas (no version); `expectedVersion` only on content-replacing writes.
7. Idempotent re-ingest for **nodes AND edges** (dedup on content/provenance identity, not a float threshold).
8. A durable node/assertion has **exactly one vector identity** across tiers (immutable after promote, or
   re-synced in the same txn).
9. No dangling edges; `prune` is graph-consistent incl. vector tables.
10. The breaker can never brick the store (quarantine + dedup always live; hysteresis + reset).

## 6. Prominence & the pyramid — (A) + upward K-promotion

`S_raw = S_last·exp(-Δt/τ)` (τ per type/mode), computed on access. **Elevation = `rank(S_raw)` within a tile, a
fixed top-N budget (decision A).** The seam artifact of *pure* per-tile budgets (a globally-strong node in a
dense tile suppressed while a weaker node shows in a sparse neighbor — the classic map-label-placement problem)
is fixed by **upward K-promotion (Brian):** building the pyramid bottom-up, **each tile promotes its top-K (K ≥
the shown N) candidates up to the next-coarser level's election**, where they compete again. A strong-but-crowded
node thus gets K chances to survive up the pyramid instead of being eliminated locally — the Church-in-Kansas
mechanism (local prominence, survivors elected upward), with K>1 so a good idea isn't lost at the first tile.

This **converges with blind-Claude's cache design:** keep a **top-2N** per tile (the promotion candidates + slack);
`get_tile` re-ranks the cached 2N by fresh `S_raw` on read (O(tile), and the 2N buffer absorbs rank churn between
writes); **never persist decay on a read.** Deterministic tie-break: `ORDER BY S_raw DESC, id ASC`. The pyramid
(levels + tile assignments + top-2N + `promoted_from`) is built by the Resonator via `putLayout` + a build pass;
the Store *serves* it.

## 7. Tests (part of the spec — the gate's failing sequences, as Given/When/Then)

Each is a CI gate. Named after the flaw it kills.

- **chicken-and-egg:** `putNode(X)`→ in `querySimilar(quarantine)`, NOT in `querySimilar(shared)`; after
  `promoteNode(X)` → in `shared`. *(Also run for a user-origin node — no shortcut.)*
- **promote-atomicity:** kill the process mid-`promoteNode` (after `status`, before vec copy) → on restart, either
  fully durable+in-shared or fully proposed. Never durable-but-unretrievable.
- **reinforce-commutativity:** two concurrent `reinforce(X,+1)` → strength +2 (no lost delta, no VersionConflict).
- **version-conflict:** stale `expectedVersion` on a *text edit* → `VersionConflict`, log unchanged.
- **dedup-noisy-embedder:** re-ingest the same note twice with a **stub Embedder that adds gaussian noise** →
  node count unchanged, strength within the reinforce cap. *(Guards against cosine-drift-below-0.99.)*
- **edge-idempotency:** `putEdge(A,B,RELATED)` twice → one edge row, one Hebbian increment, a second assertion attached.
- **replay-at-different-wallclock:** export log; replay in a fresh Store **at t0+30d with a different Embedder
  stub** → graph hash-equal (excl `S_raw`/rank), vectors intact.
- **prune-no-dangling:** `putNode(A)`, `putEdge(A,B)`, wait past τ, `prune()` → no edge/assertion/vector references
  a deleted node.
- **breaker-no-brick:** drive hallucination to 11% → auto-promote pauses, **but quarantine writes + dedup still
  work + user promote still works**; drop below 3% → auto-promote resumes (hysteresis). Fresh store with
  1-bad-in-8 does **not** trip (Wilson + min-sample).
- **tile-induced-edges + tie-determinism:** `get_tile` returns no edge to an out-of-tile node; equal-`S_raw` nodes
  return a stable top-N across runs.
- **pyramid-election:** a globally-strong node in a dense tile (suppressed at fine zoom) **appears at a coarser
  zoom** via K-promotion (seam mitigation).
- **vector-tier-consistency:** a durable node never has two different vectors across quarantine/shared.
- **backup-restore round-trip:** §8 — backup a live store, restore into a fresh one → graph hash-equal.

## 8. Backup / restore (Brian: mechanics belong in the spec)

The `.db` file is the portable source of truth, but a live WAL + vector tables need care:

- **Snapshot:** `VACUUM INTO 'backup.db'` (atomic, checkpoints WAL, includes sqlite-vec tables) — a consistent
  point-in-time copy while the store is running (no writer stall beyond the vacuum). Alternatively the SQLite
  Online Backup API.
- **Portable export (`export`):** JSON of nodes/edges/assertions/layout **+ base64 vectors + schema_version + the
  mutation_log**, so a backup can be restored on a machine without the exact sqlite-vec build (rebuild vectors
  from the export) and audited.
- **Restore:** open the snapshot (or import the JSON), **validate `schema_version`** and run migrations if behind
  (§7 schema-migration), **verify vector-index integrity** (row counts per tier match node/assertion counts), and
  reject on mismatch. `S_raw`/rank are recomputed lazily (not stored), so restore is decay-correct by construction.
- **Point-in-time / audit:** the `mutation_log` restores to any event via §5.4 pure replay (embedding-closed).
- **Test:** `backup-restore round-trip` (§7) — hash-equal (excl `S_raw`); plus a restore-with-schema-behind
  migration test.

## 9. Still open (small)

- Hebbian update *rule* (magnitude/decay of `hebbian_weight` on co-activation) — Resonator's, but the Store
  exposes the write; name the contract.
- Exact `K` (promotion width) and `N` (shown budget) per zoom — tune empirically; pre-register defaults.
- `content_hash` normalization (whitespace/markdown) policy — pin it so idempotency is stable across ingesters.

## 10. First implementation slice

Build in this order, each behind its §7 test(s): (1) schema + `putNode` + two-tier + `querySimilar` +
chicken-and-egg test; (2) `promoteNode` atomic + breaker (no-brick test); (3) `putEdge`/`promoteAssertion` +
idempotency + prune-cascade; (4) `reinforce`/`decay` commutative + version-conflict; (5) layout + `getTile` +
pyramid-election; (6) mutation_log + replay-at-different-wallclock; (7) backup/restore round-trip. Prove the
chicken-and-egg + no-brick + replay tests green before widening — they're the load-bearing three.

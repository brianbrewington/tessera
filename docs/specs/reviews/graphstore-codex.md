## I LIKE

- **§1 authority boundary is crisp.** Making Graph Store the sole writer is the right anti-corruption boundary; it prevents side-channel writes from Ingest/Connector/Dream.
- **§3 two-tier vectors are a strong safety primitive.** “Always quarantine, only `promote` to shared” is exactly the right retrieval guardrail.
- **§3 edge weight split is excellent.** Keeping immutable `semantic_weight` separate from learned `hebbian_weight` avoids overwriting evidence with behavior.
- **§5 invariants are testable, not philosophical.** Especially idempotent re-ingest + deterministic replay + single-writer/WAL.
- **§6 tiling by rank budget (not absolute strength) is the right LOD model.** Good call for zoom pyramids and heterogeneous domains.

## I WISH (what will bite first)  

### 1) `durable` path contradiction creates impossible states (§4 vs §5)
- **Problem:** `upsertNode` says “default proposed unless `origin=user`”, but §5 says `promote` is the only path to durable.
- **Concrete failing sequence:**
  1. `upsertNode({text:"X", origin:"user"}) -> {id:n1}` (node becomes `durable` by wording)
  2. `querySimilar(embed("X"), k=5, index="shared") -> []` (because shared index is only populated by `promote`)
  3. `getNode(n1).status == "durable"` while retrieval cannot see it.
- **Stronger spec:** pick one rule and enforce it:
  - Either **A)** truly only `promote` can set durable (including user-origin), or
  - **B)** user-origin upsert must internally execute the same atomic path as promote (`status + shared copy + log`).

### 2) `promote(id, ...)` is under-specified and can promote half-objects (§4, §3)
- **Problem:** One `id` endpoint, but entities differ (node, edge, edge_assertion, pattern) with different required evidence.
- **Concrete failing sequence:**
  1. `link(a,b,{reason:"...", origin:"connector"}) -> edge:e1 + assertion:as1 (proposed)`
  2. `promote(e1, grounding=...)` (allowed by ambiguous signature)
  3. `getEdge(e1).status == durable`, but `edge_assertions(as1).status == proposed`, assertion vector still quarantine.
  4. Viewer sees a durable relation with no durable justification.
- **Stronger spec:** split verbs: `promoteNode(nodeId,...)`, `promoteAssertion(assertionId,...)`; define explicit cascade rules (or no cascade) and enforce transactionally.

### 3) `promote` atomicity is not explicit; crash can violate invariants (§4, §5, §2 WAL)
- **Problem:** Promotion mutates multiple stores (row status, shared vec copy, prominence/Hebbian, mutation log). Must be one transaction.
- **Concrete failing sequence:**
  1. `proposeNode(N)` (vector in quarantine)
  2. `promote(N)` starts
  3. Process crash after `status=durable`, before `vec_shared` insert
  4. Restart: `getNode(N).status == durable`, `querySimilar(...,"shared")` misses N.
- **Stronger spec:** one `BEGIN IMMEDIATE` transaction containing all promotion side effects + log append; on restart, either all effects exist or none.

### 4) Optimistic concurrency invariant lacks API shape (§5.6 vs §4 verbs)
- **Problem:** Invariant says stale writes rejected, but write verbs don’t require `expectedVersion`.
- **Concrete failing sequence:**
  1. Client A: `getNode(n1) -> version 7`
  2. Client B: `getNode(n1) -> version 7`
  3. A calls `reinforce(n1,+0.7)`; B calls `reinforce(n1,-0.7)` based on same old state
  4. Both succeed; final state depends on arrival order, no conflict signal to either client.
- **Stronger spec:** every mutating verb accepts `expectedVersion`; mismatch returns typed `VersionConflict` with current version.

### 5) Prune/cascade behavior can create dangling graph + vector leaks (§4 `prune`, §3 tables)
- **Problem:** No explicit cascade semantics between `nodes`, `edges`, `edge_assertions`, `vec_*`.
- **Concrete failing sequence:**
  1. `proposeNode(A)`, `proposeNode(B)`, `link(A,B,...) -> e1/as1`
  2. Wait past prune TTL for unpromoted nodes
  3. `prune()`
  4. Nodes removed, but `e1`/`as1` or `vec_quarantine(as1)` remain (orphan rows/embeddings).
- **Stronger spec:** strict FK + cascade policy written per table; prune deletes must be graph-consistent and include vector tables in same tx.

### 6) Tiling output contract can return invalid subgraphs (§6, §4 `getTile`)
- **Problem:** “top-N nodes + their edges” is ambiguous about edges to out-of-budget nodes.
- **Concrete failing input→wrong output:**
  - Tile has nodes A,B,C with prominence ranks A=1, B=2, C=3; topN=2.
  - Edges: A-B, B-C.
  - `getTile(...)-> nodes [A,B], edges [A-B, B-C]`.
  - Output contains `B-C` but node C absent: broken subgraph for renderer/layout.
- **Stronger spec:** return **induced edges only** among selected nodes, or include boundary-node stubs explicitly; pick one and test it.

### 7) Rank ties are nondeterministic without tie-breakers (§6, §7)
- **Problem:** Rank-normalization with equal scores can flicker across runs if SQL order is undefined.
- **Concrete failing sequence:**
  1. Nodes N1 and N2 have equal `S_raw`.
  2. `getTile(z,bbox,topN=1)` run #1 returns N1.
  3. Same DB, run #2 returns N2.
  4. Fails “stable geography” expectation despite same data.
- **Stronger spec:** deterministic ordering (`ORDER BY rank_metric DESC, stable_id ASC`) and include tie determinism in §7 tests.

### 8) Breaker policy can block safe writes and collapse recall (§4 promote breaker, §5.3)
- **Problem:** “>10% disables proposal indexing” appears global and operation-wide.
- **Concrete failing sequence:**
  1. Dream-origin promotions perform badly; breaker crosses 10%.
  2. User adds corrective fact: `proposeNode(user_fact)` -> `BreakerTripped` / not indexed.
  3. Connector dedup on quarantine can’t see correction; bad proposals continue dominating.
- **Stronger spec:** scope breaker by **origin + operation**:
  - never block quarantine vector writes,
  - block only risky auto-promote lanes,
  - always allow explicit human/user promote path.

### 9) Deterministic replay vs lazy time-based decay is currently fragile (§4 `decay`, §6, §7)
- **Problem:** replay determinism breaks if time-dependent operations aren’t parameterized/logged.
- **Concrete failing sequence:**
  1. Day 0: ingest nodes, then `prune()` at T0.
  2. Replay same mutation log at Day 30.
  3. If replay recomputes decay/prune at “now”, additional nodes are removed; hash differs.
- **Stronger spec:** all time-sensitive ops take explicit `effectiveAt` and log it; replay uses logged timestamps, not wall clock.

## I WONDER (and my positions on §8 open questions)

- **§8 Q1 (two vec tables vs one with tier):**  
  **Position:** keep **two physical sqlite-vec tables**.  
  **Why stronger:** invariant enforcement by structure; impossible to “accidentally query shared+quarantine together.”  
  **Add:** a transactional helper `copyQuarantineToShared(id)` used only by promote.

- **§8 Q2 (Embedder boundary):**  
  **Position:** Store should be **embedding-agnostic at core API** (`vector` passed in), with optional adapter layer that calls Embedder.  
  **Why stronger:** deterministic replay/testing, model-version independence, easier backfills.  
  **Add:** require `embedding_model_id`, `dim`, and `vector_checksum` in mutation log.

- **§8 Q3 (`getTile` cost):**  
  **Position:** **materialize per-tile/per-zoom ranks on write** for dirty tiles; reads are O(tile).  
  **Why stronger:** predictable latency and no O(n) scan spikes under viewer load.  
  **Add:** `tile_rank_cache(zoom,tile_id,node_id,rank,updated_at)` with dirty-tile invalidation.

- **§8 Q4 (breaker sampling):**  
  **Position:** use a **rolling labeled window** (e.g., last 200 auto-promotions) with minimum sample floor before gating; trip on measured rate thresholds with hysteresis.  
  **Why stronger:** cheap enough online, avoids thrash and tiny-sample false trips.  
  **Add:** `breaker_state` table with `window_size`, `bad_count`, `good_count`, `state`, `last_transition`.

## Test gaps to add before implementation (§7)

- Crash-consistency test: kill process mid-`promote`, verify atomic rollback/commit.
- Version-conflict test: stale `expectedVersion` write must fail.
- Prune-cascade test: no orphan edges/assertions/vectors after prune.
- Tiling tie-break determinism test: equal-score nodes return stable top-N across runs.

If you want, I can turn this into a “pre-implementation checklist” with exact acceptance criteria phrased as executable test cases (Given/When/Then).

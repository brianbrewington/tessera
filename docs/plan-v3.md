# tessera v3 — consolidated plan

*Plan of record. Evolution: `plan-v1` (pre-review) → `plan-v2` (after Codex + Grok) → **`plan-v3` (this doc):
incorporates the blind-Claude Round-2 review, which caught load-bearing issues both frontier reviewers missed
(see `reviews/review-of-reviews.md`).** Decision log: `retro.md`.*

## Changes in v3 (the blind-Claude fixes)

1. **Two-tier index** resolves a real contradiction: `proposed` nodes were "not embedded," yet dedup and the
   Connector *need* an embedding to ground them. Now: **embeddings are always computed into a quarantine
   index**; `proposed` means "not in the **shared/retrieval** index"; `promote` copies the vector across.
2. **Prominence is rank-normalized within a tile** (top-N per zoom = a fixed elevation budget) — the missing
   conservation term. *Absolute strength can't tile a pyramid; relative prominence can.* This is Brian's
   Church-in-Kansas / US20130035853A1 patent insight (local > global prominence), i.e. **relative prominence
   IS attention shaping** — the framework's center, now the elevation model.
3. **`promote(id, grounding)` is a first-class Store verb**, and the hallucination circuit-breaker is a
   Store-internal invariant over all promotions (so it sees the aggregate rate).
4. **Connector runs over a dirty set** — O(dirty·k), not the O(n²) all-pairs pass sqlite-vec's brute-force KNN
   would otherwise force (~10¹⁰ dot products at 10⁵ nodes).
5. **Tile-addressable read API** `get_tile(zoom, bbox)` replaces `get_subgraph(min_strength, limit)` — semantic
   zoom is a tiling problem.
6. **`expert_surprise` is computed structurally** (pre-edge graph/embedding distance) or by a separate critic —
   never self-scored by the dream model that wrote the edge (fox/henhouse; it gates CLAIM graduation).
7. **Pre-registered v1 success test** (N dreams, written rubric, ε-vs-neighbor endpoints blinded) — not n=1
   self-judged.
8. **Dream ships with its brake:** the degenerate-loop circuit-breaker moves into v1 alongside lucid-extract;
   unpromoted `proposed` nodes are GC'd (TTL = their τ) to prevent clutter.
9. **The user is a node** (PERSON/AGENT) so every human "apt" promotion is attributable via `ORIGINATED_FROM`.
10. **Checklist gains schema-migration + re-ingest-idempotency**; engine language leans **all-TypeScript**.

## 1. What we're building

**Identity (v1):** a **zoomable idea-map with a dream engine** — ingest heterogeneous material into a typed
graph, compute prominence, render it as a semantic-zoom map, and let a generative "dream" surface non-obvious
connections. **Destination:** proactive, inspectable memory (knowledge surfaces *unbidden*). v1 builds the means.

**Two distinctive bets:** (1) **prominence-gated semantic zoom** — what renders depends on zoom *and* a node's
prominence (an elevation, now **rank-normalized within each tile** — a scarce budget per zoom, which is *the
attention-allocation law*, not a rendering trick). (2) a generative **dream** that surfaces *non-obvious*
connections, distinct from analytic nearest-neighbor linking.

## 2. v1 scope + pre-registered success

**Slice:** Ingest (markdown first; then PDF/docx/image) → Graph Store → Connector → Resonator → Dream → Web
Viewer. Seeded on ~65 notes from the author's own writing.

**Success — pre-registered, not self-judged:** run **N dreams**, score each edge's `expert_surprise ≥ 2`
against a **written rubric**, with **ε-teleport vs. neighbor-walk endpoints blinded** so the judge doesn't know
which is which. Targets: **apt-surprise rate ≥ 30%, false-weird rate < 20%.** The one differentiating claim
must survive an adversarial test, not a delighted one. If the dream never produces apt surprises, v1 failed.

**Non-goals:** proactive unbidden surfacing (destination); multi-graph dashboards; distributed dreaming;
real-time collab; deep epistemic zoom (shallow stub); auth; DECISION nodes; node-content versioning (v2).

## 3. Architecture & seams

- **One hard contract: the Graph Store** = sole writable authority. API: `upsert_node` / `propose_node`,
  **`promote(id, grounding)`** (the central trust op — Store-owned, not scattered across callers), `link` /
  `propose_edge`, `query`, `query_similar(embedding, k, filters, index=quarantine|shared)`, **`get_tile(zoom,
  bbox)`** (LOD slice — tiling, not `min_strength`), `reinforce`, `decay`, `prune`, `export`.
  - **Two-tier vector index:** a **quarantine** index (all embeddings, read by dedup + Connector) and a
    **shared/retrieval** index (durable only, feeds RAG + node/edge similarity). Promotion copies a vector
    across; the >5% / >10% hallucination **circuit-breaker is a Store-internal invariant over all promotions.**
  - Per-node/edge `version` + an **append-only mutation log** (`event_id, actor, cause`) — deterministic replay
    + no silent clobber. **Single writer + WAL** (sqlite-vec is one file).
- **Two deployables** — headless **engine** + **web viewer** — shipped with a **single-process local mode** (one
  command runs both) so v1 doesn't inherit distributed failure modes.
- **Modules, isolated specs, all Store clients:** Ingest · Embedder · Connector · Resonator · Dream · Pyramid/LOD.
- **One shared schema package** validated at every boundary. **All-TypeScript for v1** (engine + viewer share
  types *natively* — the top anti-morass remedy; Ollama is HTTP and sqlite-vec runs under better-sqlite3, so TS
  is unblocked). **Protobuf deferred** to the first external-authoring boundary; the **validation/decode path is
  a heavily-tested, non-negotiable invariant** (JSON-at-scale guard).
- **Stack:** viewer **custom Canvas/WebGL**; storage **SQLite + sqlite-vec** (behind `query_similar`); local
  models via **Ollama** HTTP (`embeddinggemma` + a chat model).

## 4. Data model

**Common node fields:** `id, type (+ subtype/mode), text, embedding, strength, timestamp, provenance, metadata`,
plus `status` (proposed | durable) and `pinned`.

**Status lifecycle (the trust model).** Every node/edge is `proposed` or `durable`. **Embeddings are always
computed** — into the **quarantine index** (dedup + Connector read it), so a fresh node is *not* invisible to
the thing meant to ground it. `proposed` = shown dashed/dimmed, click-for-why, but **not in the shared
retrieval index, not in RAG, not counted as structure.** **`promote`** (citation for analytic; human "apt" or N
independent resurfacings for dream) copies the vector into the shared index and counts it toward prominence +
Hebbian. Store-internal breaker: >5% sampled hallucination pauses auto-promotion, >10% disables proposal indexing.

### Node types (v1 core — 16)

*Entities:* **PERSON** (human/synthetic persona — **including the operator/user, so promotions are
attributable**) · **AGENT** (acts *on* the graph) · **PROJECT** · **GOAL**.
*Ideas:* **CONCEPT** (subtypes feeling/value/wisdom) · **INSIGHT** · **QUESTION** · **CLAIM** (contestable;
graduation target; confidence/evidence-grade deferred).
*Records:* **MEMORY** · **SOURCE** (`last_observed`/`observation_budget`, separate from `strength`) · **QUOTE**.
*Generative episodes:* **SESSION** *(mode: dream|conversation|interview|debate|reflection)* — **a single
concrete session-runner** (cast → transcript → residue → commit-gate) with `mode` as a **strategy object**
(cast-selection, decay-τ, and commit-policy each branch on mode). If no shared runner exists, `mode` is just
`switch`-sprawl — so the runner is named and load-bearing, not five types in a trenchcoat.
*Structure & system:* **PATTERN** (cluster-summary = pyramid levels; materialized view + lineage + **sticky id**
via seeded clustering + carry-forward matching, so zoom-out geography is stable) · **CONFLICT** (n-way only) ·
**SYSTEM_FEEDBACK** (pinned, non-decaying).
*Commitments:* **ACTION / TASK** — a to-do/done a session/claim/insight drove; `status` + `ORIGINATED_FROM`
trace-back → "what changed because we learned this, and why."

### Not node types (anti-sprawl)

PROPOSAL/HYPOTHESIS → a `status`. SUPPORTS/REFUTES/DEPENDS_ON → edge `polarity`. EVIDENCE-grade/METRIC →
deferred CLAIM fields. BRIDGE → computed (betweenness). Deferred: EVENT, DECISION, CONSTRAINT, SCENE.

### Edges — structural spine + separately-embeddable explanation

- **Structural:** `from, to, kind ∈ {RELATED, ORIGINATED_FROM, APPEARED_IN, HEBBIAN_ASSOC, RESONATES_WITH}`,
  optional `polarity ∈ {elaborates, supports, contradicts, depends_on}`, `semanticWeight` vs `hebbianWeight`
  (never overwrite), `status`.
- **Edge assertion:** a `reason` naming both endpoints; `reason_embedding` in the quarantine index always,
  copied to the shared index only on `promote`; `origin ∈ {connector, dream, user}`; grounding (citation spans);
  **`expert_surprise` computed structurally** (pre-edge graph/embedding distance) or by a separate critic — not
  self-scored.
- **Graduation:** a reason → CLAIM/INSIGHT node when detachable + reusable (>2 nodes) + contestable, gated by
  `expert_surprise ≥ 2` or human. (Lincoln/Trump → a CLAIM with `elaborates` edges from each.)

### Prominence — decayed strength, budgeted per tile

`S_raw = S_last·exp(-Δt/τ)` (τ per type/mode; SESSION`dream`≈10min, MEMORY≈7d, CONCEPT≈1yr; on access). **But
elevation is `rank(S_raw)` within a tile/cluster — top-N per zoom level, a fixed budget** — not an absolute
threshold. Absolute strength drifts to "everything is prominent" and flattens the pyramid; relative prominence
tiles it. (Distinct from a SOURCE's `observation_budget`.)

## 5. Engine pipeline

- **Ingest:** adapter per format. Chunk (full-block + dedup; dual-res window off by default). Negative-
  constraints extraction via one structured call. Captures land as `MEMORY`, `proposed`, embedded to quarantine,
  not auto-wired. **Re-ingest is idempotent** — re-ingesting the corpus must dedup-reinforce, never inflate
  prominence via repeated `reinforce`.
- **Connector (analytic), over a dirty set:** candidates from embedding-proximity + open-triangle **only over
  nodes touched since the last pass** (O(dirty·k), not O(n²)); tautology-debloat first; LLM-verify (conf ≥ 0.6);
  **citation-grounded to `promote`** (the ee 3-layer check). Scoped to a viewport / "connect this region," not
  whole-corpus. The dream is the *global* generative connector.
- **Resonator:** lazy τ-decay + degree + **rank-normalization per tile**; one cheap **seeded** clusterer
  (label-propagation seeded from the prior assignment / fixed-seed Leiden + carry-forward id matching) → stable
  PATTERN nodes. Anti-popularity: normalize by expected degree. PageRank/Hebbian learning fast-follow.
- **Dream (minimal, WITH its brake):** Dream-Walker (recency seed + ε-teleport cast; bias ε toward VoidDetector
  pairs) → weave → lucid-extract (residue `proposed`) → fast-decay. **The degenerate-loop circuit-breaker (σ>0.8
  abort) ships in v1 with lucid-extract**, because folded-back concepts seed the next dream (positive feedback).
  **Unpromoted `proposed` nodes are GC'd at their τ.**

## 6. Viewer (custom Canvas/WebGL)

- **Semantic zoom, two axes:** breadth = **rank-normalized prominence per tile** (top-N per zoom; served by
  `get_tile(zoom, bbox)`); depth = **epistemic zoom** (node → relationships → passages → provenance →
  confidence), shallow stub in v1.
- **Interactions (rebuilt clean):** degree-prioritized zoom-tiered occlusion-tested labels; glow nodes by type,
  sized by (rank) prominence; edges colored by source cluster; **click edge → read why**; **`proposed` dashed/
  dimmed**; dim-don't-delete; min-weight declutter; expand-neighbors; **scenes** (saved viewport + eased camera).
- **Self-contained render:** exports a **tile/scene** (a filtered viewport) as one offline HTML — not the whole
  10⁵-node territory (which wouldn't lay out in-browser). Open: does export freeze decay or keep it live?

## 7. Build process (clean-room, anti-morass)

Isolated spec per module; clean-room from prior code; reviewers critique spec-first then implementation.
**Checklist — split into CI-gates vs review-gates:** *CI-gate:* ① one shared schema package · ⑤ one validated
decode path (heavily tested, non-negotiable) · ⑧ secret-scan hook · ⑨ one test framework · ⑦ real integration
tests kept · ⑪ 65-note regression fixture + the §2 dream-eval protocol · **⑫ schema migration** (persistent
graph *will* change schema mid-build) · **⑬ re-ingest idempotency.** *Review-gate (human):* ② no mutable
internal state returned · ③ prove the loop end-to-end before adding a module · ④ processors stateless · ⑥ single
rendering owner · ⑩ refactor-in-place.

## 8. Resolved decisions

- **8.1 Vector store — in-graph (SQLite + sqlite-vec), two-tier (quarantine + shared), behind `query_similar`.**
  Real risk was O(n²) batch, not recall → the **dirty-set** Connector + WAL/single-writer. Migration trigger
  predefined by benchmark.
- **8.2 Renderer — custom Canvas/WebGL.**
- **8.3 Connect timing — analytic = background/viewport-scoped over the dirty set; dream = global generative.**
- **8.4 Resonator — minimal + seeded clustering** (sticky PATTERN ids) + rank-normalization; PageRank/Hebbian later.
- **8.5 Dream — walker+weave+lucid-extract+fast-decay+`proposed`-gate+circuit-breaker+TTL in v1.**
- **8.6 Language — all-TypeScript v1** (native shared types); protobuf deferred; decode-path tests non-negotiable.

## 9. First slice

Write the **Graph Store spec first** (the contract: status lifecycle, two-tier index, `promote`, `get_tile`),
review it (all four reviewers), build with tests, then Ingest + a trivial viewer to see real nodes, then
Connector, Resonator, Dream. Prove the loop end-to-end on the ~65-note corpus before widening.

## 10. v3.1 delta — path as overlay, synthesis via guided-Dream, audit via frame-debt (FLEET-HARDENED)

*Status: **fleet-reviewed 5-0; reframe adopted, contract-delta rewritten to the cheaper decomposition the fleet forced.**
Brief + full reviews: `reviews/path-dependence-delta.md`. Five reviewers (Codex 5.3-high, Grok 4.5-xhigh, Qwen-30b,
Qwen-80b, blind-Claude) converged independently: **the converge/synthesize/audit reframe is sound; every move as first
proposed reached for a heavier contract surface than its goal required.** blind-Claude deepest again (the prune/τ,
interpolant-`expert_surprise`, and sign-flipped-decay catches below were its alone). Origin: Brian's path-dependence
twist + EXP-006 + his correction that the "bubble" is also the click ("it was the path that made linear systems click").*

**The reframe (adopted, unchanged).** The filter bubble and *the click* are the **same mechanism** — path-dependent
convergence onto a frame — differing only in whether the frame is **true** (fits the world) or merely **comfortable**
(fits history). We *want* convergence; that's understanding. North star: **manufacture the click, then keep it honest.**
The three moves stand — **converge / synthesize / audit** — each now taking the lighter contract surface:

1. **Move 1 — path is a highlight OVERLAY on stable geography, not a prominence rewrite.** *(Unanimous load-bearing
   fix.)* The `S_raw` pyramid ships unchanged and path-agnostic — **tile membership never depends on path**, so the map
   stays legible and `get_tile`'s signature is untouched. Path becomes a *separate* additive read **`get_heat(path_context)`**
   — a personalized-PPR overlay via **Andersen–Chung–Lang local-push** (`O(1/αε)`, sublinear; RWR-from-seed was never the
   intractable part) — rendered as *glow over stable geography, never re-tiling it*. This is the faithful Google-Maps
   reading (history highlights a stable base map; it does not move the roads). Kills the flicker (a fixed top-N budget
   turns a continuous score-shift into a discrete N-th-boundary swap — the very budget v3 added), keeps `O(tile)` reads,
   preserves invariant 5. "A minor idea becomes major with the backlinks" is then true *as a highlight* — exactly right.
   The original `get_tile(…, path_context?)` signature was the tell we were re-ranking geography when we meant to annotate it.
2. **Move 2 — synthesis is a GUIDED DREAM; bridges are provisional with a real cap.** A generative walk = **the existing
   Dream seeded with a user-supplied path** instead of a recency seed (the Dream already is walker + ε-teleport + weave +
   lucid-extract + residue-`proposed`) — so **no new walk verbs.** The archetypal-question transition is a `QUESTION`/
   `INSIGHT` node from the *existing* `putNode` — **not a `BRIDGE` node type** (§4 keeps `BRIDGE = computed betweenness`;
   the first draft silently reversed that). Minted under **`origin=dream`** to inherit the *already-hardened* dream
   promote-gate (N independent resurfacings across distinct run-ids AND grounding contexts; a looping run never
   self-promotes) **plus: ≥1 grounding that is not the walk that authored it** (critic ≠ generator, Codex). Three
   proposed-space leaks the promotion-scoped breaker structurally cannot see, each closed: (i) **per-session mint budget
   counting `proposed` mints**, not just promotions (the breaker is blind to quarantine by construction); (ii)
   **walk-revisits must not reset a bridge's decay Δt** — else the flywheel keeps its own bridges fresh and `prune` never
   collects them; (iii) **`expert_surprise` is not the graduation gate for interpolants** — a bridge is synthesized to sit
   *between* its endpoints, so its embedding-distance surprise is structurally low; gate bridges on the dream-resurfacing
   rule, not the corrupted metric. Dedup for low-specificity archetypal questions keys on **(endpoint-pair + normalized
   question)**, since `content_hash`/cosine either false-merge all bridges or admit unbounded near-dups.
3. **Move 3 — WALK is not a Store primitive.** A pathway = a `SESSION{mode:walk}` node (the mode-strategy runner already
   exists) with ordinal-tagged member edges, or read straight off the ordered `mutation_log`. A callback = **one new value
   in the edge `kind` enum, `REFERENCES`** (existing `UNIQUE(from,to,kind,polarity)` gives idempotency). Synthesis = the
   guided-Dream client above. **The only genuine Store-contract change in the whole delta is the `get_heat` overlay read**
   — everything else is a client + one enum value. (Burden of proof, per Codex, unmet: no invariant here that
   ordered-query-plus-existing-writes can't express.)
4. **Move ε/audit — a falsifiable `frame_debt` meter, dosed by convergence.** *(blind-Claude.)* Decay-τ is not merely
   insufficient, it's **sign-flipped**: the comfortable frame is the revisited one, so small Δt → high `S_raw` → never
   flagged, while off-path refuters sit cold, decay, and get `prune`d — *the model deletes the audit's evidence before the
   audit can see it.* Replace it: per-PATTERN **`frame_debt`** — when an ε-teleport lands an inside→outside-frame edge with
   `expert_surprise ≥ θ` and the pipeline does *not* incorporate it, **increment `frame_debt` instead of discarding the
   candidate** (one integer bump on evidence already computed). Rising `frame_debt` under sustained high prominence = "the
   frame keeps routing around contradictions it's shown" = comfortable-not-true; decay-independent. **Confirmatory audit:**
   when `frame_debt` crosses threshold, run the **§2 pre-registered blinded eval turned inward** — a critic (≠ the frame's
   author-model) judges whether the frame's asserted edges or the ε-found ignored edges better fit the corpus; if the
   ignored set wins, demote/flag. This is the dissertation's change-detection thesis on an idea-frame: *is the frame still
   predictive, or has the world moved past the 2.5-year-stale tile?* And since Move 1 makes the overlay a measurable
   vector, **dose ε ∝ overlay concentration** (Gini/entropy of the PPR vector) — more converged frame, more audit — which
   also dissolves a budget war the first draft missed (under re-tiling, on-path push and off-path ε competed for one fixed
   tile budget; under the overlay they don't compete).

**Net:** converge/synthesize/audit survives intact; **the contract surface drops to exactly two changes** — a
`get_heat(path_context)` overlay read and a `REFERENCES` edge-kind value — plus a guided-Dream client and the `frame_debt`
counter. **What tessera is, restated:** a machine for **manufacturing the click** — constructing the path that crystallizes
a hidden third node — with an **auditor attached** to keep the crystallized frame honest. Not a map you browse; a crucible
for abstractions. **Open before spec-fold:** does `get_heat` live in the Store or the Resonator? is `frame_debt` a PATTERN
field or its own table? — for the next gate.

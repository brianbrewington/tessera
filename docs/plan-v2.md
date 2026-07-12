# tessera v2 — consolidated plan

*Consolidated after two teammate-review rounds (Codex + Grok) — a full plan review and a focused edges
consult. Raw reviews in `docs/reviews/`; decision log and provenance in `docs/retro.md`; the pre-review draft
is `docs/plan-v1.md`. This is the current plan of record.*

*Who you're building with: **Brian Brewington** — a senior engineering leader (autonomous-vehicle simulation
and safety) with a Dartmouth PhD under George Cybenko on the **optimal allocation of scarce observational
attention**. That work is the direct root of tessera's **prominence** model. He also built geo-partitioned
MapReduce for Google Maps (the map-tile-pyramid lineage behind the semantic zoom), holds a patent on
prominence-based map rendering, and has been developing a framework (toward a possible book) on institutional review as attention allocation. He
treats attention/salience as a first-class quantity, thinks in systems, and asks to be leveled with, never
flattered.*

## 1. What we're building

**Identity (v1):** a **zoomable idea-map with a dream engine** — ingest heterogeneous material into a typed
graph, compute prominence, render it as a semantic-zoom map, and let a generative "dream" surface non-obvious
connections. **Destination (later):** proactive, inspectable memory, where relevant knowledge surfaces
*unbidden* ("the user doesn't query memory; memory arrives"). v1 builds the means.

**Two distinctive bets:** (1) **prominence-gated semantic zoom** — what renders depends on zoom level *and* a
node's prominence (an elevation that rises with use, decays with neglect); map-tile / level-of-detail
behavior (the *pyramid*), not a flat force graph; prominence is *dynamic*. (2) a generative **dream** that
surfaces *non-obvious* connections, distinct from analytic nearest-neighbor linking. The dream is what makes
tessera a thinking instrument, not a graph viewer.

## 2. v1 scope + success

**Slice:** Ingest (markdown first; then PDF/docx/image) → Graph Store → Connector (analytic edges) →
Resonator (prominence) → Dream (minimal) → Web Viewer (semantic zoom). Seeded on ~65 notes from the author's
own writing.

**Success is usability, and now *measured*:** the user can ingest a corpus, see a prominence-ranked zoomable
map, click an edge and read *why*, and trigger dreams that surface apt surprises. Concrete gate (from review):
a small blind protocol — e.g. **20 dream runs, apt-surprise hit rate ≥ 30%, false-weird rate < 20%** (user
rates apt / not / "already knew this"), so progress is weekly-measurable rather than a vibe. If the dream
never produces apt surprises, v1 has failed its one differentiating job.

**Non-goals for v1:** proactive unbidden surfacing (destination); multi-graph dashboards; distributed
dreaming; real-time collaboration; deep epistemic zoom (shallow stub only); auth; DECISION nodes (deferred).

## 3. Architecture & seams

- **One hard contract: the Graph Store** = sole writable authority. Narrow API: `upsert_node` /
  `propose_node`, `commit_proposal`, `link` / `propose_edge`, `query`, `query_similar(embedding, k, filters)`
  (vector search hidden behind this — the backend is swappable), `get_subgraph(min_strength, limit)`,
  `reinforce`, `decay`, `prune`, `export`. Nothing reaches another module's internals; nothing returns mutable
  internal state.
  - **Concurrency (from review):** per-node/edge `version` + an **append-only mutation log** (`event_id,
    actor, cause`) — deterministic replay when a dream goes weird, and no silent clobber under concurrent
    reinforce/decay/link. Single-writer + WAL (see §8.1).
  - **Propose/commit is first-class**, not an afterthought: dream and bulk-Connector output land as
    `proposed` and are promoted explicitly (see the status lifecycle in §4).
- **Two deployables** — a headless **engine** (owns Store + pipeline, small HTTP/JSON API) and a **web
  viewer** — but ship a **single-process local mode** (one command runs both) so v1 doesn't inherit
  distributed failure modes (port drift, schema skew, startup ordering) before product risk is retired.
- **Modules, each an isolated spec, all Store clients:** Ingest · Embedder · Connector · Resonator · Dream ·
  Pyramid/LOD builder.
- **One shared schema package**, validated at every boundary. **Schema-first, JSON-Schema/Zod now; protobuf
  deferred** to the first true multi-language / external-author boundary (§8.6). Because JSON's datatype
  issues get gnarly at scale, the validation/decode path is a **heavily-tested, load-bearing invariant** —
  non-negotiable (guards the classic hand-rolled-parser-breaks-at-runtime failure).
- **Stack:** engine language open (§8.6); storage SQLite + sqlite-vec (§8.1); viewer **custom Canvas/WebGL**
  (semantic zoom needs it); local models via **Ollama** HTTP (`embeddinggemma` + a chat model).

## 4. Data model

**Common node fields:** `id, type (+ subtype/mode), text, embedding, strength, timestamp, provenance,
metadata`, plus a `status` (proposed | durable) and a `pinned` (non-decaying) flag.

**The status lifecycle governs the whole model — one trust rule for everything.** Every node and edge is
`proposed` or `durable`. **Proposed:** visible for inspection (dashed/dimmed, click-to-see-why) but NOT
embedded, NOT in similarity search, NOT counted as structure, NOT in RAG. **Durable:** grounded — a citation
(analytic Connector) OR a human "apt" / repeated independent resurfacing (Dream) — then its embedding is
written, it enters mixed node/edge similarity, and it counts toward prominence + Hebbian wiring. Circuit
breaker: sampled hallucination >5% pauses auto-promotion, >10% disables proposal indexing. *This one lifecycle
gates both authority and retrievability, uniformly — the point where both review rounds converged.*

### Node types (v1 core — 16)

*Entities:* **PERSON** (human/synthetic persona) · **AGENT** (AI/software actor that acts *on* the graph;
PERSON is modeled *in* it) · **PROJECT** · **GOAL**.

*Ideas:* **CONCEPT** (subtypes `feeling`/`value`/`wisdom`) · **INSIGHT** (session-born "aha"; graduation
target for a rich edge-reason) · **QUESTION** (the antilibrary) · **CLAIM** (contestable; graduation target;
powers epistemic zoom; internal confidence/evidence-grade fields deferred).

*Records:* **MEMORY** (episodic; raw captures land here) · **SOURCE** (ingested artifact + provenance root;
carries `last_observed`/`observation_budget` — re-observation priority kept **separate from `strength`**) ·
**QUOTE** (verbatim, provenance-anchored, never smoothed).

*Generative episodes:* **SESSION** *(mode: dream | conversation | interview | debate | reflection)* — select a
cast → run an LLM interaction → emit residue → decay. `mode` drives distinct **commit policies** (dream →
proposed; conversation may upsert MEMORY/QUOTE; debate emits `contradicts` edges without forced merge).

*Structure & system:* **PATTERN** (cluster-summary = pyramid's zoomed-out levels; a materialized view with
lineage + sticky id, so geography is stable) · **CONFLICT** (an **n-way** disagreement landmark, ≥3 claims;
binary contradiction is an edge polarity, not this) · **SYSTEM_FEEDBACK** (pinned, non-decaying).

*Commitments — the bridge from thinking to change:* **ACTION / TASK** — something to do/done that a
conversation, claim, or insight drove; `status` (todo|doing|done|dropped) + `ORIGINATED_FROM` trace-back, so
the graph can answer *what changed because we learned this, and why.* The first reach toward the destination.

### Not node types (anti-sprawl)

PROPOSAL/HYPOTHESIS → a **status**. SUPPORTS/REFUTES/DEPENDS_ON → edge **polarity**. EVIDENCE-grade/METRIC →
deferred CLAIM fields. BRIDGE → a **computed** property (betweenness), not stored. Deferred types: EVENT,
DECISION, CONSTRAINT/RULE, SCENE (see plan-v1 §4 for rationale).

### Edges — structural spine + separately-embeddable explanation

- **Structural:** `from, to, kind ∈ {RELATED, ORIGINATED_FROM, APPEARED_IN, HEBBIAN_ASSOC, RESONATES_WITH}`,
  optional `polarity ∈ {elaborates, supports, contradicts, depends_on}` (the tiny epistemic invariant — cheap
  to filter, glyph, and run graph algorithms over), `semanticWeight` vs `hebbianWeight` (never overwrite),
  `status`.
- **Edge assertion:** a `reason` naming *both* endpoints; its own `reason_embedding` **written only when
  durable** (proposed reasons show on click, never enter the ANN); `origin ∈ {connector, dream, user}`;
  grounding (citation spans); `expert_surprise` (0 trivial → 3 insightful). Embedded reasons make edges
  first-class searchable objects — but only after grounding, so a hallucinated dream edge can't poison
  retrieval.
- **Graduation:** a reason becomes a CLAIM/INSIGHT node when **detachable + reusable (>2 nodes) +
  contestable**, gated by `expert_surprise ≥ 2` or human promote. (Lincoln/Trump → a CLAIM with `elaborates`
  edges from each.)

**Prominence = lazily-decayed strength.** `S_now = S_last·exp(-Δt/τ)`, τ per type/mode (SESSION`dream`≈10min,
MEMORY≈7d, CONCEPT≈1yr), computed on access. This is the pyramid's elevation — distinct from a SOURCE's
`observation_budget`.

## 5. Engine pipeline

- **Ingest:** adapter per format behind one interface. Chunk (full-block + dedup; dual-resolution window
  available, off by default). Negative-constraints extraction (forbid buzzwords / abstract existentials /
  empty shells unless qualified) via one structured extraction call. Captures land as `MEMORY`, not
  auto-wired.
- **Connector (analytic), budgeted and scoped (from review):** candidates = embedding-proximity + open-triangle,
  **tautology-debloat first**, LLM-verify (conf ≥ 0.6). Runs as an **explicit pass scoped to a viewport /
  "connect this region"**, not whole-corpus-overnight, with an **LLM-call budget** (e.g. ≤500 verifications/run)
  and info-gain priority — 65 notes → ~200 concepts → thousands of candidate pairs otherwise hairball before
  the first zoom. Analytic connect is *local + intentional*; the dream is the *global* generative connector.
  Connector edges must be **citation-grounded** to go durable (3-layer check: substring → reason↔citation →
  grounding verdict).
- **Resonator (prominence), minimal but with regions (from review):** lazy τ-decay + degree, **plus one cheap
  clusterer** (connected-components / label-propagation on the edge graph) → PATTERN nodes — because degree +
  decay alone give no zoom-out geography to zoom *to*. Anti-popularity correction (normalize by expected
  degree) so a generic hub doesn't become permanent topography. PageRank + Hebbian *learning* are fast-follows.
- **Dream (minimal):** Dream-Walker (recency seed + ε-teleport cast) → weave ("tell the story, don't explain")
  → lucid-extract → fast-decay. **Lucid-extract always runs as *generation*, but is gated as *mutation*:**
  invented nodes/edges land `proposed` (shown as "dream proposed N concepts / M edges"); promotion needs a
  human "apt" or a consolidation pass — never silent fold-in. Fast-follows: deep-sleep consolidation, chaining,
  the σ>0.8 circuit-breaker. *Idea to try:* bias ε-teleport toward VoidDetector pairs (near-in-embedding,
  no-edge) for a higher apt-surprise rate.

## 6. Viewer (custom Canvas/WebGL)

- **Semantic zoom, two axes:** breadth = prominence-gated LOD (zoom out → ~6 PATTERN nodes; zoom in → ideas
  fade in as they clear the threshold); depth = **epistemic zoom** (into a node → relationships → passages →
  provenance → confidence), shallow stub in v1.
- **Interactions (rebuilt clean from a prior viewer):** degree-prioritized, zoom-tiered, occlusion-tested
  labels; glow nodes colored by type, sized by prominence; edges colored by source cluster, width by weight;
  **click edge → read the *why***; **proposed nodes/edges rendered dashed/dimmed** (visible, inspectable, not
  authoritative); dim-don't-delete focus; min-weight declutter; expand-neighbors; **scenes** (saved viewport +
  eased camera) as the narrative layer.
- **Self-contained render:** the viewer can emit a **single offline HTML file** (inspectable during
  implementation; shareable for the user). Open question: does export freeze decay or keep it live? (§8.7)

## 7. Build process (clean-room, anti-morass)

Each module has an **isolated spec**; implementers work from it alone, with no dependency on prior-prototype
code. Reviewers critique **spec first**, then implementation. **Checklist, each mapped to a CI gate + failure
artifact (from review):** ① one shared schema package; ② no mutable internal state returned; ③ prove the
ingest→graph→dream→view loop end-to-end before adding a module; ④ processors stateless (state in the Store);
⑤ **one validated decode path — heavily tested, non-negotiable** (the JSON-at-scale guard); ⑥ single owner for
rendering; ⑦ keep real integration tests; ⑧ secret-scanning pre-commit hook; ⑨ one test framework; ⑩
refactor-in-place; **⑪ a 65-note regression fixture** with frozen thresholds (edge-count range, ≥X% both-
endpoint reasons, ≤Y ungrounded lucid nodes/dream) + the §2 dream-eval protocol, so "prove the loop" isn't
theater.

## 8. Resolved decisions (were debates) + still-open

- **8.1 Vector store — RESOLVED: in-graph (SQLite + sqlite-vec).** Hidden behind `query_similar()` so the
  backend is swappable; real risk is lock contention → **WAL + single writer**; predefine a migration trigger
  (e.g. p95 top-k > 150ms at 100k nodes) so it's a benchmark, not a religious debate.
- **8.2 Renderer — RESOLVED: custom Canvas/WebGL** (semantic zoom / fade-on-zoom needs it).
- **8.3 Connect timing — RESOLVED:** analytic Connector = explicit/background, viewport-scoped, budgeted;
  dream = global generative. No silent auto-wire on ingest.
- **8.4 Resonator — RESOLVED: minimal + one cheap clusterer** (need regions for the pyramid); PageRank/Hebbian
  learning fast-follow; anti-popularity normalization in.
- **8.5 Dream boundary — RESOLVED:** walker + weave + lucid-extract + fast-decay in v1; lucid-extract runs as
  generation but its residue is `proposed` (gated as mutation). Consolidation / chaining / circuit-breaker
  next.
- **8.6 Language & schema — RESOLVED:** schema-first now (JSON-Schema/Zod), protobuf deferred to the first
  multi-language/external-author boundary; strong validation/decode tests non-negotiable. Engine language TBD
  behind the schema contract (Ollama over HTTP means TS isn't disadvantaged).
- **8.7 Still open:** the exact numbers for the §2/§7 gates (set with real runs); whether the offline HTML
  export freezes decay or keeps it live (documents vs. living organisms); edge-model detail — Grok's
  `kind`+`polarity` semantics via Codex's `edge` + `edge_assertion` split (adopt as written).

## 9. First slice

Write the **Graph Store spec first** (it's the contract everything depends on) — including the status
lifecycle and propose/commit — review it, build it with tests, then Ingest + a trivial viewer to see real
nodes, then Connector, Resonator, Dream. Prove the loop end-to-end on the ~65-note seed corpus before widening.

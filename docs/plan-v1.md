# tessera v1 — plan (for review & debate)

*Status: draft for teammate review. Reviewers (Codex, Grok): you're teammates who love quality and want to
build something great with us — and who shield us from nothing. **Critique to improve, not to tear down** —
build on what works, challenge what doesn't, and leave the plan sharper than you found it.*

***Please structure your critique as I like / I wish / I wonder:***
- ***I like*** *— what's working and worth building on (keep the good; say why it's good).*
- ***I wish*** *— what would make it stronger, stated as a constructive want with the stronger version
  proposed, not just a fault named. This is where you challenge the load-bearing choices and the §8 debates.*
- ***I wonder*** *— open questions and sparks: new possibilities, things we haven't considered (especially the
  §4 node taxonomy — help us find types we're missing — and the §8 debates).*

*Who you're building with: **Brian Brewington** — a senior engineering leader (autonomous-vehicle simulation
and safety) with a Dartmouth PhD under George Cybenko on the **optimal allocation of scarce observational
attention** (when a web crawler should re-observe a changing world under a fixed budget). That work is the
direct root of tessera's **prominence** model. He also built geo-partitioned MapReduce for Google Maps — the
map-tile-pyramid lineage behind the semantic zoom — holds a patent on prominence-based map rendering, and is
writing a book on institutional review as attention allocation, where several of these ideas incubated. Two
things that matter for working with him: he treats attention/salience as a first-class quantity and thinks in
systems; and he asks to be **leveled with, never flattered** — treat his choices as hypotheses to sharpen,
not verdicts to ratify.*

*This plan is otherwise self-contained — you need no prior context. It distills lessons from several earlier
prototypes Brian built (a knowledge-graph backend, a graph viewer, an embedding-experiment toolkit, a
mind-map editor, a persona synthesizer, and a multi-agent social simulator), cited only as "a prior
prototype"; detailed provenance lives in a companion `ideas-ledger.md`.*

## 1. What we're building

**Identity (v1):** a **zoomable idea-map with a dream engine** — ingest heterogeneous material into a typed graph,
compute prominence, render it as a semantic-zoom map, and let a "dream" engine generatively surface
non-obvious connections. **Destination (later, not v1):** proactive, inspectable memory — a system where
relevant knowledge surfaces *unbidden* ("the user doesn't query memory; memory arrives") rather than only on
explicit search. v1 builds the means; we do not lead with the destination.

**What's distinctive (judge the architecture against these two bets):**
1. **Prominence-gated semantic zoom.** What renders depends on the zoom level *and* each node's
   **prominence** — an "elevation" that rises with use and decays with neglect. Zoom out → only
   high-prominence hubs and cluster-summary nodes show; zoom in → detail blooms in. This is map-tile /
   level-of-detail behavior, not a flat force-directed graph. We call this multi-resolution structure the
   **pyramid**. Prominence is **dynamic** — the map changes shape as the corpus is used.
2. **A generative "dream" pass** that surfaces *non-obvious* connections (see §5), distinct from analytic
   nearest-neighbor linking (§4, the Connector). The dream is what makes tessera a thinking instrument, not
   just a graph viewer.

## 2. v1 scope (the smallest *visible* slice)

In: **Ingest** (markdown first, then PDF/docx/image) → **Graph Store** → **Connector** (analytic edges) →
**Resonator** (prominence) → **Dream** (minimal) → **Web Viewer** (semantic zoom). Seeded on a real corpus:
~65 notes from the author's own writing, expanding.

**v1 success (usability, NOT graph aesthetics):** the user can ingest a corpus, see a prominence-ranked
zoomable map, click an edge and read *why* it exists, and trigger a dream that surfaces at least one
connection they judge non-obvious-but-apt. If the dream never produces an apt surprise, v1 has failed at its
one differentiating job.

**Explicit non-goals for v1:** proactive "memory-arrives-unbidden" surfacing (the §1 destination, later);
multi-graph dashboards; distributed / multi-machine dreaming; real-time collaboration; deep epistemic zoom
(v1 ships only a shallow stub — see §6); authentication. No feature ships before the ingest→graph→dream→view
loop works end-to-end on real data.

## 3. Architecture & seams (positions taken — sharpen these)

- **One hard contract: the Graph Store** = the sole writable source of truth. Every other module is a
  *client* of a narrow API: `upsert_node` (dedup-reinforce on cosine >0.99), `link`, `query`,
  `get_subgraph(min_strength, limit)`, `reinforce`, `decay`, `prune`, `export`. Nothing reaches into another
  module's internals. **This is the anti-morass move** — an earlier prototype died of leaky cross-module
  state (a getter returned an internal array by reference; the whole pipeline became load-bearing on that
  leak).
- **Two deployables:** an **engine** (headless, owns the Store + pipeline, exposes a small HTTP/JSON API) and
  a **web viewer** (the semantic-zoom UI). We deliberately collapse an earlier prototype's 5-service mesh
  into ONE engine — that service sprawl outran its integration and was a primary cause of unmaintainability.
- **Modules, each an isolated spec, all Store clients:** Ingest · Embedder · Connector · Resonator · Dream ·
  Pyramid/LOD builder.
- **One shared types/schema package** consumed by every module and the viewer (single source of schema
  truth; validated at every boundary).
- **Proposed stack (contested — see §8):** engine language **[Python vs TypeScript — DEBATE §8.6]**; storage
  **SQLite + sqlite-vec [DEBATE §8.1]**; viewer **custom Canvas/WebGL** (decided — semantic zoom needs it);
  local model runtime **Ollama** (`embeddinggemma` for embeddings; a local chat model for extraction + dream),
  reached over its HTTP API so language choice doesn't gate model access.

## 4. Data model

**Common node fields:** `id, type (+ subtype/mode), text, embedding, strength, timestamp, provenance,
metadata`, plus a `status` (proposed | durable) and a `pinned` (non-decaying) flag.

**The status lifecycle governs the whole model — one trust rule for everything.** Every node and edge is
`proposed` or `durable`. **Proposed:** visible for inspection (rendered dashed/dimmed, click-to-see-why) but
NOT embedded into shared similarity search, NOT counted as real structure, NOT fed to retrieval/RAG.
**Durable:** grounded — a citation (analytic Connector) OR a human "apt" / repeated independent resurfacing
(Dream) — at which point its embedding is written, it enters mixed node/edge similarity, and it counts toward
prominence + Hebbian wiring. Circuit breaker: sampled hallucination >5% pauses auto-promotion, >10% disables
proposal indexing. *This single lifecycle is tessera's trust model: it gates both **authority** and
**retrievability**, uniformly across nodes, edges, dream residue, and edge-explanations. (It's where the two
review rounds converged.)*

### Node types (v1 core)

*Entities — who/what acts:*
- **PERSON** — a human (real or synthetic persona), with voice and texture.
- **AGENT** — an AI/software actor that *acts on* the graph (reads, writes, runs sessions). Kept distinct from
  PERSON because an AGENT acts **on** the graph while a PERSON is modeled **in** it — different permissions
  and behavior.
- **PROJECT** — an endeavor/body of work that ideas, people, and goals attach to.
- **GOAL** — a desired outcome or intention that motivates activity.

*Ideas — the substance:*
- **CONCEPT** — an atomic idea or notion; the graph's primary content. *(Subtypes: `feeling`, `value`,
  `wisdom` — subtypes, not top-level types, to avoid the 235-type sprawl a prior prototype hit.)*
- **INSIGHT** — a synthesized realization ("aha"); often session-born, and the **graduation target** for a
  rich edge-reason that has become an object of thought.
- **QUESTION** — an open, unresolved thread — what's *not yet* known (the antilibrary).
- **CLAIM** — a *contestable* assertion (vs. a settled CONCEPT); graduation target; powers epistemic zoom and
  conflict views. Internal fields (confidence, evidence *grade* — the described→demonstrated axis) deferred on
  purpose: that's where epistemic zoom later gets its teeth.

*Records — what happened / was captured:*
- **MEMORY** — an episodic record (raw captures land here first).
- **SOURCE** — an ingested artifact (doc/page/image); the provenance root. Carries `last_observed` +
  `observation_budget` — **re-observation priority, kept separate from `strength`.** ("Used a lot" ≠ "the
  world changed, look again" — the crawler-thesis distinction, or prominence quietly conflates the two.)
- **QUOTE** — a verbatim excerpt with exact provenance, anchored to a SOURCE, never smoothed.

*Generative episodes:*
- **SESSION** *(mode: dream | conversation | interview | debate | reflection)* — the shared mechanism:
  **select a cast → run an LLM interaction → emit residue → decay.** `mode` is **not just a label** — it
  drives distinct residue/commit policies: `dream` residue defaults to `proposed` (recency + ε-random cast,
  "tell the story, don't explain"); `conversation` may upsert MEMORY/QUOTE more freely; `debate` emits
  `contradicts`-polarity edges without forcing a merge. Same machinery, different commit ethics.

*Structure & system:*
- **PATTERN** — a generated cluster-summary node = the pyramid's zoomed-out levels. Treated as a
  **materialized view with lineage** (records which cluster/version/run produced it) and a **sticky id**, so
  zoom-out geography stays stable across runs (landmarks, not shifting sand).
- **CONFLICT** — an **n-way** disagreement object (≥3 claims) with its own prominence and zoom behavior. A
  *binary* contradiction is **not** a CONFLICT node — it's an edge `polarity=contradicts`. CONFLICT earns a
  slot only when a disagreement becomes a first-class map landmark.
- **SYSTEM_FEEDBACK** — a pinned, non-decaying note of friction/wish/bug that surfaces to the builders.

*Commitments — the bridge from thinking to change:*
- **ACTION / TASK** — something to do (or done) that a conversation, claim, or insight drove. Carries a
  `status` (`todo | doing | done | dropped`) and **traces back** via `ORIGINATED_FROM` edges to whatever
  motivated it — so the graph can always answer *what changed because we learned this, and why.* This is the
  loop-closer between the idea-map and actual change, and the first real reach toward the "proactive memory"
  destination.

### Deliberately NOT node types (the anti-sprawl calls)

- **PROPOSAL / HYPOTHESIS → a `status`, not a type.** Staged dream/Connector output is any node or edge with
  `status=proposed`. (Resolves the reviewers' PROPOSAL suggestion into the lifecycle above.)
- **SUPPORTS / REFUTES / DEPENDS_ON → edge `polarity`, not types.** The fat relation ontology dies; a tiny
  polarity + the rich reason carry it (see Edges).
- **EVIDENCE grade / METRIC → deferred CLAIM fields** — the described→demonstrated axis; epistemic-zoom
  territory, not v1.
- **BRIDGE → a graph-computed property** (high betweenness / cross-cluster), surfaced in the viewer, not a
  stored type. (Often "what a good dream is" — but it's emergent, so compute it, don't store it.)

### Candidates I ruled to DEFER — flip any into v1 if you want them

- **EVENT** — separate "happened at t" from the MEMORY *about* it. Real, but only bites when memories
  conflict about an event → v2 (epistemic layer); could also be a MEMORY subtype.
- **DECISION** — the *choice-with-rationale* behind an action ("we chose A over B because C," including the
  roads not taken). ACTION/TASK is now v1 core; DECISION stays deferred **unless** you want the choice itself
  as a first-class object, distinct from an action's provenance trace — your call (see the open question below).
- **CONSTRAINT / RULE** — pinned architectural laws (what proactive memory would surface unbidden); belongs to
  the destination/watcher layer. For now, expressible as a pinned CONCEPT/SYSTEM_FEEDBACK.
- **SCENE / VIEW** — saved viewport with narrative provenance; viewer-side state in v1, promote to a graph
  node when narrative tours arrive.

### Edges — structural spine + a separately-embeddable explanation

- **Structural edge:** `from, to, kind ∈ {RELATED, ORIGINATED_FROM, APPEARED_IN, HEBBIAN_ASSOC,
  RESONATES_WITH}`, optional `polarity ∈ {elaborates, supports, contradicts, depends_on}` (the tiny epistemic
  invariant — cheap to filter on, glyph, and run graph algorithms over), `semanticWeight` (cosine, immutable)
  vs `hebbianWeight` (learned co-occurrence — the two never overwrite each other), `status`.
- **Edge assertion (the rich explanation):** a `reason` that names *both* endpoints, its own `reason_embedding`
  **written only when the edge is `durable`** (proposed reasons show on click but never enter the ANN),
  `origin ∈ {connector, dream, user}`, grounding (citation spans), `expert_surprise` (0 trivial → 3
  insightful). Embedded reasons make edges first-class searchable objects (mix node+edge similarity) — but
  only *after* grounding, so a hallucinated dream edge cannot poison retrieval.
- **Graduation:** a `reason` becomes a CLAIM/INSIGHT node when it is **detachable** (asserts something with its
  endpoints removed) + **reusable** (fans to >2 nodes) + **contestable** — gated by `expert_surprise ≥ 2` or a
  human promote, so "Denver is in Colorado" never becomes a CLAIM. *Worked case:* the reason "Trump's
  sycophant-cultivation is the antithesis of Lincoln's team of rivals" graduates to a CLAIM with `elaborates`
  edges from Lincoln and Trump.

**Prominence = lazily-decayed strength.** `S_now = S_last · exp(-Δt/τ)`, half-life τ per type/mode
(SESSION`dream` ≈ 10 min, MEMORY ≈ 7 d, CONCEPT ≈ 1 yr). Computed on access, not by a background sweep. This
decayed strength is the pyramid's "elevation" — kept distinct from a SOURCE's `observation_budget`.

## 5. Engine pipeline

- **Ingest:** an adapter per format behind one interface. Chunk (full-block + dedup; a dual-resolution
  sliding window available but off by default — a prior prototype found eager paragraph-splitting created
  noise). Extraction uses a **negative-constraints prompt** (forbid vague buzzwords like "Strategy/Synergy",
  abstract existentials like "Time/Future", and empty shells like "Project/Team" unless qualified) via a
  single extraction call that returns a structured record (title, concepts, named entities, etc.). New
  captures land in a staging inbox as `MEMORY` nodes, not auto-wired into the graph.
- **Connector (analytic):** edge candidates = embedding-proximity (cosine ≥ 0.75, top-k) + open-triangle
  closure (unconnected pairs that share neighbors), roughly 50/50; **tautology-debloat first** (drop
  "A relates to B" edges before spending an LLM call); then LLM-verify each candidate (keep if confidence ≥
  0.6) with a `reason` that names both endpoints. This runs as an **explicit / background pass, not silently
  on every ingest** (see §8.3).
- **Resonator (prominence):** lazy τ-decay + Hebbian reinforcement when nodes are activated together;
  clustering of related nodes into named "pattern nodes" that become the pyramid's upper (zoomed-out) levels.
  **How much of this is v1 — DEBATE §8.4.**
- **Dream (minimal viable):** *Dream-Walker* — seed on recently-touched nodes, then assemble a "cast" of 3–6
  by walking to neighbors, but with a small probability **ε** teleport to a *random* node instead, so the
  dream reaches distant material (this controlled randomness is what makes surfaced connections feel like
  left-field insight rather than obvious similarity). → *weave* (LLM prompt: "tell the story connecting these,
  don't explain the connection") → *lucid-extract* (run entity-extraction on the dream text; new concepts it
  invents fold back into the graph as nodes) → *fast-decay transience* (the dream node itself decays away in
  minutes; the connections and reinforcement it sparked persist). **Fast follows:** distilling stale dreams
  into permanent concepts, dream chaining, and a circuit-breaker that aborts a dream if graph activation
  collapses into a degenerate loop. **DEBATE §8.5.**

## 6. Viewer (custom Canvas/WebGL)

- **Semantic zoom, two axes:** *breadth* = prominence-gated level-of-detail (zoom out → ~6 region/pattern
  nodes; zoom in → individual ideas fade in as they clear the threshold for that zoom level); *depth* =
  **epistemic zoom** (click into a node → progressively reveal its relationships → supporting passages →
  provenance → confidence). v1 ships only a shallow stub of the depth axis.
- **Interaction/visual design (drawn from a prior graph-viewer prototype, rewritten clean):** zoom-tiered,
  degree-prioritized, occlusion-tested labels (so a dense graph isn't a wall of overlapping text);
  glow-styled nodes colored by type and sized by prominence; edges colored by their source cluster, width by
  weight; **click an edge → read *why* it exists** (a priority feature); dim-non-matches-don't-delete for
  focus; a minimum-weight slider to declutter; expand-a-node's-neighbors; and **scenes** — saved viewports
  with eased camera playback — as a narrative/presentation layer.
- **Self-contained render requirement:** the viewer must be able to render a given graph as a **single,
  self-contained HTML file** (offline, no server). This lets implementation be iterated by inspecting real
  rendered output rather than guessing, and gives the user a shareable single-file export.

## 7. Build process (clean-room, anti-morass)

Each module gets an **isolated spec** derived from the design notes; fresh implementers work from their spec
alone, with no dependency on the earlier prototypes' code (we keep the ideas, not the code — the old code had
become unmodifiable). Reviewers critique each **spec first**, then each **implementation**. **Anti-morass
checklist, enforced:** ① one shared types package; ② no module returns mutable internal state; ③ prove the
ingest→graph→dream→view loop end-to-end before adding any module; ④ processors stateless — all state lives in
the Store; ⑤ one validated decode path for LLM output (no scattered ad-hoc JSON repair); ⑥ a single owner for
rendering (the viewer draws; input handlers only set state); ⑦ keep real integration tests, don't delete them
to make CI green; ⑧ a secret-scanning pre-commit hook; ⑨ one test framework across the repo; ⑩
refactor-in-place, never copy-fork-edit.

## 8. Open debates (argue these — strongest case per side + our lean)

**8.1 Vector store: in-graph (SQLite + sqlite-vec) vs. dedicated (Qdrant / LanceDB / pgvector).**
- *In-graph:* one writable authority, no cross-store sync surface (eliminates a whole class of corruption),
  portable single file, local-first. *Dedicated:* better approximate-nearest-neighbor search at scale, richer
  filtering. *Counter:* a prior prototype's LanceDB integration tests "flaked 40% of the time on lock
  contention." **Our lean: in-graph for v1** (scale is small; a single authority is worth protecting).
  Reviewers: is sqlite-vec's ANN adequate at 10⁴–10⁵ nodes?

**8.2 Viewer renderer — DECIDED: custom Canvas/WebGL.** Recorded here because reviewers may want to
pressure-test it. `react-force-graph` would be faster to stand up and is proven in a prior prototype, but it
is force-directed and fights semantic zoom, which is tessera's core identity; custom Canvas/WebGL gives full
control of prominence-gated level-of-detail, the fade-in/out-on-zoom feel, epistemic zoom, and the map-tile
pyramid. Accepted cost: more to build. Reviewers: any reason this reverses at scale?

**8.3 Auto-connect at ingest vs. wire-on-use only.**
- A prior prototype *disabled* auto-wiring ("start with zero edges; only interaction wires nodes together")
  because eager linking produced a hairball. But tessera's pitch *is* a connection engine. *Reconciliation on
  the table:* the analytic Connector runs as an **explicit/background pass with debloat + confidence gates**
  (not silent auto-wiring on every ingest), and the **dream** is the generative connector. Is that the right
  split?

**8.4 Resonator scope in v1: full (PageRank / community-detection / Hebbian) vs. minimal (degree + τ-decay).**
- Prominence is what the pyramid needs, but full graph analytics may be premature. *Lean: minimal in v1*
  (degree + lazy τ-decay for elevation; simple clustering for pattern nodes); Hebbian learning + PageRank as
  a fast-follow.

**8.5 Dream v1 boundary.** *Lean:* walker + weave + lucid-extract + fast-decay in v1; consolidation, chaining,
and the circuit-breaker next. Open question: is lucid-extract (folding dream-invented concepts back in as real
nodes) too risky for v1 — will it pollute the graph — or is it the whole point and therefore mandatory?

**8.6 Engine language: one vs. two.**
- Python engine (mature ML/embedding libraries) + TypeScript viewer = two languages, two type systems, a
  serialization boundary. *All-TypeScript* = the viewer and engine **share the types package natively**,
  which is exactly the anti-morass remedy (§7①). Note: the local models are reached over Ollama's HTTP API, so
  TypeScript is not disadvantaged for model access, and the engine does little heavy ML beyond calling that
  API + vector math. **A third option we now favor: define the data model first as a language-neutral schema
  (protobuf), generating types for whichever language(s) we pick** — this gives the single shared contract
  without forcing the language choice, and supports external tools/agents authoring graphs. **Lean:
  schema-first (protobuf); language per component behind that contract.** Reviewers: does protobuf's build-step
  cost outweigh a lighter all-TypeScript + JSON-schema approach for a local-first, single-user tool?

## 9. First slice after this plan clears

Once §8 resolves: write the **Graph Store spec** first (it is the contract everything else depends on),
review it, build it with tests, then Ingest + a trivial viewer to see real nodes render — then Connector,
Resonator, Dream. Prove the loop end-to-end on the ~65-note seed corpus before widening.

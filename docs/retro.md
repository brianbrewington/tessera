# tessera — retrospective & decision log

*Append-mostly. We capture what we decide as we decide it, in Brian's words where they carry.
Nothing here is final until it's built. Started 2026-07-11.*

## What tessera is (working intent — sharpen as we go)

A zoomable, prominence-ranked map of idea-space — an **image-pyramid for ideas**, with a
connection engine behind it. Prominence is elevation; zoom decides what renders. Web UI.
Portable data substrate (markdown/JSON). Obsidian demoted to (at most) a note store, not the
display. The through-line: Google Maps tile-pyramids + Brian's prominence-based map-rendering
patent + the dissertation (attention allocation) + the book (*The Attention Line*) all meet in
one object — a prominence-gated map of a connected idea graph.

Name: **tessera** (pronounced, deliberately, *tes-SER-uh*) — one tile of a larger mosaic.

## Decisions locked (2026-07-11)

- **Spine:** the social_project_sim **context-graph + dream** is tessera's spine. The image-pyramid
  (semantic-zoom, prominence-as-elevation) is its new face. Winter viewers/engines are *parts*, not the base.
- **Ingest is first-class and up front:** feed it **markdown, PDF, image, docx**, and whatever we
  extend into next. Adapter-per-format behind one clean interface.
- **The dream is a v1 organ — the soul, not a someday.** Brian: *"the dream is…the DREAM! It's really
  out there! Not something you see much in knowledge bases, if ever. We've gotta try it again."*
- **Salvage = ideas, not code.** The winter code was leaky-interfaced, under-tested, and collapsed into
  an unmodifiable morass that got punted. **We keep the hard-won ideas; we write new code.** Fresh agents
  implement each part **from an isolated spec, knowing nothing of the old code.** Clean interfaces + real
  tests are the non-negotiable remedy for what killed the last one.
- **Protobuf: deferred (2026-07-11).** Both teammates said protobuf-*first* is premature; **schema-first
  survives**. v1 = JSON Schema / Zod-TypeBox as single source of truth, generate OpenAPI; graduate to protobuf
  at the first true multi-language / external-author boundary. Upside: human-readable/editable JSON. But
  datatype issues get gnarly at scale, so **strong tests on the validation/decode path are NON-NEGOTIABLE**
  (Brian's battle-scar: hand-rolled JSON parsers that break at runtime trap the whole design). Upgrades §7⑤
  from a checklist line to a load-bearing, heavily-tested invariant.
- **Edges-with-explanations — RESOLVED (2026-07-11; Codex+Grok consult, near-total consensus).** Revived from
  `embeddings_experiment/node_vs_edge_rag` (edges carry an embedded NL `reason` → edge = searchable semantic
  object; ExpertSurprise 0=trivial→3=insightful; hallucinated edges actively harmful, >10% = broken).
  - **Explained, not dumb — but structural edge is separate from the embeddable explanation.** Edge = thin
    structural part (`kind` ∈ RELATED/ORIGINATED_FROM/APPEARED_IN/HEBBIAN_ASSOC/RESONATES_WITH; optional
    `polarity` ∈ elaborates/supports/contradicts/depends_on; weights; status) + a rich NL `reason` modeled as
    a first-class object (Codex: an `edge_assertion` record; Grok: a "retrieval-object" layer) with its own
    embedding.
  - **Rich reasons flatten the SPRAWL, not the invariant.** Both pushed back on full subsumption: Brian's
    instinct is right for *content* (a rich reason > `REFUTES`, and searchable) but wrong for *structure* — a
    tiny polarity/type stays, for filter-without-embedding, UI glyphs, and graph algorithms. Counterexample:
    "all contradictions involving Lincoln" needs `polarity=contradicts` (exact); reason-only ANN misses
    paraphrases + adds false-positives. "Polarity is the cheap invariant; reason is the content." So
    `REFUTES` → `polarity=contradicts` + rich reason; the fat relation-type ontology dies, a tiny one stays.
  - **A reason graduates to a CLAIM/INSIGHT node** when it's detachable + reusable (fans to >2 nodes) +
    contestable (Grok: ≥2 of 5 tests; Codex: any of 3). Lincoln/Trump → a CLAIM node with `elaborates` edges
    from Lincoln & Trump. Gate graduation (ExpertSurprise≥2 or human) to avoid "Denver-in-Colorado" CLAIM sprawl.
  - **Unifying discipline — a status lifecycle gates BOTH authority AND retrievability:** `proposed` (reason
    visible in the inspect panel, rendered dashed/dimmed; NOT embedded, NOT in shared ANN, NOT in RAG) →
    `durable` (citation-grounded [Connector: the ee 3-layer check] OR human-apt [Dream] OR N independent
    resurfacings → embedding written; enters mixed node/edge similarity; counts toward pyramid/Hebbian).
    Circuit breaker: hallucination >5% pause auto-promote, >10% disable proposal indexing. **This is the same
    proposal/quarantine tier the first plan-review demanded for dream output — the two review rounds converge
    on ONE trust model for nodes, edges, dream output, and edge-explanations alike.**
  - Killer failure mode both named: an ungrounded dream edge embedded immediately ranks high on a query →
    enters RAG / becomes a Hebbian hub → self-amplifying false cluster (the ee >10% regime).
    Quarantine-without-embed prevents it. Folds into plan-v2 §4 (edges) + §5 (grounding) + §6 (dashed proposed edges).

## Identity & sequencing (decided 2026-07-11)

- **v1 identity = a zoomable idea-map with a dream.** Build this first.
- **Destination = proactive, inspectable memory for human–AI work** ("the agent doesn't query memory;
  memory arrives"). The map + dream + epistemic zoom are the *means* by which memory becomes visible,
  auditable, and timely. We grow into this; we don't lead with it.
- **Epistemic zoom is now a second axis of the pyramid:** breadth (prominence gates which nodes render) ×
  depth (zoom into a node → relationships → supporting passages → extraction history → confidence →
  conflicting evidence). Still Maps-native (a tile has zoom level *and* layers).
- **Far horizon (Brian's winter idea, beyond the spine — recorded, not scheduled):** a "holdout window" +
  "watcher" agent that injects hints it judges *relevant but not obviously so* — recreating how relevant
  things surface unbidden, sometimes from way out in left field. The watcher is a *default-mode network* for
  an agent; the dream is its wandering, passive-surfacing is its tap on the shoulder. This is tessera's
  destination expressed as one mechanism — which is why map+dream must come first (nothing to wander yet).
  Extensions Brian added: (a) the hint can be a **bare nudge with no "why"** ("think about grandmother's
  kitchen") — the *timing* carries the intelligence; (b) motivation was **making a small model act like a
  much bigger one** (borrow associative reach via well-placed hints, not parameters); (c) it **is the book's
  "attention guardian"** — a holdout is an attention-allocation surface, and the whole question becomes
  *whose objective does the guardian serve* (benevolent guardian vs. engagement-predator, same architecture,
  opposite principal). "left field" = the dream's ε teleport = the dissertation's epsilon-trickle.
- **Multi-agent orchestration layer — MODERATOR (future layer, above v1; Brian 2026-07-11).** From the social
  simulator: a MODERATOR that seeds/enqueues sessions (a conversation, a dreaming agent, etc.). In tessera's
  model it is **not a new node type — it's a specialized AGENT** whose *role* is to schedule SESSIONs (pick
  cast, choose mode, decide when). The *function* is a **session-orchestration layer** on top of the
  Store+pipeline: the Store holds the graph, the pipeline runs one session, the moderator decides which
  sessions run next. **The recursion this unlocks:** model tessera's own construction — Claude/Codex/Grok as
  AGENT nodes, "build tessera" as a PROJECT node, our reviews as SESSION(debate) nodes, this plan as a SOURCE.
  The first real multi-agent workload tessera orchestrates could be its own continued development (the study's
  own mirror). Sits with the destination layer (watcher / proactive memory); explicitly NOT v1 scope.

## Path-dependence & the generative walk — RESOLVED (2026-07-12; fleet 5-0)

**The twist (Brian).** Prominence is **path-dependent** — the Google-Maps mechanism (search-history / place-visits
decide what gets highlighted), pointed at idea-space. There's context-free prominence, but also path-dependent:
*"a minor idea on first inspection becomes major with the backlinks."* A second idea rode in with it: a walk
doesn't only traverse, it **crafts content** — a transition handle can be an archetypal question bridging to a new
domain; a back-ref is a new edge.

**The reframe that dissolved the bubble worry (Brian's correction — the load-bearing move).** Claude flagged
path-dependence as a filter-bubble risk. Brian corrected it: that narrowing is *also what a good book / good
academic understanding DOES* — a better abstraction, a tighter frame, a usable pattern. *"You have no idea how my
world changed after linear systems clicked for me… but it was the path that made it work."* So **the bubble and the
click are the same mechanism** — path-dependent convergence onto a frame — differing only in whether the frame is
**true** (fits the world) or merely **comfortable** (fits history). We *want* convergence; that's understanding.
North star restated: **manufacture the click, then keep it honest.** Three moves: **converge / synthesize / audit.**

**Grounded in prior art + a convergence.** The "hidden third node" = `embeddings_experiment` EXP-005/EXP-006:
stretching a closure path forces the LLM to *synthesize* an intermediate concept, not relay — the generative
fraction rises with cycle length. The archetypal-question transition IS that synthesized third node. **And the
collapse Brian and blind-Claude reached independently: the generative walk is just the Dream seeded with a
user-supplied path.** The walk and the dream were always one mechanism. (Felt signal: the design confirming its own
coherence — the person carrying the vision and a cold reviewer landing on the same reduction.)

**Fleet re-review — 5-0** (brief + full reviews in `reviews/path-dependence-delta.md`). Codex 5.3-high, Grok
4.5-xhigh, Qwen-30b (box), Qwen-80b (Mac), blind-Claude — independent, convergent: **reframe sound; the
contract-delta as first drafted reached for a heavier surface than its goal required.** blind-Claude deepest again
(the sign-flipped-decay, interpolant-corrupted-`expert_surprise`, and prune-defeated-by-flywheel catches were its
alone). The cheaper decomposition, adopted:
- **Move 1 — path = highlight OVERLAY, not a prominence rewrite.** `S_raw` pyramid stays path-agnostic (`getTile`
  signature untouched); path context is a separate additive `get_heat(path_context)` (Andersen–Chung–Lang
  local-push PPR, `O(1/αε)`), glow over stable geography. Kills flicker + intractability. Faithful Maps reading:
  history highlights a stable base map, it doesn't move the roads.
- **Move 2 — synthesis = guided Dream; bridges provisional.** No new walk verbs; archetypal question = QUESTION/
  INSIGHT node (NOT a BRIDGE type — §4 keeps BRIDGE computed); `origin=dream` inherits the hardened promote-gate +
  **≥1 non-self grounding**; per-session proposed-mint budget; walk-revisits don't reset a bridge's Δt;
  `expert_surprise` NOT the gate for interpolants; bridge dedup on (endpoint-pair + normalized question).
- **Move 3 — WALK is not a Store primitive.** pathway = `SESSION{mode:walk}` + ordinal edges / `mutation_log`;
  callback = `REFERENCES` edge kind. Only genuine Store change = the overlay read + the enum value.
- **Move ε/audit — `frame_debt` meter.** Decay-τ is *sign-flipped* (keeps the comfortable frame fresh, prunes its
  refuters — "deletes the audit's evidence before the audit can see it"). Per-PATTERN `frame_debt`: an ε-landed
  inside→outside edge with `expert_surprise ≥ θ` that the pipeline ignores **increments** the counter instead of
  being discarded. Rising debt + sustained prominence = comfortable-not-true → run the §2 blinded eval inward. Dose
  ε ∝ overlay concentration. This is the dissertation's change-detection turned on an idea-frame (the 2.5-year-stale
  Cushing tile).

**Placement (Brian).** `get_heat` → **Resonator** (transient/dependent — a read-side lens, not durable state).
`frame_debt` → **PATTERN field**. **Net contract surface = two changes** (`REFERENCES` edge kind + `frame_debt`
PATTERN field) + the Resonator overlay + the guided-Dream client. Folded into `plan-v3.md §10` and
`graph-store-spec-v2` §3/§4/§6 + new §11 (not in the v1 first slice — lands after Dream exists — but the schema seam
ships from the start).

## Build — Phases 1–4 (2026-07-12): Graph Store → ingest → connector → viewer, each gated

**First real code, clean-room from the specs.** TypeScript, SQLite + sqlite-vec (better-sqlite3),
Zod decode path, vitest; Node 25 (tsx for scripts). Built in four gated phases — each:
**implement → tests green → light review gate (Codex 5.3-high + Qwen-30b) → next**, honoring the
FIRM REQUIREMENT that every implementation is reviewed before "done."

- **P1 Graph Store core** (`src/store/graphStore.ts`, `db/ddl.ts`, `schema.ts`, `embedder.ts`): full
  v2.1 schema (incl. `REFERENCES` + `frame_debt`), `putNode` (dedup content_hash-primary +
  cosine-secondary, **inside `BEGIN IMMEDIATE` → TOCTOU-safe**), two-tier node vec index, atomic
  `promoteNode` (quarantine→shared copy), `querySimilar`. Gate caught: an **unverified cosine
  formula** (empirically probed sqlite-vec = euclidean L2, `cos=1−d²/2` confirmed and *pinned by a
  test*); a cross-connection TOCTOU (fixed structurally); replay-grade log + SOURCE fields folded
  now to avoid a later migration.
- **P2 Edges + traversal**: `putEdge` (idempotent on (from,to,kind,polarity); polarity `''` not
  NULL; assertion-per-call; **Store-computed `expert_surprise`**; reason→assert-quarantine),
  `getEdges`/`getNeighbors`/`getSubgraph` (induced-edges BFS). Gate: `polarity NOT NULL DEFAULT ''`
  + strict Zod (reject a laundered surprise/strength).
- **P3 Ingest + connector**: recursive markdown adapter (frontmatter + prior suggested-connections
  stripped) → proposed CONCEPT nodes; analytic connector (quarantine kNN → proposed RELATED edges,
  canonicalized pairs, idempotent).
- **P4 Viewer**: self-contained force-directed Canvas (`viewer/template.html`) + exporter
  (`scripts/export-viewer.ts`) — glow nodes, degree-tiered labels, click-to-focus-and-traverse,
  hover-edge-for-why. Gate: drag-vs-click fix (compare to mousedown, not last move).

**Result: a real, walkable graph of the 66 attention notes** (`scripts/build-graph.ts` → live
`embeddinggemma`): 66 nodes, 29 analytic edges. **17 tests green, types clean.** This is the
**analytic MAP only** — no dream, no prominence-pyramid, no path-dependence/`get_heat`/`frame_debt`
yet (all speced, next slices). Gate footguns already logged for the promote-breaker /
`promoteAssertion` / prune-cascade slice.

## Data model / node taxonomy (decided 2026-07-11)

Full taxonomy in `plan-v1.md` §4. Node types: PERSON, AGENT, PROJECT, GOAL / CONCEPT (+subtypes
feeling·value·wisdom), INSIGHT, QUESTION, CLAIM (first-class — carries confidence+evidence, powers epistemic
zoom) / MEMORY, SOURCE, QUOTE / **SESSION** / PATTERN, SYSTEM_FEEDBACK.

**The SESSION abstraction (Brian: "I *love* SESSION. Good abstraction!" — felt signal: delight).** A SESSION
is any ephemeral generative episode — *select a cast → run an LLM interaction → emit residue (new
nodes/edges + reinforcement) → decay*. `mode` distinguishes: `dream` (self-directed, free-associative, recency
+ ε-random cast), `conversation` (multi-party, directed), later `interview` / `debate` / `reflection`. This
**unifies the wandering mind (dream) and the talking minds (multi-agent conversation) into one mechanism** —
and it reaches: the Codex/Grok plan review IS a SESSION(debate) over tessera's own plan (the study in its own
mirror again). §4 explicitly invites Codex/Grok to extend the taxonomy — a place diverse vantage points help.

**§4 landed (2026-07-11).** 16 v1 core node types: PERSON·AGENT·PROJECT·GOAL / CONCEPT·INSIGHT·QUESTION·CLAIM
/ MEMORY·SOURCE·QUOTE / SESSION / PATTERN·CONFLICT·SYSTEM_FEEDBACK / **ACTION·TASK** (Brian's add — the
idea→change bridge, trace-back via ORIGINATED_FROM). Anti-sprawl: PROPOSAL→status, SUPPORTS/REFUTES→edge
polarity, EVIDENCE/METRIC→deferred CLAIM fields, BRIDGE→computed. **DECISION dropped for now** (roads-not-taken
can wait); EVENT/CONSTRAINT/SCENE deferred. Edge model = structural (`kind`+`polarity`+2 weights+status) +
embeddable `reason` (embed only when durable) + graduation-to-CLAIM rule.

**Plan of record: `docs/plan-v2.md`** — consolidates both review rounds + edges resolution + protobuf-defer +
landed §4. Trail preserved: plan-v1.md (pre-review), reviews/ (4 raw teammate reviews), ideas-ledger.md,
history/ (68 source docs), retro.md. **Next session starts here: write the Graph Store spec first** (the
contract everything depends on — status lifecycle + propose/commit), review it, build with tests, then prove
the ingest→graph→dream→view loop end-to-end on the ~65-note corpus.

## Process (Brian's cadence)

Make the dir → conversations & retrospectives → decide **keep / combine / drop** on the winter
work → craft a plan → put the plan in front of Codex and Grok → build the smallest visible slice
→ iterate against something we can actually see.

## Review charter — how we brief the review teammates

**FIRM REQUIREMENT (2026-07-12).** Every spec and every implementation gets teammate peer review via the
current mechanism (`bin/cursor_review` → Codex + Grok, independent) **before it is considered done.** It
reliably finds what we miss. Non-optional — a gate, not a nicety. (A local-model reviewer may be added as an
always-on *trickle* on top of this — see below — but it augments, it does not replace, the Codex/Grok gate.)

**The review picture — local trickle (direction, 2026-07-12).** 2026 local models aren't smaller clouds —
they're architecturally distinct (novel attention, diffusion generation, specialized reasoning), so they
**fail differently and catch different things** (per XDA: Zaya1-8B solved a problem GPT-5.5 *and* Claude Opus
both failed). So a local voice is *complementary judgment*, not just cheap coverage — the strongest form of
Brian's complementary-blind-spots / polarization-as-specialization thread, and his epsilon-trickle made
literal: the rationed frontier reviewers at the gates; a free local trickle reviews *everything*, so nothing
falls below the attention line unreviewed. Candidate local ensemble (all fit 192GB M2 Ultra):
**Qwen3-Coder-Next** (80B-A3B MoE, 8-bit ≈85GB — coder workhorse; 3B active = fast enough to run on *every*
change; 256K ctx reads whole specs/diffs); **VibeThinker-3B** (reasoning specialist, ~96% LeetCode — cheap
2nd voice, different arch); **Zaya1-8B** (the "catches what frontier misses" wildcard); plus the
already-cached DeepSeek-V4-Flash / Qwen3.6-27B generalists. Caveat: local reviews are noisier per-item — the
value is *coverage + architectural diversity*, not per-item peer-of-frontier. Next: pull Qwen3-Coder-Next,
wire a `local_review` path (mirror of `cursor_review`), trial it on the Graph Store spec alongside the
mandatory Codex/Grok gate. **Pipeline shape (Brian, 2026-07-12): near-continuous local reviews, each held to
proper scrutiny by a frontier model** — local = high-recall/noisy proposer on every change; frontier = the
precision/verifier layer that adjudicates (escalate the real, discard the noise). Same propose→verify
discipline as the plan itself. **Remote review node confirmed:** an older Linux box (`X299-A`, 192.168.86.47),
2× Quadro RTX 6000 = **48 GB** VRAM (Turing SM 7.5 → fp16/int4 only, no bf16/FP8/FlashAttn-2), 93 GB RAM,
3.4 TB free, clean slate — destined as the **concurrent code-review server** (dev stays on the Mac Studio).
On-box brief leans vLLM (tensor-parallel ×2, xformers backend) for concurrency; tinker-start with Ollama.

Codex and Grok are **collaborators, not graders**. Brief them as teammates who love quality and
want to build something amazing with us — and who will **shield us from nothing**. A strong
engineering team with high psychological safety: free to build on our ideas *and* to challenge
them hard, because the piece is the point. (This session's plan review already proved the value —
the source-of-truth catch was real, and we took the hit.)

---

## The four winter artifacts — retrospective (keep / combine / drop TBD together)

### MindMapper (`~/mindmapper`) — Vanilla JS + Vite, Canvas, MVC
- **Worked:** the aesthetic (glossy star-map nodes); the **quine-bundle** (self-contained,
  offline HTML — portable and brilliant); **scenes** as guided narrative/vistas; full control of
  a Canvas renderer; direct-manipulation authoring.
- **Wall:** everything is *manual* — hand-placed bubbles, hand-authored scenes. No connection
  engine, no semantic zoom. A beautiful *drawing* tool, not a *discovery* tool; doesn't scale
  past what a human can arrange by hand.
- Data model: `{elements:[bubble{x,y,text,radiusX,radiusY,color,comment}], connections:[{from,to,weight}], scenes:[{viewport, elements, connections}]}`.

### memory-viewer (`~/code/memory-viewer`) — React + react-force-graph-2d
- **Worked:** machine-generated graph rendering; the **degree-driven, zoom-tiered, occlusion-tested
  LOD label system** (crown jewel); glow nodes + type colors; **select-edge → see the explanation**
  (Brian: "was a big thing"); dim-don't-delete focus; min-weight declutter slider; expand-neighbors.
- **Wall:** pure force-directed — no semantic zoom, no prominence-as-elevation. Multi-graph dashboard
  was "structurally premature" (data model couldn't support it). react-force-graph fights sim restarts.

### memory-agent (`~/code/memory-agent`) — LightRAG graph + vector, the backend brain
- **Worked:** edge discovery (embedding proximity + open-triangle closure → LLM-verify, conf ≥0.6);
  edge scoring rubric; **tautology debloat**; **clustering → named pattern-nodes** (= the pyramid's
  upper levels); provenance (chunk-id source tracking); a `get_subgraph` API shaped for a TS viewer;
  69 tests.
- **Wall:** heavy stack (LightRAG/Qdrant); 235 entity types (too many → normalize ~20); LLM-judge
  noise (variance dwarfed signal → temperature-consensus voting as mitigation).

### embeddings_experiment (`~/code/embeddings_experiment`) — the "light up" R&D
- **Worked:** the **"light up" retrieval viz** (2-phase retrieval, activation coloring
  green/yellow/gray, hover shows edge *reason*); citation-grounded extraction; honest measurement
  discipline (judge-noise → consensus).
- **Wall:** R&D, not a product; Plotly/GEXF are analysis outputs, not an interactive app.

### connect.py (today) — the local seed, already running
- Local pipeline: Ollama `embeddinggemma` embeddings → top-k semantic edges → optional local-LLM
  *why* labels, one-way non-destructive writes. Working on the 65 attention-book notes.

---

## Open forks (to chew together, then hand to Codex + Grok)

1. **Renderer:** reuse memory-viewer (React + react-force-graph, fast to stand up, fights semantic
   zoom) vs. custom Canvas à la MindMapper (full control, gives semantic-zoom/prominence-LOD, more to
   build). This is the foundational call.
2. **Engine:** adopt memory-agent wholesale (heavy) vs. lift its algorithms (open-triangle,
   agglomerative clustering→pattern-nodes, debloat, edge scoring) into a lean engine seeded from
   connect.py.
3. **Data model & authority:** the one writable source of truth (Codex's catch); harden the data
   model *before* the UI (memory-viewer's own retro lesson).

---

### social_project_sim (`~/social_project_sim`) — the original motivator, and the richest source
The prior art that *is* tessera's spine, minus the image-pyramid front.
- **Context Graph**: typed nodes (CONCEPT / MEMORY / GOAL / PERSON / PROJECT / INSIGHT / DREAM),
  `strength` (prominence) reinforced by recall/participation and **decayed over time** (forgetting).
  Five connection axes: **Semantic, Hebbian, Temporal, Causal, Affective**.
- **Resonator**: PageRank / Louvain → significance + clusters. This *is* prominence-as-elevation,
  already, and it's **dynamic** — the map breathes as you recall and dream.
- **Hebbian dynamics**: nodes activated together wire together; inactive nodes decay. Ingest =
  embed → dedup (cos >0.90 reinforces instead of duplicating) → link top-k (>0.5).
- **Dream Weaver v2 (Brian's favorite invention)** — the *generative* connection engine:
  1. **Dream Walker selection**: seed biased to **recency (last 24h)**; assemble a cast of 3–6 by a
     chaos-walk — with prob (1−ε) **walk** to a neighbor (association), with prob ε **teleport** to a
     random node (scene-switch / random firing).
  2. **Weave**: LLM prompt "*Weave a vivid, surreal, coherent dream narrative connecting these…
     do not explain the connection; just tell the story.*"
  3. **Lucid extraction**: run entity extraction on the dream text → it **invents new concepts**
     ("Recursive Coffee Algorithms") that fold back into the graph as real nodes/edges.
  4. **Transience = consolidation**: the DREAM node has **fast decay** (half-life ~5–10 min) — it
     *vanishes on waking*. But the concepts it sparked + the nodes it reinforced persist with **slow
     decay** (half-life ~30 days). Short-term → long-term. The dream's work remains; the dream doesn't.
  5. **Chaining**: dream N seeds from dream N−1's fading residue → ideas morph
     (Coffee Mug → Recursive Coffee → Recursive Universe → Big Bang).

**Key realizations for tessera:**
- **connect.py = the analytic connector** (finds edges that already exist). **The dream = the
  generative connector** (makes edges/concepts that didn't). tessera wants **both** — a quiet daily
  indexer and a nightly dreamer.
- **strength = prominence = elevation**, and it's *dynamic*. The image-pyramid isn't drawn once; it
  consolidates. Recall and dreams reshape what's tall.
- **The ε chaos-factor IS Brian's epsilon-trickle IS the book's audit-the-dark budget.** Same
  invariant, third+ domain: a small random exploration budget that stops the connector from only ever
  thickening the obvious. The book's own law, running as tessera's exploration policy.

## Live threads / asides (park here so they don't derail, don't get lost)

- **Multi-model problem-solving as a mechanism** (`~/code/multiagent_conversation`): different
  models solving together automatically, possibly with differentiated capabilities/roles — beyond
  review. Substrate exists (`bin/cursor_review`, model-selectable cross-family). Resonates with the
  agents-as-social-graph thread and with tessera itself (both are graphs of connected exploration).
  Open question: tessera's build *process*, a *parallel* research thread, or an eventual *convergence*?
- **Hierarchical zoom = image-pyramid = the prominence patent**, made runnable over ideas.

# tessera — durable-ideas ledger

*The consolidation tier of the two-tier harvest (raw archive lives in `docs/history/`). These are
the hard-won ideas from six winter repos, deduped and tagged, that we judge durable enough to
recombine. **Specs get derived from this ledger** — so no lesson stays stranded in the dead code.*

**Tags:** `[KEEP]` lift as-is (as design, not code) · `[ADAPT]` lift the shape, change the details ·
`[REFERENCE]` remember it exists, pull when relevant.

**Sources:** `sps` = social_project_sim (Project-Formation) · `ma` = memory-agent · `mv` = memory-viewer ·
`ee` = embeddings_experiment · `mm` = mindmapper · `sc` = SynthCommunity.

---

## 0. Convergent spine (ideas that showed up in ≥2 repos — highest confidence)

- **Prominence = decayed strength; forgetting is a feature.** (`sps`, `ma`) Node strength decays over
  time, is boosted by recall/participation; weak nodes fade/prune. This *is* the pyramid's elevation, and
  it's dynamic. `[KEEP]`
- **Two distinct edge signals, never conflated: semantic (cosine, immutable) vs. learned/hebbian
  (co-occurrence).** (`sps`, `ma`, `ee`) tessera's "objectively similar" and "dreamt-together" edges are
  different and must not overwrite each other. `[KEEP]`
- **Dedup-on-ingest that BOOSTS instead of duplicating** (cosine >0.99 / hash / exact). (`sps`, `sim-01`)
  Repetition strengthens prominence — the "seen again" signal. `[KEEP]`
- **Edges carry meaning, not just topology** (weight + typed relation + a `reason`/`comment` + provenance).
  (`sps`, `ma`, `mm`, `ee`) `[KEEP]`
- **One JSON format, many renderers; portable + self-bundling.** (`mm`, `sps`) The data contract outlives
  any UI. `[KEEP]`
- **LLM-as-judge is noisy — don't trust a single verdict.** (`ee`, `ma`) Use deterministic checks or
  multi-sample/temperature consensus for edge-quality gates. `[KEEP]`

---

## 1. Graph Store & data model (the one hard contract)

- **Node ontology:** `CONCEPT, MEMORY(episodic), GOAL, PERSON, PROJECT, INSIGHT, DREAM, SYSTEM_FEEDBACK,
  KNOWLEDGE` + concept subtypes (person/feeling/value/question/wisdom/project). (`sps` ContextConstants.ts:61-69) `[ADAPT]`
- **Edge ontology:** `RELATED_TO, RESONATES_WITH (auto when cosine>θ), ORIGINATED_FROM (provenance),
  HEBBIAN_ASSOC, APPEARED_IN (dream→cast)`; reserved `CAUSAL_LINK, NEXT_SEGMENT`. Three weights per edge:
  `semanticWeight, hebbianWeight, causalWeight`. (`sps` ContextConstants.ts:14-52) `[ADAPT]`
- **Vector row = full node blob beside the vector** (`id, vector(768), text, type, filterKey, payload(full
  node), timestamp`) so retrieval reconstructs full fidelity. (`sps` VECTOR_SCHEMA.md) `[KEEP]`
- **Provenance is chunk-id based**; wisdom/lesson/memory nodes must carry attribution. (`ma`) `[KEEP]`
- **Pinned / non-decaying node class** (e.g. `SYSTEM_FEEDBACK`, user-pinned). Immune to prominence decay.
  (`sps` phase_19:8-30) `[ADAPT]`
- **Tunable constants worth stealing wholesale** (`sps` ContextConstants.ts): τ half-lives DREAM=1h /
  MEMORY=7d / CONCEPT=1yr; `HEBBIAN_BOOST=0.5, EDGE_CREATION_WEIGHT=0.2, EDGE_BOOST=0.1, EDGE_MAX=1.0`;
  `DECAY_PER_HOP=0.8, EXPANSION_RANDOMNESS 0.8–1.2`; `ANCHOR_COUNT=5, CRAWL_DEPTH=2, CRAWL_MAX_NODES=30`;
  `RESONANCE_θ=0.75, dedup θ=0.99`; context budget `40000B` split 30/70 short/long. `[REFERENCE]`
- **OPEN DEBATE (queued for Codex/Grok): vectors inside the Graph Store (SQLite+sqlite-vec, one authority)
  vs. a dedicated vector DB (Qdrant/LanceDB/pgvector).** sps used LanceDB/Qdrant; ma used Qdrant; note sps's
  integration tests "flaked 40% due to lock contention" on LanceDB.

## 2. Prominence & forgetting (the Resonator)

- **Type-dependent decay half-lives** as the forgetting primitive; `S_now = S_last·exp(-Δt/τ)`. (`sps`
  ContextConstants.ts:82-84) `[KEEP]`
- **Lazy decay — compute-on-touch, no background sweep.** Decay materialized only on access/reinforce;
  avoids an O(N) tick loop. (`sps` ResonanceEngine.ts:21-30) `[KEEP]`
- **Hebbian wiring: nodes activated together wire/strengthen; inactive decay.** (`sps`, `ma`) `[KEEP]`
- **PageRank/Louvain significance + community clustering → named "pattern nodes"** = the pyramid's upper
  levels. (`ma` enrich_folly_graph.py; `sps` Resonator) `[KEEP]`
- **Degree, not importance, is the real label-priority signal** ("importance is often flat 1s; degree gives
  the signal"). (`mv` lib/lod.ts) `[KEEP]`

## 3. Ingest (first-class, multi-format)

- **Strict one-way pipeline: Create → Anchor(vector search) → Wire → Crawl → Hebbian-learn.** (`sps`
  UnifiedGraphManager.addContext:29-118) `[KEEP]`
- **Dual-resolution chunking: semantic (paragraph) + sliding-window (1000ch/500 overlap), tagged by
  strategy;** dedup collapses overlap. (`sps` phase_12) `[KEEP]` — BUT note scar: pure paragraph-splitting
  was later *dropped* for full-block+dedup (phase_18) because splitting added noise. Ship dual but gate it.
- **Wire-on-use, not wire-on-ingest.** sps *disabled* auto semantic+hebbian wiring at ingest ("Start with
  Zero Edges… only provocation wires neurons") after eager auto-linking made a hairball. tessera:
  auto-connection opt-in / interaction-gated. (`sps` UnifiedGraphManager:104-115) `[KEEP-as-lesson]`
- **NEGATIVE_CONSTRAINTS extraction prompt** — forbid buzzwords ("Strategy/Innovation/Synergy"), abstract
  existentials ("Life/Time/Future"), empty shells ("Project/Team/Work"); must be adjective-qualified or
  dropped. The best "don't pollute the graph" prompt in the corpus. (`sps` extraction.ts:1-8) `[KEEP]`
- **UNIVERSAL one-call extraction** → `{participantName, projectName, interests[], concepts[],
  namedEntities[], feelings[], values[], questions[], wisdom[]}`, max 3-5 high-value concepts, "Project≠Person"
  guard, Zod-validated. (`sps` extraction.ts:57-83) `[ADAPT]`
- **Edge reason must name BOTH endpoints** ("related concept" banned); edge-reason quality is the primary
  retrieval lever — improve prompts before buying better embeddings. (`ma` graphrag-playbook) `[KEEP]`
- **Manual step-through feeder** (press Enter per chunk, watch nodes pop in) as an onboarding/intuition tool.
  (`sps` ingestion_options.md) `[REFERENCE]`
- Adapters needed: markdown, PDF, image, docx (+ extensible). Image → caption/OCR; docx → textutil/pandoc;
  PDF → pymupdf. Adapter-per-format behind one interface (the anti-leak design).

## 4. Connector — analytic edge generation

- **Candidate sources, stratified 50/50: embedding-proximity (cosine≥0.75, top-k) + open-triangle closure**
  (unconnected pairs sharing neighbors, scored `0.4·shared + 0.3·jaccard + 0.3·degree_penalty`). Then
  LLM-verify (conf≥0.6). Discovery rate ~78%. (`ma` enrich_folly_graph.py) `[KEEP]`
- **Tautology debloat FIRST** (cheap regex/word-overlap; LLM info-gain only for borderline) — removes "A is
  related to B" edges before anything else. (`ma` score_edges/debloat) `[KEEP]`
- **ATTRIBUTION prompt** — post-retrieval, ask the LLM for "Aha!" connections *between the retrieved nodes*,
  with a strict direction rule (Specific→General, "Ford"→"Auto Industry") + bridging-concept extraction.
  This is tessera's "propose new edges from a retrieval event." (`sps` ContextConstants.ts:230-270) `[KEEP]`
- **Multi-dimensional edge-quality rubric** (nonsensical/info-gain/surprise/specificity/self-contained/
  directionality/retrievability), sampled LLM critic + free metrics (noun-count, reason-length, hop). (`ma`
  score_edges.py) `[ADAPT]`
- **Citation-grounded extraction** (mandatory quote per edge → mechanical+semantic+grounding verification →
  verdict `SUPPORTED/PARTIAL/UNSUPPORTED/CONTRADICTED` drives edge color). (`ee`, `ma`) `[ADAPT]`

## 5. Dream engine (the soul)

- **Dream Walker selection:** recency-biased seed (last 24h) + chaos-walk cast of 3–6: prob (1−ε) walk to a
  neighbor (association), prob ε teleport random (**ε = Brian's epsilon-trickle**). (`sps` v2 narrative) `[KEEP]`
- **Weave prompt:** "connect these; *do not explain the connection; just tell the story*" — surreal,
  metaphorical, characters in a dreamscape. (`sps`) `[KEEP]`
- **Lucid extraction:** run entity-extraction on the dream text → it *invents* new concepts → fold back as
  real nodes/edges. The generative connector (vs. connect.py's analytic one). (`sps`) `[KEEP]`
- **Transience = consolidation:** DREAM node fast-decays (τ~5-10min, vanishes); sparked concepts + reinforced
  nodes persist (slow decay). (`sps`) `[KEEP]`
- **Deep-Sleep protocol:** stale dreams (>10min) are LLM-summarized into permanent CONCEPT nodes, then the
  ephemeral dream is pruned. Principled TTL-with-distillation. (`sps` UnifiedGraphManager:216-261) `[KEEP]`
- **Dream chaining:** dream N seeds from N−1's fading residue; strength scales narrative influence ("vivid" vs
  "vague fading sense"). Ideas morph over a sequence. (`sps` v2) `[ADAPT]`
- **Homeostatic circuit-breaker:** monitor stress σ; if σ>0.8 (diversity collapse / infinite loop) abort the
  dream, log, reset. Inject a "Chaos Seed" when the graph goes stagnant. A dream loop WILL find degenerate
  attractors. (`sps` 10_master_design:168-177) `[KEEP]`

## 6. Retrieval

- **Probabilistic budgeted-priority-queue expansion** (spreading activation, per-hop decay 0.8, randomness
  0.8–1.2) — same query surfaces varied neighborhoods; determinism is the enemy for a living map. (`sps`
  ResonanceEngine:48-121) `[KEEP]`
- **Monte-Carlo crawl with saturation short-circuit** (≤2-hop set; if fits return whole, else roulette random
  walks weighted by edge weight, MAX_FAILURES guard) — the "zoom into a region" primitive. (`sps`
  GraphCrawler:12-100) `[KEEP]`
- **Byte-budgeted partitioned assembly** (30% recent + 70% RAG, cap 40kB, low-context warning = likely
  hallucination). (`sps` askContext:210-268) `[ADAPT]`
- **Multi-query RAG with max-score dedup + keyword→recency fallback ladder.** (`sps` phase_11) `[KEEP]`
- **`get_subgraph` response contract for the viewer** — nodes {id,type,description,degree,importance,summary},
  edges {source,target,label,description,weight,keywords}. (`ma` deep_query.py:83) `[KEEP]`

## 7. Graph maintenance — the Context Audit "MRI" (biggest maintenance find)

- **Read-only "Observation without Modification" audit** that writes `audit_*` scores into metadata, never
  deletes. Four engines: (`sps` context_audit_test/01_design.md) `[KEEP]`
  - **VoidDetector** — vector-search each node, flag semantically-close pairs with NO edge = missed
    connections (feeds the dream engine!).
  - **ConsistencyEngine** — LLM "is '{name}' correctly classified as '{type}'?"
  - **RationaleEngine** — LLM-generate + embed an edge's "why A relates to B", then LLM-judge if sensible.
  - **PatternAnalyst** — feed top-100 discrepancies back to LLM for systemic patterns.
- **Cost-guarded, resumable, checkpointed background jobs** (estimate token cost, prompt if >$5; AuditCursor
  save/load; rate-limited batching). Any always-on dream/maintenance loop needs this. (`sps`) `[ADAPT]`
- **Curator (Quinn) idea-midwife loop:** Spark → refinement interview → draft → archive → *follow-up*
  notification. Maps to "dream connection → is this worth keeping?" human-in-loop. (`sps` phase_20) `[ADAPT]`
- **Hybrid index: vector (semantic jump) + structured `catalog.json` (browse/filter by author/tag/date) +
  `[[wiki-links]]` with red-links for latent/unmade nodes.** (`sps` phase_20) `[ADAPT]`

## 8. Personas & agents-as-nodes (for the multi-agent thread)

- **Question-driven persona synthesis** — texture from ~26 deep interview questions, not demographic stubs.
  (`sc` constants.ts) `[KEEP]`
- **Effort/literacy-tier distribution** (~40/40/20 articulate/conversational/terse + typos) to avoid uniform
  LLM eloquence across a population. (`sc` geminiService.ts:22-27) `[KEEP]`
- **Forced entropy** — externally sample the diversity axis (country, etc.) and inject it; LLMs collapse to
  modal defaults. (`sc`) `[ADAPT]`
- **"Quotes" essence layer** — 3 punchy first-person lines as a compact voice-signature handle per PERSON
  node. (`sc`) `[KEEP]`
- **Anti-groupthink as a first-class role** (provocateur intervenes on shallow agreement; moderator injects
  Civility/Intellectual-Honesty/Anti-Pollyanna). Prevents the graph collapsing into an echo cluster. (`sps`
  multi_party_conversations:97-104) `[ADAPT]`
- **Structured action vocabulary as conversation exhaust:** `TALK_TO, THINK_ABOUT, CREATE, REFER, FOLLOW,
  JOIN, PUBLISH, REMEMBER, DREAM…` — **REFER** ("suggest two *other* nodes should meet") IS the
  dream-connection primitive as an agent action. (`sps` v3:145-158) `[ADAPT]`
- **"I am the Graph" identity:** self = sum of edges (Bundle Theory), one SELF node as a physics anchor;
  REFLECTION nodes; mood = aggregate color of the active subgraph. (`sps` identity_and_self) `[REFERENCE]`

## 9. Viewer & UX

- **LOD label system (port near-verbatim):** priority = `imp·3 + √degree·5`; zoom-tiered thresholds; greedy
  occlusion rejection; hovered node always wins. Solves the hairball-of-labels. (`mv` lib/lod.ts) `[KEEP]`
- **Glow-sprite nodes** (colored glow disc + white inner core at 55% alpha) on near-black → star-map look;
  node color = type, size = importance/log-degree. (`mv` NodeGlow.ts) `[KEEP]`
- **Edges colored by source-node type** (belong to their cluster), width = weight, labels rotated along edge
  at zoom≥2. (`mv`) `[ADAPT]`
- **Select-edge → see the explanation** (hover tooltip + click inspect panel). Brian: "was a big thing."
  (`mv`) `[KEEP]`
- **Dim-don't-delete focus** (query/similarity dims non-matches to α0.12, keeps mental map); min-weight
  "edge richness" declutter slider; right-click **Expand Neighbors**. (`mv`) `[KEEP]`
- **Stability gotcha:** mutate `node.__hidden/__dimmed` in place so `graphData` ref stays stable — else the
  force sim restarts on every filter. (`mv` ForceGraph.tsx:91-118) `[REFERENCE]`
- **Scenes = saved viewport snapshots (`{name,duration,viewport:{zoom,offset}}`) + eased playback** with a
  cubic ease + "whoosh" mid-transition zoom squeeze; cancelable, snap-to-target. tessera's "vistas."
  (`mm` UIManager.js:305-366) `[KEEP]`
- **Quine bundle** — ship app+data as one offline HTML (data as base64, `</script>` built via
  `decodeURIComponent('%3C')` to dodge the self-eating regex; strip debug overlay before snapshot). (`mm`
  PersistenceManager.js:145-219) `[ADAPT]`
- **Theme via COLOR_PAIRS {light,dark} + bidirectional resolveColor** — store one canonical color, render in
  either theme. (`mm` Constants.js:14-22) `[ADAPT]`
- **StorageProvider interface** (`save/load`, local/Drive/URL/IndexedDB implementations) — clean IO seam.
  (`mm`) `[KEEP]`
- **"Light up" retrieval viz** — 2-phase retrieval colors nodes/edges by activation (green>0.7/yellow>0.4/
  gray), hover shows edge reason. tessera's "a query lights a path through the map." (`ee`
  interactive_graph_viewer.py) `[KEEP]`
- **GEXF export** for Gephi interop. (`mm`, `ee`, `ma`) `[REFERENCE]`

## 10. Anti-patterns & hard-won process lessons (the morass autopsy)

*Why the winter code collapsed — build the remedy in on purpose.*

- **Cross-service imports via relative build-artifact paths** (`interaction_queue` imports from
  `../proto/conversation.v3`) → a proto change silently broke another service's tests. **The concrete
  mechanism of "unmodifiable morass."** → tessera: ONE shared types/schema package; modules never reach into
  each other's source. (`sps` code_reviews/08:16-52)
- **Leaky mutable state as public interface** — `getGraph()` returned the internal array by reference;
  everything mutated it directly; "returning a read-only copy would break the entire pipeline silently." The
  engine became load-bearing on a bug. → **Never return mutable internal state.** (`sps` 08:29-35; `mm`
  UIManager doing `model.elements=[]` instead of `model.clear()`)
- **Service sprawl before end-to-end wiring** — 5 services + resonator + Slurm/Jetson designed, but "the
  Brain isn't driving behavior yet." → **Prove the core loop end-to-end before adding a service.** (`sps`
  comprehensive_roadmap:88-90)
- **Stateful orchestration is a trap** — Moderator-with-memory (v1) → stateless Moderator (v2) to kill
  state-ownership ambiguity + context bloat. → **Push state to the graph; keep processors stateless +
  streamed.** (`sps` conversation_service_redesign v1→v2→v3)
- **Framework drift** (root=vitest, services=jest) — standardize once.
- **Loose LLM-output contracts leaning on jsonrepair/regex** — one validated (Zod) decode path; they *had*
  the schema, just didn't route everything through it.
- **Snapshot-clone undo** (`JSON.parse(JSON.stringify())`) — inefficient AND buggy (elements vanished after
  load). Use command pattern / structural sharing. (`mm` bugs.md)
- **O(N) hit-testing / no spatial index** — at graph scale plan a quadtree early. (`mm`)
- **Renderer must own ALL drawing** — the "ghost connection" bug came from the controller drawing to canvas;
  fix: controller sets state, renderer draws. Single owner for rendering. (`mm`)
- **Copy-fork-edit instead of refactor-in-place** (duplicated design docs, `prompts/prompts/`) — a churn
  smell that precedes rot.
- **Testing gap masked by green tests** — "163 passing" achieved by mocking the DB entirely; flaky
  integration deleted rather than fixed, so DB regressions pass CI. Don't delete the hard tests. (`sps`
  code_reviews/07)
- **Secrets in the repo working tree** (the two PATs) — add secret-scanning pre-commit hooks.

---

## 11. Reshaping ideas (`nov` = mindmapper-novel-ideas.md — a service-oriented v2)

*These confirm the convergent spine AND add ideas that could change tessera's identity, not just its parts.*

- **Epistemic zoom (this fuses with the image-pyramid — potentially the biggest single idea).** Zoom is not
  only spatial LOD ("which nodes render") but **epistemic depth**: start at a clean synthesized node → zoom
  reveals its relationships → supporting passages → extraction history → confidence → conflicting evidence.
  So tessera's pyramid has TWO axes of zoom: breadth (prominence gates which nodes appear) and depth (how
  far into a node's evidence/provenance you descend). (`nov` §4) `[KEEP]`
- **Passive memory surfacing / "context holdout" (candidate product thesis).** *"The agent doesn't query
  memory. Memory arrives."* A watcher embeds a rolling summary of the active task and proactively surfaces
  3–8 relevant memories — including lessons the agent wouldn't know to retrieve (unknown unknowns: prior
  failures, architectural rules, unresolved contradictions), each with provenance and decay/replacement.
  Central experiment: *can proactive memory stop an agent repeating a failure it was never told to look
  for?* This is the retrieval-before-acting reflex ("build the pause") made concrete, and it's the book's
  attention-allocation from the *surfacing* side. (`nov` §1) `[KEEP]`
- **Knowledge as CLAIM, not fact.** Store exact supporting passages per claim; **confidence separate from
  importance**; represent **conflicting claims from different sources**; distinguish user-authored / quoted /
  inferred / AI-synthesized; re-evaluate derived knowledge when its source changes; user approve/reject/
  merge/rewrite proposed graph changes. (`nov` §4) `[ADAPT]`
- **Scenes → narrative tours (extends §9 scenes):** per-scene annotations ("what you should understand
  here"), narrative transitions on movement, **AI-suggested tours per audience**, branching (not just
  linear) tours, presentation mode = viewport + generated narration, a "show me how these connect" temp
  tour. *"A graph without a tour is a museum without a guide."* Navigation itself becomes semantic — camera
  movement = movement through an argument. (`nov` §2) `[ADAPT]`
- **Adaptive retrieval that learns (extends §2/§6):** record which retrieved memories were actually *used*;
  strengthen paths that repeatedly help, decay unused ones; distinguish user-curated importance from learned
  retrieval utility; learn useful multi-hop *paths* not just node weights; **counterfactual** eval of
  retrieval contribution. Scar note: the winter Hebbian+freshness loop was "architectural promise" — age
  defaulted to 0, weights never formed a real feedback loop. (`nov` §3) `[ADAPT]`
- **Multi-agent review as complementary blind-spots (= what we're doing now).** Reviewer disagreement is
  signal; preserve independent reviews before cross-contamination; cluster overlapping findings; highlight
  unique findings + severity disagreement; learn reviewer-specific strengths/blind-spots; retrieve past
  findings when similar code appears; feed recurring findings into the passive-memory watcher. This is the
  Codex/Grok loop + Brian's "polarization-as-specialization" thread, formalized. (`nov` §6) `[KEEP]`
- **Systems-pathology-as-curriculum (the education tie-in).** "Pathology first, tools second" — every concept
  taught alongside its failure mode; incidents become structured failure-mode subgraphs; the course produces
  the memory, tessera tests whether that memory changes future behavior. Connects to Brian's K-12/workshop
  thread and the book's failure canon. (`nov` §5) `[REFERENCE]`

**The v2's own recommended identity:** *"MindMapper as proactive, inspectable memory for human–AI work"* — a
system that remembers what humans and agents learn, recognizes when it matters again, and shows why.

## Open questions this ledger raises for the plan (→ Codex/Grok)
1. Vector store: in-graph (SQLite+sqlite-vec) vs. dedicated DB (§1 debate).
2. Auto-connect at ingest vs. wire-on-use only (§3 — sps retreated to wire-on-use; but tessera's whole
   pitch is a connection engine — reconcile: analytic connect is opt-in/background, dream is the generative one).
3. How much of the Resonator (PageRank/Louvain/Hebbian) is v1 vs. earned — it's the prominence the pyramid needs.
4. Dream as v1 organ (decided yes) — minimal viable dream = walker + weave + lucid-extract + fast-decay;
   deep-sleep consolidation + chaining + circuit-breaker as fast-follows.

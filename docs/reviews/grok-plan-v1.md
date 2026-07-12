## I LIKE

**The two identity bets are load-bearing and testable.** Prominence-gated zoom (§1) and dream-as-generative-connector (§5) are not vibes — they give a falsifiable v1 bar: “apt surprise or fail.” That is rare and good. It also keeps you from shipping a prettier Gephi.

**Sole-writable Graph Store + “no mutable internals” (§3, §7②④) is the right scar.** The prior `getGraph()`-by-reference failure mode is exactly how pipelines become unmodifiable. A narrow API with `reinforce`/`decay`/`prune` as verbs, not leaked arrays, is the anti-morass move that actually bites.

**Two edge weights that never overwrite (§4).** `semanticWeight` vs `hebbianWeight` is the difference between “these texts are similar” and “these ideas co-activated in a dream.” Without that, dream residue and cosine edges conflate and you cannot audit *why* an edge exists — which is your own success criterion.

**Negative-constraints extraction + tautology-debloat-before-LLM (§5).** Concrete: forbidding bare “Strategy/Team” and dropping “A relates to B” before spending tokens is how you keep a 65-note corpus from becoming 400 empty shells. That discipline is more valuable than a better embedding model at this scale.

**SESSION as an episode that leaves residue then decays (§4).** The physics metaphor is right for dreams: transient activation, persistent wiring. Fast τ (~10 min) vs CONCEPT (~1 yr) is a real control knob, not decoration.

**Self-contained HTML export (§6).** That turns “does semantic zoom feel right?” into inspectable artifacts instead of demo theater. For a custom Canvas/WebGL bet, this is how you stay honest.

**Schema-first lean (§8.6) matches the anti-morass story.** One contract that outlives language choice is the correct generalization of “one shared types package” — especially if agents/tools will author graphs later.

---

## I WISH

**I wish the Graph Store were sole *graph* authority, not sole *writable* authority for everything.**  
Stronger version: Store owns nodes/edges/strength/provenance; treat **staging inbox, dream drafts, viewer scenes, and audit scores** as separate write domains with explicit promote/commit into the Store. Failure scenario: lucid-extract invents 12 concepts in one dream; if the only write path is `upsert_node`, pollution is irreversible without a quarantine tier. Your own ledger already has “Observation without Modification” audits and a curator midwife loop — bake a **proposal → accept** seam into the Store API (`propose_node` / `commit_proposal`) rather than pretending every write is equally authoritative.

**I wish the two-deployables split named the *third* contract: the viewer’s graph snapshot.**  
Stronger version: Engine HTTP API *and* a versioned **export schema** (the single-file HTML payload) are both first-class contracts, with a compatibility test: “export from engine → open offline → click edge → reason string present.” Otherwise you will re-learn the 5-service mesh failure as “engine and viewer disagree about `get_subgraph` shape” while congratulating yourselves on collapsing to two deployables.

**I wish §7’s checklist added a quantitative gate, not only process commandments.**  
Stronger version — add ⑪: **corpus regression fixture** on the ~65 notes with frozen thresholds, e.g. after one Connector pass: edge count in [N_min, N_max], ≥X% of edges with both-endpoint reasons, ≤Y lucid-extract nodes per dream without human accept, and “delete no flaky integration tests” already implies they exist — name the golden-path test that must stay green. Without numbers, ③ “prove the loop” becomes theater.

**§8.1 — I wish you kept in-graph SQLite+sqlite-vec but wrote the escape hatch now.**  
Stronger version: Store API hides vector search behind `query_similar(embedding, k, filters)`; sqlite-vec is an implementation detail. At 10⁴–10⁵ nodes × 768-d, brute/ANN adequacy is usually fine for local-first; the real failure mode is **lock contention during concurrent dream + Connector + viewer poll**, which is exactly what flaked LanceDB 40% in the prior prototype. In-graph wins for v1 *if* you serialize writers or use WAL + single writer. Do not invent a second store in v1 — invent a **vector backend interface** so day-100 migration does not rewrite modules.

**§8.3 — I wish “background Connector” were more wire-on-use than you think.**  
Stronger version: **ingest = SOURCE + MEMORY + extraction staging only; first edge budget is spent on user focus or dream cast.** Worked example: 65 notes → ~200 CONCEPT candidates → cosine≥0.75 top-k can easily propose thousands of pairs; even with tautology-debloat + conf≥0.6 you get a hairball *before* the user has zoomed once. Run Connector as an explicit pass *scoped to a viewport/subgraph* (or “connect this region”), not “whole corpus overnight.” Dream remains the global generative connector; analytic connect is local and intentional. That reconciles “connection engine” with the sps scar without silent auto-wiring.

**§8.4 — I wish “minimal Resonator” still shipped one clustering path that PATTERN nodes actually need.**  
Degree + τ-decay alone does not produce the pyramid’s ~6 region nodes at zoom-out (§6). Stronger lean: **v1 = lazy τ-decay + degree-prioritized LOD + one cheap clusterer** (connected components / label propagation / simple community on hebbian∪semantic edges above a threshold) → PATTERN nodes. Defer PageRank/Hebbian *learning* — but do not defer “what is a region?” or semantic zoom has nothing to zoom *to* except the highest-degree hubs, which is not a map.

**§8.5 — I wish lucid-extract were mandatory *as generation* and gated *as graph mutation*.**  
Stronger version: v1 always runs weave + lucid-extract into a **SESSION residue draft** (visible in UI: “dream proposed 4 concepts / 3 edges”); commit requires one click or a consolidation pass. Failure scenario: dream invents “Resonance Topology” as a CONCEPT near-duplicate of three existing nodes under cosine 0.85–0.98 (below your 0.99 dedup); graph fills with dream-poetry synonyms. Pollution is not “lucid-extract exists”; pollution is **upsert without human or consolidation gate**. Keep lucid-extract; lose silent fold-in.

**§8.6 — I wish you did not pay protobuf’s tax until a second consumer exists.**  
Stronger version for a local-first single-user v1: **JSON Schema (or Zod/TypeBox) as the source of truth in one package**, generate OpenAPI for the HTTP API, reserve protobuf for when an external agent/tool needs a wire format. Protobuf’s build step + partial JSON mapping friction is real cost for SQLite+HTTP+Canvas; the anti-morass win is “one validated decode path” (§7⑤), not “binary IDL.” Schema-first: yes. Protobuf-first: premature until the third client appears.

**I wish CLAIM stayed in the ontology but got one cheap discriminant in v1.**  
Not full evidence grades — just `origin: user | quoted | extracted | dream-synthesized`. Without that, epistemic zoom’s stub has nothing to stub *on*, and dream pollution is invisible in the type system.

---

## I WONDER

**Is SESSION over-collapsing process with product?**  
Dream and conversation share “cast → LLM → residue → decay,” but they differ on success metrics, UI, and permissions: dream optimizes for *surprise under ε-teleport*; conversation optimizes for *goal progress and turn-taking*; debate (this review) wants *preserved disagreement*. Worked split: keep **EPISODE** (or SESSION) as the shared runtime mechanism, but make `mode` drive **different residue policies** — e.g. dream residue defaults to proposed; conversation residue can upsert MEMORY/QUOTE more aggressively; debate emits CLAIMs that may `CONFLICTS_WITH` without forcing merge. Same machinery, different commit ethics — otherwise “mode” is a string that changes nothing.

**What node types are missing?**

| Candidate | Why it might earn a top-level slot |
|-----------|-------------------------------------|
| **CONFLICT / TENSION** | Pair or n-way of CLAIMs that should not collapse into RELATED_TO; epistemic zoom needs a first-class disagreement object. |
| **BRIDGE** | Explicit “these two clusters meet here” — often what a good dream *is*; distinct from PATTERN (summary of one cluster). |
| **CONSTRAINT / RULE** | “Never auto-wire on ingest,” negative constraints, architectural laws — pinned, retrievable, what proactive memory would surface unbidden. |
| **VIEW / SCENE** | Saved viewport is currently viewer-only; if tours become narrative (§ ledger), scenes want provenance in the graph. |
| **PROPOSAL** | Staging for dream/Connector output before commit — or subtype of SYSTEM_FEEDBACK / SESSION residue. |
| **METRIC / MEASUREMENT** | For described→demonstrated later; even a stub type signals the epistemic axis. |

**What should demote to subtype?** PROJECT and GOAL often behave like CONCEPT with different τ and UI — keep them top-level only if Resonator half-lives and viewer glyphs truly diverge. AGENT vs PERSON: keep if voice/permissions differ; else PERSON with `kind: human|synthetic|software`.

**Where does “attention budget” live as data?** Brian’s crawler thesis is *scarce observational attention*. Prominence is half of that (what has elevation). I wonder whether v1 needs an explicit **observation budget / last-observed** on SOURCE/MEMORY (re-ingest priority), separate from strength — otherwise prominence conflates “used a lot” with “world changed and we should look again.”

**ε-teleport vs VoidDetector.** Ledger’s VoidDetector (near in embedding space, no edge) is a *targeted* surprise prior. I wonder if dream casting should bias ε-teleports toward void pairs rather than uniform random — same “left field” feel, higher apt-surprise rate on 65 notes.

**Can the pyramid’s PATTERN nodes be wrong in a way that looks right?** If clustering is unstable across Connector runs, zoom-out geography shifts under the user. I wonder about **pinned PATTERN** or sticky cluster IDs so the map has landmarks, not only elevation.

**Success metric hygiene for dream.** “User judges non-obvious-but-apt” is correct and subjective. I wonder about a tiny protocol: after each dream, binary apt/not + optional “I already knew this edge” — so you can tell pollution rate from hit rate without pretending an LLM judge is ground truth (ledger: LLM-as-judge is noisy).

**Offline HTML vs live engine.** When the single-file export freezes a graph, does prominence continue to decay in the file’s timestamps, or is export a snapshot with decay paused? That choice affects whether shareable maps are documents or living organisms — worth deciding before the viewer owns time.

---

**Sharpest pressure on the plan:** protect the sole-authority Store idea, but insert a **proposal/commit** seam before lucid-extract and bulk Connector writes; keep Resonator minimal on *learning*, not on *regions*; treat SESSION as shared episode machinery with mode-specific commit ethics; prefer JSON-schema-first until a second language consumer forces protobuf.

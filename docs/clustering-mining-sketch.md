# tessera — clustering / mining pass (design sketch)

*A design sketch for cross-model review, not a build plan. Goal: one clustering pass that unlocks three
deferred features at once — the discovered edge taxonomy, communities + pyramid labels for semantic zoom,
and hardened concept-concept edge proposals (the Connector). Be adversarial: the load-bearing decisions are
marked, and the by-hand experiment at the end has a pass/fail number. Tear at both.*

*Status: sketch only. Nothing here is built. Facts marked **[measured 2026-07-26]** were checked against
`graphs/big/graph.db` on that date; everything else is labeled hypothesis or open question.*

---

## 1. Why one pass unlocks three features

All three deferred features are the same operation pointed at different objects: **group similar vectors →
gate the grouping with an LLM verifier → have a model name the group.** The prior work already proved the
shape: `embeddings_experiments` found that a raw cosine threshold at 0.85 **catastrophically over-merged**
("ANN" swallowed 92 entities), that ~0.92 + string-blocking + a **two-gate LLM-verify** got to ~0% false
merges, and — the finding that governs this whole doc — that **embedding geometry does not predict edge
quality**. So the design rule everywhere below is: *geometry proposes, never decides.* Cheap geometric
candidate generation, then verification by small models from diverse families, then a bigger adjudicator.
That is exactly the propose/verify/label micro-task decomposition in `docs/distributed-mining-ideas.md` —
this pass is that doc's first real workload, run by hand on the machines we have before any fleet exists.

The three features, and what each clusters:

| Feature | Object clustered | Vec/table | A cluster MEANS |
|---|---|---|---|
| Discovered edge taxonomy | de-anchored RELATED reason embeddings | `vec_assert_quarantine` (filtered to RELATED assertions) | a KIND of relationship ("is kin to", "works the same trade") |
| Communities + pyramid labels | nodes, by RELATED graph structure | `edges` table (not vectors — see §3.2) | a neighborhood the map can name at altitude |
| Connector proposals | node embedding kNN pairs | `vec_node_quarantine` | a candidate edge no chunk co-mentioned |

Note the third row isn't clustering at all — it's the same two-gate discipline applied to pairs. It rides
along because it shares the proposer/verifier machinery and the same governing finding.

## 2. What already exists (checked, not assumed)

**[measured 2026-07-26, `graphs/big`]** — 12 persona documents, 611 nodes (400 entity nodes after excluding
document/chunk provenance), 411 RELATED edges, 686 APPEARED_IN, 199 ORIGINATED_FROM. 1,407 rows in
`vec_assert_quarantine` (768-dim), 611 in `vec_node_quarantine`. Of the 1,407 assertion vectors, only
**522 belong to RELATED edges** (481 distinct reason strings, all `origin=ingest` — the naive Connector has
never run on this graph); the other 885 are provenance-edge boilerplate. **The taxonomy pass must filter to
RELATED assertions** or the biggest "cluster" will be 885 copies of ingest boilerplate.

De-anchored reason embeddings shipped with ingest (the CRITICAL EDGE RULE in the extractor), so **clustering
needs zero re-ingest** — the vectors are sitting in the store now. Two gaps worth naming honestly:

- **`vec_assert_quarantine` is write-only today.** GraphStore has `querySimilar`/`knnNodes` over the node
  tables but no read path over assertion vectors (checked: the only reference is the INSERT in
  `graphStore.ts:347`). Phase 1 reads the sqlite file directly, read-only, from a script — no store change.
- **`graphs/big/meta.json` does not record which embedder built the graph.** `build-graph.ts` hardcodes
  `OllamaEmbedder(768, "embeddinggemma")`, and the geometry sanity check below is consistent with a real
  embedder, but per-graph embedder config is a known backlog gap and this pass makes it load-bearing:
  a taxonomy is only valid against the embedding space it was clustered in.

**Geometry sanity check [measured 2026-07-26]**, because the embedder head-to-head backlog item warns that
embeddinggemma's space is "~0.92-compressed" for near-dup detection: over the 522 RELATED reason vectors,
a 75-reason sample's pairwise cosine distribution is p5 = 0.334, median = **0.419**, p95 = 0.539; and a
known same-kind pair ("is a brother of" vs "is a sister of") sits at **0.862** vs 0.378 for an unrelated
pair ("is a brother of" vs the recording-studio reason). So at *reason* granularity the space is spread, not
compressed — same-kind pairs sit far above the ~0.42 background. That's one sample on one graph, not a
vindication of the embedder; but it says cluster structure plausibly exists, which is all this sketch needs.

**Graph structure [measured 2026-07-26]:** 386 of 400 entity nodes have at least one RELATED edge
(14 orphans, 3.5%). Connected components of the RELATED graph: one giant component of 319 nodes, two mid
components (33, 30), two pairs. Max RELATED degree 39 (a subject hub), median degree **1** — the graph is a
set of persona-subject stars stitched together by shared places/concepts. That shape drives §3.2's method
choice and its honest risk.

## 3. What gets clustered, exactly, and how

### 3.1 Edge taxonomy — cluster the 522 RELATED reason embeddings

**Object:** one vector per RELATED `edge_assertion` (the de-anchored reason), from `vec_assert_quarantine`
joined through `edge_assertions` → `edges WHERE kind='RELATED'`. Not node vectors — a reason carries the
KIND of relationship independent of who's involved (that was the whole point of de-anchoring), so "attended
the same college" clusters across personas.

**Gate 1 (geometry proposes):** **HDBSCAN** over cosine distance (`min_cluster_size` ≈ 5, sweep 3–8).
Why HDBSCAN over a flat threshold: (a) it has a first-class **noise** label, and "clusters with nothing"
must map to "stays `RELATED`" — the taxonomy is allowed to leave most assertions untyped, and at 522
reasons it probably should; (b) reason-kinds have wildly different densities (kin phrasings are near-dup
tight; "collaborated on X" is diffuse), which is exactly what killed single-threshold merging in the prior
work; (c) no k to guess. Fallback if HDBSCAN is temperamental at n=522 (real possibility): agglomerative
with a conservative cosine cut (~0.75–0.80, tuned on the measured distribution — well above the 0.42
background, below the 0.86 same-kind pair), which is the threshold+blocking shape the entity-resolution
work already validated. This is a tuning fork, not an architecture fork; the experiment in §6 tries HDBSCAN
first and falls back without ceremony.

**Gate 2 (a verifier decides):** geometry over-merges — assume every raw cluster is dirty. For each cluster,
a small model answers the pairwise micro-task from the mining doc — *"same kind of relationship: `<r1>` vs
`<r2>`? y/n"* — over each member vs the cluster **medoid** (n calls per cluster, not n²). Members failing
the check are ejected to noise; a cluster whose ejection rate exceeds ~30% is dissolved entirely (the
"ANN" failure mode: a plausible centroid gluing unrelated things). The verifier checks *kind*, not truth —
edge truth against source text is the separate evidence-verification swarm task and is out of scope here.

**What a cluster means:** a candidate edge KIND. The hierarchy in the backlog (shallow `RELATED` → deep
`ATTENDED_SAME_COLLEGE`) falls out of HDBSCAN's condensed tree for free *in principle*, but at 522 reasons
I expect one usable level — maybe 5–15 broad kinds (kinship, employment/trade, place-of-life, mentorship,
economic-transaction…) — and explicitly **not** the deep taxonomy. The backlog says to do this after
reasons accumulate at real corpus scale; it's right. Phase 1 is about proving the loop, and a shallow
taxonomy that's *correct* beats a deep one that's noise.

### 3.2 Communities — Leiden on the RELATED edge graph, not embedding clustering

**Load-bearing choice:** communities come from **graph structure** (Leiden — or Louvain if the dependency
is annoying; Leiden fixes Louvain's disconnected-community artifact) over the existing `edges` spine, with
edge weight = the edge's RELATED assertion count. Not from clustering `vec_node_quarantine`. Two reasons.
First, semantics: a community on the map should mean "these things are *connected*," which is what the zoom
pyramid renders — a name for a linked neighborhood. Embedding clusters mean "these things are *described
similarly*," which produces map-lies: two vineyards in two personas' lives that share no edge would fuse
into one blob you can't zoom into coherently. Second, the embedding-similarity job is already taken — that's
the Connector (§3.3), which *proposes edges* from vector proximity and then lets the graph structure carry
them. Division of labor: **vectors propose edges; edges define communities.** (Node-embedding clustering as
a community *refinement* signal is a plausible later hybrid; not now.)

**The honest risk at this scale:** with 12 personas and median degree 1, Leiden will mostly rediscover the
persona stars — communities ≈ documents, which provenance already gives us for free. So the community
measurement (§5) explicitly checks agreement between detected communities and the persona-of-origin
partition (NMI or simple purity against `ORIGINATED_FROM`). **If agreement is ~1.0, community detection
earned nothing yet** and the pyramid's continent tier should wait for cross-persona corpus scale (or for
Connector edges to stitch personas together — the two features feed each other, which is itself an
argument for doing them in one pass). The interesting output is precisely the communities that *disagree*
with provenance: a shared-place or shared-trade community spanning ≥3 personas.

**Pyramid fit:** per the viewer seams, degree/strength already drive the country tier; communities are the
continent tier. A community contributes `{members, label, prominence = max member degree}` to `getTile`,
and preserved single landmarks (the Church-in-Kansas rule) are simply high-prominence nodes that render at
altitude *alongside* their community's label, not swallowed by it. Rendering is out of scope (§8); this
pass only computes the community table + labels.

### 3.3 Connector proposals — harden the existing naive pass with the same two gates

`src/connect/connector.ts` already exists and is exactly the thing the prior work warns about: raw kNN over
`vec_node_quarantine` at cosine ≥ 0.55, writing `RELATED` edges whose reason is `semantic proximity
(cos=0.55)` — a banned-phrase-grade non-reason, below any threshold the entity-resolution work validated,
with no verification. It has never run on `graphs/big` [measured: all 522 RELATED assertions are
`origin=ingest`] — good, because run as-is it would hairball the graph (the wire-on-use lesson: eager
auto-linking made a hairball once already).

Hardened shape: **propose** — kNN over node quarantine vectors, k ≈ 6, cosine floor raised into the
validated band (start ~0.75 for cross-type concept pairs; this is NOT entity dedup, so 0.92 is the wrong
anchor — open question, tune against the verifier's reject rate); **block** — drop pairs already joined by
any RELATED edge, and drop same-document pairs (within one doc, chunk co-mention had its chance; the
Connector's value is cross-document); **verify** — the verifier gets both nodes' names + descriptions +
one provenance chunk each, and must (a) answer "is there a real, statable relationship? y/n" and (b) if
yes, *write the de-anchored reason* ("both concern seasonal vineyard labor"), which a second-family checker
then screens for vagueness (the scorecard's banned-phrase check, as a micro-task). Only pairs surviving
both land as `origin: "connector"`, `status: "proposed"` edges with a real assertion — and geometry's
cosine is **discarded**, never stored as confidence, because geometry does not predict edge quality.
Reason-writing is synthesis, so per the mining doc's division of labor it may need the adjudicator-class
model rather than the smalls; the y/n gates are small-model work. Cap per run (Codex's plan-v1 review point
about connector economics: a candidate budget and a per-run edge cap, e.g. ≤50 verified edges/run).

## 4. Labeling — a mining task with a verification gate

A cluster becomes usable when it has a NAME, and naming is generation, so it hallucinates; the design treats
the label as a *claim to be verified*, not an output.

- **Taxonomy labels:** a small model reads ≤15 sampled member reasons → proposes `SNAKE_CASE` kind +
  one-sentence intension ("KIN_OF: a family relationship between two people"). A **different-family** model
  then judges each of the cluster's *held-out* reasons against the label ("does `<label/intension>` describe
  this relationship? y/n"). The label is accepted only if held-out fit clears the bar in §5. Generic labels
  are rejected mechanically before any model call: a ban list seeded from the scorecard's banned phrases
  (`RELATED_TO`, `ASSOCIATED_WITH`, `CONNECTED_TO`…) — a label that could caption every cluster captions none.
- **Community labels:** the labeler reads the community's top-degree member names + types (≤20) and writes
  a short place-like name ("De Doorns farm-labor world"). Verification is thinner here — there's no held-out
  "does this member fit" that's as crisp — so community labels lean on the human spot check (§5) and on a
  same-different control: a judge shown a label and a *shuffled* member list should reject it.
- **Fleet placement:** proposing labels and judging fit are narrow, parallel micro-tasks → the small-model
  tier (a Qwen, a Llama, a Gemma, a Phi — **families, not copies**; K copies of one model just amplifies its
  shared blind spot, per the diversity principle that is the through-line of the mining doc and the whole
  persona_diversity thesis). Collisions, merges of near-duplicate labels, and disputed clusters escalate to
  the adjudicator (the Mac Studio's qwen-14b-class model). On today's hardware "the fleet" is Ollama model
  swaps in a loop — slower, same contract, and that's fine for phase 1.

## 5. Measurement — the numbers that decide

Everything reports through a `mine` section appended to `tessera report` (the scorecard is the fitness
function; a mining pass that can't move a scorecard number doesn't exist). New metrics:

- **typed%** — RELATED assertions assigned a discovered kind (coverage). Noise staying `RELATED` is correct
  behavior, so typed% has no target of 100; it has a floor for usefulness (§6).
- **held-out label fit** — the primary quality number. Per cluster: split members 70/30, label from the
  70%, a different-family judge scores each held-out reason against the label. Report mean fit.
- **shuffled-label control** — the same judge, same held-out reasons, labels swapped between clusters. If
  shuffled fit isn't dramatically lower than true fit, the judge is a yes-machine and the true number is
  void. This control is mandatory; an LLM-judge number without a control is hand-waving (the prior work's
  lesson: llama-3-judge variance swamped signal until deterministic checks anchored it).
- **human spot check** — 20 (label, reason) pairs, blind mix of true and shuffled, Brian judges fit. His
  agreement with the model judge calibrates whether the judge can be trusted unsupervised at scale.
- **community/provenance NMI** (§3.2) + count of cross-persona communities (≥3 personas' members).
- **Connector precision** — of verified proposed edges, % a human accepts on a 20-edge sample; and the
  verifier reject-rate by cosine band (if reject-rate doesn't rise as cosine falls, the geometry floor is
  meaningless and should be re-tuned — this doubles as a live re-test of "geometry doesn't predict quality").
- **stability** — re-run clustering with a different seed / minus one persona's assertions; % of assertions
  whose kind assignment survives. Unstable kinds are not taxonomy, they're weather.

## 6. The by-hand first experiment (what to run Monday)

One graph, one script, no store writes, no new hardware. Target: `graphs/big` (12 personas, 411 RELATED
edges, 522 reason vectors, already built and embedded — zero ingest cost).

1. **`scripts/mine-taxonomy.ts`** (read-only over `graph.db`, like `ingest-report.ts`): pull the 522
   RELATED assertion vectors + reasons; HDBSCAN (via a small py script if the TS ecosystem fights back —
   this is a lab script, not product); write `graphs/big/mine/taxonomy.json` with clusters, medoids, noise.
   Sidecar output only — **the mutation_log/single-writer discipline stays intact; nothing writes to the
   store until a taxonomy earns a real store verb.**
2. **Gate 2 + labels:** medoid-pairwise verify per member (~522 small-model calls), then label each
   surviving cluster from a 70% split and judge the 30% held-out (+ the shuffled control, ~2× the held-out
   calls). Two model families minimum (e.g. qwen2.5:7b propose/verify, gemma or llama judge). Order
   magnitude ~1,500 short y/n calls — an afternoon on the Mac via Ollama, ~zero dollars.
3. **Measure:** the §5 numbers into the report. Human spot check: 20 pairs, ten minutes of Brian.
4. **Same script, second mode:** Leiden over the RELATED spine → communities + NMI vs provenance + labels
   for any cross-persona community. (Cheap: 386 nodes.)
5. **Defer the Connector run** until 1–4 read out — its verifier prompt is informed by what the taxonomy
   finds ("write the reason as one of these kinds, or NONE"), and it's the only step that mutates state.

**Pass bar (decided now, before running):** the pass earns further building if **mean held-out label fit
≥ 0.8 across accepted clusters, with typed% ≥ 0.4 of the 522, and shuffled-control fit ≤ 0.3.** Softer
secondary win: ≥1 labeled cross-persona community that isn't a document. If typed% comes in low but fit is
high, that's a *scale* verdict (need more corpus — expected, per the backlog) and still a green light for
the machinery; if fit is low or the control is high, the reason space or the judge isn't ready and the
right next move is the embedder head-to-head, not more clustering code.

## 7. Risks and open questions

- **Over-merge is the default failure, not the edge case.** Every prior threshold experiment over-merged
  first. Gate 2 is load-bearing; if budget forces cutting anything, cut cluster *count*, never the verify.
- **Geometry ≠ quality, again.** The cosine floors in §3 are candidate-rate knobs, not quality claims. The
  Connector section is where this bites hardest — a beautiful 0.85-cosine pair can be a garbage edge.
- **522 reasons is thin.** Real risk the taxonomy is 5 clusters and 60% noise. That's an acceptable phase-1
  outcome (the loop is the deliverable) but a reviewer should ask whether the experiment should wait for
  the ~150-persona corpus. My call: run now — the harness is reusable and the cost is an afternoon.
- **Embedder unresolved.** The taxonomy inherits every pathology of embeddinggemma, the head-to-head
  (nomic vs mxbai vs SOTA) never ran, and a future embedder swap **invalidates all stored vectors and any
  taxonomy derived from them** — another reason phase 1 writes sidecars, not store rows. The §6 harness is,
  conveniently, most of the head-to-head harness (same data, same fit metric, swap the embedder).
- **Cluster instability / identity.** HDBSCAN assignments jitter under new data. Kind identity must be the
  *label string + intension* (re-derivable, comparable across runs), never a cluster index. Incremental
  policy (re-cluster monthly? assign new reasons to nearest verified medoid?) is deliberately unspecified
  until the first run shows churn numbers.
- **Labeling hallucination + judge sycophancy.** Mitigations: ban list, different-family judge, shuffled
  control, human calibration sample. If the human/judge agreement is poor, no unsupervised number from this
  pipeline is trustworthy — say so in the report rather than shipping the number.
- **Communities may just be documents** at this scale (§3.2). NMI check decides; don't ship a continent
  tier that's secretly a provenance view.
- **Direction is lost.** Many kin/mentor kinds are directional ("is the father of") but RELATED is
  canonicalized undirected (backlog: directed/typed edges). The taxonomy will surface directional clusters
  it cannot yet express; note them in the output, don't solve direction here.
- **Cost creep.** Phase 1 is ~1.5–2k short local calls. At 150 personas it's ~10× — still local-feasible,
  but the Connector's O(n·k) verify budget needs the cap from §3.3 before anyone runs it on a big graph.

## 8. Non-goals (this sketch does not)

- **No fleet hardware, no distributed anything** — the micro-task *contract* is exercised on one Mac;
  Jetsons come only after the mining doc's own first-experiment bar is met.
- **No store schema changes and no writes in phase 1** — no `kind` column migration, no typed-edge enum,
  no community table; sidecar JSON until the numbers earn a store verb (then: taxonomy assignment as an
  assertion-level attribute via a proper mutating verb, logged like everything else).
- **No viewer work** — `getTile`/pyramid rendering consumes the community table later; this pass only
  produces it.
- **No cross-persona entity dedup** — same two-gate discipline, separate backlog item, separate pass; do
  not let taxonomy clustering quietly become entity resolution.
- **No embedder head-to-head** — but the fit-metric harness built here is deliberately reusable for it.
- **No resonator/dream** — though the idle-time re-mining framing means whatever runs here becomes the
  resonator's first substrate; keep the scripts stateless over GraphStore reads with that in mind.

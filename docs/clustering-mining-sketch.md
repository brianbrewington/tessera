# tessera — clustering / mining pass (design sketch)

*A design sketch for cross-model review, not a build plan. Goal: one clustering pass that unlocks three
deferred features at once — the discovered edge taxonomy, communities + pyramid labels for semantic zoom,
and hardened concept-concept edge proposals (the Connector). Be adversarial: the load-bearing decisions are
marked, and the by-hand experiment at the end has a pass/fail number. Tear at both.*

*Status: sketch only. Nothing here is built. Facts marked **[measured 2026-07-26]** were checked against
`graphs/big/graph.db` on that date; everything else is labeled hypothesis or open question.*

> **Revised after a 3-model review (Codex, Grok, Composer — all non-Anthropic).** All three independently
> converged on one flaw: the original pass metric (held-out label-fit) was **circular** — it scored reasons
> held out from clusters those same reasons had already been pruned into, so it measured self-consistency of
> Gate-2 survivors, not whether a taxonomy is real. The **architecture** (geometry-proposes-never-decides;
> Leiden-on-edges not embedding-clustering; sidecar/no-writes; NMI null-test) they judged sound. This revision
> rewrites §5–§6: **negative controls** replace the circular metric, the decision splits into **harness-earned
> vs taxonomy-earned**, the analysis is **frozen before running**, and the framing stops overselling what
> Monday decides. The diversity dividend in action — three families, one disjoint-then-convergent critique.

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
**Known limit (review):** medoid-pairwise cannot catch a *bimodal* cluster — two coherent kinds bridged, each
similar to a compromise medoid — since every member passes "same as medoid." That's why over-merge detection
does NOT rest here: the §5 **cross-cluster/noise false-positive** control is what exposes an over-broad label
downstream; Gate 2 only trims fringe members. If a cheap second-mode check (silhouette split of the cluster)
is easy, add it; otherwise the FP control is the backstop.

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

Hardened shape: **propose** — kNN over node quarantine vectors, k ≈ 6, with a cosine floor that is **an
unvalidated starting rate, not a "validated band"** (review): the node-vector cosine distribution has never
been measured (§5 measures it before this runs), 0.92 is the wrong anchor (that's entity *dedup*, not concept
relatedness), and under "geometry ≠ quality" any floor is arbitrary until the reject-rate-by-band curve
exists — so ~0.75 is a **candidate-budget knob** to start that measurement, nothing more; **block** — drop pairs already joined by
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

## 5. Measurement — the numbers that decide (rebuilt after review)

Everything reports through a `mine` section appended to `tessera report`. The review killed the original
primary metric, so the load-bearing signal is now **discrimination, not coherence**: a label is only real if it
*accepts its own members AND rejects everyone else's*. Coherence alone (the old held-out fit) is a necessary
check that a Gate-2-pruned cluster is nameable — it can be high on a wrongly-merged cluster, so it is reported
but **never decides**.

- **held-out label fit (coherence — necessary, not sufficient).** Per cluster, split members 70/30, label from
  the 70%, a different-family judge scores each held-out reason. **Only clusters with ≥3 held-out reasons are
  reported**; smaller clusters' fit is uninterpretable noise (1/1 y/n) and is listed, not averaged. Report the
  per-cluster distribution + a bootstrap CI, not a lone mean.
- **cross-cluster & noise false-positive rate (the new primary — catches over-merge the shuffled control
  can't).** Score each cluster's label against (a) held-out reasons from *other* clusters and (b) HDBSCAN noise
  points. A real kind must **reject** these. High true-fit with high cross-cluster FP = an internally-consistent
  *but wrongly-merged or over-broad* label (the "FAMILY_RELATION fits every kin reason" failure all three
  reviewers named). The decision signal is the **gap**: true-fit − cross-cluster-FP, per cluster.
- **shuffled-label control (kept, demoted).** Labels swapped between clusters; a coarse discriminability floor.
  Necessary but weak — it only proves the judge can tell KIN from TRADE, not that a cluster is one kind.
- **judge calibration by κ, not by count.** ~40 pairs (blind mix of true members, cross-cluster reasons, and
  shuffled) judged by both Brian and the model; report **Cohen's κ**. If κ is below a pre-set floor (say 0.6),
  no unsupervised number from this pipeline is trusted — say so and stop, don't ship the number.
- **typed%** — coverage (RELATED assertions assigned a kind). **Reported, not gated** at this scale: noise
  staying `RELATED` is correct, and the review showed a typed% floor contradicts the honest scale expectation.
  It informs the *taxonomy-earned* verdict (§6), not the *harness-earned* one.
- **community/provenance NMI** (§3.2) + cross-persona communities (≥3 personas). **Low NMI is not a win by
  itself** — an arbitrary cut of the 319-node giant component scores low NMI with no meaning. A cross-persona
  community only counts if it *also* passes a coherence gate (its members share a nameable place/trade a judge
  accepts, with the same shuffled control).
- **Connector** — first measure the `vec_node_quarantine` cosine distribution (as §2 did for reason space; it
  was never measured, so the §3.3 floor is currently a guess). Then verifier reject-rate by cosine band (if it
  doesn't rise as cosine falls, the floor is meaningless — a live re-test of "geometry ≠ quality") + human
  precision on a 20-edge sample.
- **stability** — re-run minus one persona's assertions; match kinds across runs **by label+intension** (a
  judge answers "same kind?"), never by cluster index; report % of assertions whose *kind* survives. Star
  topology means −1 persona may thrash *communities* structurally (flag it, don't read it as kind-instability).

## 6. The by-hand first experiment (what to run Monday)

**What this run actually decides (reframed after review):** it proves the **propose→verify→label harness and
the judge** on ONE object (the taxonomy), plus a community null-check. It does **not** unlock three features —
the Connector (the only mutating step) is deferred, and communities are expected to ≈ documents at this scale.
"One pass unlocks three" is the *architecture's* promise; Monday earns the *harness*.

**Step 0 — freeze the analysis before looking at any label (kills the tune-to-pass freedom the review flagged):**
register, now, in the script: cluster over the **481 distinct reason strings** (exact duplicates collapsed,
carried as weight), not the 522 rows; pick HDBSCAN `min_cluster_size` by **DBCV** (density-based validity) over
the sweep, tie-break to the smallest, decided by the index and not by eyeballing the labels; fall back to
agglomerative only if HDBSCAN labels >80% noise; an edge's kind is the **majority kind of its assertions**.
These are locked before the run; changing them after seeing §5 voids the result.

1. **`scripts/mine-taxonomy.ts`** (read-only over `graph.db`, like `ingest-report.ts`): pull the RELATED
   assertion vectors + reasons; cluster per Step 0; write `graphs/big/mine/taxonomy.json` (clusters, medoids,
   noise). **Sidecar only — single-writer/mutation-log discipline intact; nothing writes to the store.**
2. **Gate 2 + labels:** medoid-pairwise verify per member; label each surviving cluster from a 70% split;
   then the §5 battery — held-out coherence, **cross-cluster + noise false-positive** (the real signal),
   shuffled control, all by a **different-family** judge. Two families minimum. ~1,500–2,000 short local calls.
3. **Measure + calibrate:** the §5 numbers into the report; the ~40-pair blind κ sample (~15 min of Brian).
4. **Second mode:** Leiden over the RELATED spine → communities + NMI vs provenance; label + coherence-gate
   any cross-persona community.
5. **Defer the Connector run** until 1–4 read out (its verifier prompt is informed by the discovered kinds,
   and it's the only step that mutates state); first measure the node-vector cosine distribution (§5).

**Two verdicts, decided now (not one bar):**
- **HARNESS earned** — the Monday goal, and a *green light* even if the taxonomy is thin: the negative controls
  **separate** (per-cluster `true-fit − cross-cluster-FP` gap large across accepted clusters; shuffled low) AND
  judge **κ ≥ 0.6** AND stability is defined and reported. This says the machinery + the judge are trustworthy →
  build more, and run the embedder head-to-head (the §6 harness *is* most of that harness).
- **TAXONOMY earned** — **not** expected at 522 reasons: harness-earned AND high `typed%` AND labels generalize
  to paraphrases AND kinds stable across the −1-persona run. Deferred to corpus scale, as the backlog says.

**Reading a null result honestly (pre-committed):** thin taxonomy + separating controls + good κ = *harness
earned, taxonomy waits for scale* — a success, proceed to more corpus + the embedder head-to-head. Controls
**don't** separate, or κ low = the reason space or the judge isn't ready — stop clustering, do the embedder
head-to-head first. `typed%` is **reported, never a gate** — the review showed a typed% floor contradicts the
honest scale expectation.

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

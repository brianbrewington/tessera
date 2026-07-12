# Review-of-reviews — a longitudinal study of reviewer attention

*Over time, track what each reviewer catches, what they **all** catch, and where each is **blind** — to build
a picture of native review capability across model families, model sizes, and review sizes. tessera's dev
process doubling as a live measurement of **reviewer attention as a (saturating) channel** — the empirical
core of the attention-allocation framework, exercised on our own artifacts. Append-only, dated.*

## Protocol (log per review round)

- Artifact + **size** (lines / tokens / scope).
- Reviewers (model + role tier).
- **Consensus** — what ≥2 caught (high-confidence).
- **Unique catches** — what only one caught (that reviewer's edge).
- **Blind spots** — what a reviewer missed that another caught (its gap).
- **Adjudication** — the frontier "scrutiny" pass: which local/subagent findings survived, which were noise.
- Emerging profile / notes.

## Meta-study axes (build toward)

1. **Across families** — Codex vs Grok vs Qwen-coder vs Claude-subagent vs … (different training → different
   blind spots; the whole point).
2. **Across sizes within a family** — does catch-rate scale with model size? (Brian runs same-family /
   different-size studies at work — replicate here.)
3. **Across review sizes** — small vs large diffs: where does a reviewer **saturate** and start missing (the
   channel-capacity question, straight from the framework).

## Methodology v2 — rigor upgrades (Codex + Grok convergent critique, 2026-07-12)

*The frontier team reviewed this protocol and **independently converged on the same design** — itself signal.
Raw: `codex-methodology.md`, `grok-methodology.md`. Rounds 1–2 below are now the **exploratory phase**
(pre-rigor, peer-relative "catch"). To carry the framework's empirical claim, adopt:*

1. **Ground truth, not peer-relative catch.** Per *frozen* artifact, build an **Issue Opportunity Set (IOS)**:
   (a) **seeded canaries** — labeled defects planted in a holdout (bugs, missing API ops, O(n²), missing tests;
   planted *contradictions* for prose), reviewers blind to the seed list; (b) a **human-adjudicated finding
   registry** — each atomic finding gets an ID, severity (blocker/load-bearing/nice/noise), type, and a
   **disposition** (accepted / rejected-wrong / deferred / already-known). **Peer discovery is a *signal*;
   disposition is the *label*.** "Catch" = output maps to a dispositioned-true IOS item under a pre-registered
   rubric (actionable + correct + specific). (plan-v3's quarantine-embedding fix is GT only *because* we accepted it.)
2. **Relabel the inferences (they were assumptions).** **Consensus ⇒ redundancy, not confidence** (models share
   priors); confidence comes only from disposition/seeded-recovery. **Unique ⇒ candidate specialization, not a
   proven edge** (edge only if adjudicated-true AND replicated). Add per-reviewer **FDR** (unique-false/total)
   and **tier-PPV** (1/2/3-of-K) — "consensus=confidence" holds only if tier-PPV is empirically monotonic. Split
   DVs: **defect recall** vs **design-coherence** vs **framework-alignment** (mixing them inflated Round 2's
   "strongest reviewer").
3. **Blinded adjudication — never Claude-grades-Claude.** Atomicize findings **stripped of model identity**; **2
   independent raters** (ideally 1 human + 1 non-Claude) + a 3rd for ties; report **inter-rater reliability**
   (Krippendorff α / Fleiss κ). Claude's unique catches adjudicated **cross-family** (Codex/Grok), human tie-break.
4. **Control the confounds.** **Freeze artifact snapshots (immutable hash)** — plan-v1/v2/v3 are *different
   trials*, never pooled; log `artifact_id`. Randomize reviewer order; one time window; **fixed prompt-template
   version + temperature + context-packing** (all logged — huge "model-effect" confounds). Mark **re-review /
   contaminated** (a model that shaped v3 reviewing v3) as a separate condition. Stopping rule: profiles stay
   *exploratory* until ≥12 artifacts × ≥2 modalities × ≥3 size bins.
5. **Operationalize the axes (factorial).** *Family:* fixed roster cells; recall@verified, precision@adjudicated,
   unique-verified, FDR — compared only *within* matched artifact+size. *Size within family (the controlled
   experiment — our gift):* **Qwen 30B-A3B vs 80B-A3B** — same lineage, same prompt/artifact/decode/packing,
   vary **only** size (log 4-bit vs 8-bit quant as a *separate* nuisance factor — don't confound size with
   quant). *Review size (saturation):* size = **tokens** (not lines); within-reviewer saturation curve — inflate
   with **padding** (no new defects → isolates *dilution*) vs **proportional seeding** (→ isolates *capacity*);
   fit asymptotic/logistic; report **half-saturation point + asymptote** = the quantitative *attention line*.
6. **Measure attention *allocation*, not just misses.** As size grows, track the **share of review tokens spent
   per severity tier / topic tag** — saturation = high-severity share falling while stylistic share rises. Add
   **compute budget** as the capacity variable (fix max output tokens/minutes; recall-vs-budget curves).
7. **Ensemble as the estimand.** Pre-register **union recall vs best-single**, **marginal gain** of each reviewer
   conditioned on the ensemble (true diversity gain), diminishing returns of the local trickle after
   adjudication → a cumulative-gain curve that **justifies the gate policy with data**. **Negative controls:**
   near-clean small diffs (any "catch" = pure FDR).
8. **Stats.** Pre-register hypotheses/outcomes/exclusions; **mixed-effects logistic** `caught ~ family * size *
   review_size + (1|artifact) + (1|issue)`; bootstrap CIs.

**Minimal publishable package:** seeded+dispositioned registry → the Qwen 30/80 size ladder → frontier trio
blind on the same ladder → human-adjudicated 20% subset → recall-vs-size/budget curves + FDR + union-vs-best.
Framed as *empirical measurement of multi-agent review as scarce attention under input load* — tessera the
living lab, not the sole object. The framework gets a methods figure; the repo gets a data-justified gate policy.

**Deferred axes (sparks):** artifact **modality** (prose vs code vs tests), **issue-type** saturation
(correctness/security/arch/perf), **review-mode** (spec-first vs diff vs red-team), **sequential adaptive
routing** (cheap-high-recall first, specialist only on residual uncertainty), **drift** (monthly fixed-benchmark
rerun separating model updates from method).

## Working hypothesis — habituation & the size axis (Brian, from work-side experiments, 2026-07-12)

Small models **do** catch things at the **line level**, and are **not** prey to the **habituation errors** that
trap bigger models — but they can't hold the big picture. **Mechanism:** a big model's rich prior *is* a learned
salience function; the same prior that lets it reason globally also lets it **skip the familiar** — which is the
framework's own normalization-of-deviance / LGTM-reflex / alarm-fatigue: an attention router that darkens the
region it has "seen before." So the **size axis is a *reallocation* of attention from local→global, not a
monotone gain**, with habituation as the mechanism of big-model line-level blindness.

**Falsifiable prediction (sharper than "catch scales with size"):** split recall by issue *locality* (line-local
vs global-architectural). As size grows, **global-coherence recall rises while line-level recall flattens or
*drops* in the habituation-trap regime** — a crossover, not a monotone curve. The Qwen 30B↔80B ladder (+ a tiny
model as the floor) tests exactly this.

**It also mechanistically justifies the architecture:** the local trickle is the *un-habituated fresh-eyes line
auditor* (the epsilon-trickle that keeps attending the familiar/dark region the big model learned to skip); the
frontier gate holds the picture. Complementary **by construction**, not merely by "different training."
Corollary: reviewer-attention-as-saturating-channel is then *not a metaphor* — **habituation is *how* the channel
saturates for a big model.**

## Reviewer roster

- **Frontier gate (mandatory, rationed):** Codex `gpt-5.3-codex-high`, Grok `grok-4.5-xhigh` (via `cursor_review`).
- **Native (standing member):** **blind Claude subagent** (Agent tool) — added to the team 2026-07-12 after
  Round 2 proved it the strongest single reviewer (caught load-bearing issues Codex + Grok both missed). Run it
  blind (no sight of other reviews) on every artifact. Caveat: same family as the orchestrator — independence is
  by prompt+blindness, not architecture.
- **Local trickle (near-continuous, free):**
  - Mac Studio (192 GB): **Qwen3-Coder-Next 80B-A3B, 8-bit** — the capable Mac-side reviewer.
  - Linux `X299-A` (48 GB, 2× RTX 6000): **Qwen3-Coder 30B-A3B, 4-bit** — the concurrent review server; first
    of a planned **fleet** of remote nodes.
- **Scrutiny / adjudication:** a frontier model holds the local/near-continuous findings to account (the
  precision layer over the high-recall trickle).

## Round 1 (seeded retroactively) — plan-v1 + edges consult, 2026-07-11

Reviewers: Codex `gpt-5.3-codex-high`, Grok `grok-4.5-xhigh`. Artifacts: `plan-v1.md` (~200 lines) + the edges
consult. Raw in `codex-plan-v1.md` / `grok-plan-v1.md` / `*-edges-consult.md`.

**Consensus (both — became load-bearing):** the proposal/quarantine status tier; quantitative gates (numbers,
not commandments); Connector combinatorial hairball → budget + viewport scope; vector store in-graph *but*
behind an interface + the concurrency risk; SESSION needs mode-specific commit policies (not just a label);
protobuf-first premature (schema-first, defer protobuf); [edges] explained-not-dumb + structural/assertion
split + quarantine-before-embed + graduation-to-node + flatten-the-sprawl-not-the-invariant.

**Codex unique:** per-node `version` + append-only mutation log (concurrency + deterministic replay);
single-process local mode; anti-popularity Resonator correction; red-team dream harness; the
`edge`/`edge_assertion` two-table split; hallucination circuit-breaker thresholds (>5% / >10%);
DECISION/ACTION/EVENT type proposals.

**Grok unique:** the observation-budget/last-observed catch (prominence conflates "used a lot" with "the world
changed" — from the crawler thesis); bias ε-teleport toward VoidDetector pairs; PATTERN sticky-ids +
materialized-view lineage; CONFLICT-as-n-way-only; the `kind`+`polarity` edge framing + the "all
contradictions involving Lincoln" counterexample; the offline-export decay question.

**Emerging profile (TENTATIVE — n≈2 artifacts, one domain):**
- **Codex → operations / engineering-hardening lens.** Concurrency, versioning, CI gates, benchmarks,
  failure-mode thresholds — "how does this not break in production."
- **Grok → conceptual / thesis-alignment lens.** The right abstraction (polarity), framework connections
  (observation budget, VoidDetector), elegant counterexamples.
- Overlap (consensus) = the high-value load-bearing set; *non*-overlap = where each earned its seat. The
  differently-calibrated-blind-spots value, measured.
- **Caveat:** two artifacts, one domain (a design plan). Profiles may shift on code diffs vs. prose — which is
  itself axis #3.

## Round 2 — Claude subagent on `plan-v1` (controlled comparison) — RUNNING

Same artifact, same I-like/I-wish/I-wonder brief, no sight of the other reviews. Question: does a native Claude
subagent catch the Codex/Grok consensus? Anything they missed? (Answers Brian's "does a subagent Claude catch
anything meaningful?")

**Result: YES — decisively, and it caught load-bearing issues BOTH frontier reviewers missed.**

Unique catches (neither Codex nor Grok got these):
- **A real contradiction:** `proposed` nodes aren't embedded, yet dedup (cos>0.99) and the Connector (cos≥0.75)
  both need an embedding to *ground* a node → a fresh proposed node is invisible to the very Connector meant to
  promote it. Fix: two-tier index — always compute embeddings into a *quarantine* index (dedup/Connector read
  it); *promotion* copies the vector into the shared RAG index. "Not embedded" → "not in the retrieval index."
- **Reframed §8.1:** sqlite-vec is brute-force KNN, not ANN → recall isn't the risk; the **Connector's all-pairs
  pass is O(n²)** (~10¹⁰ dot products at 10⁵ nodes, minutes, recurring). Fix: run it over a **dirty set** (nodes
  touched since last pass) — also answers §8.3.
- **`promote(id, grounding)` missing from the Store API** — the sole authority doesn't own its own central trust
  op, and the >5%/>10% breaker can't see the aggregate if promotions are scattered across callers.
- **Deepest catch (thesis-level):** prominence has a neglect term but **no conservation/budget** → a used corpus
  drifts to "everything is prominent" and "zoom out → ~6 nodes" breaks. **Rank-normalize prominence within a
  tile (top-N per zoom, not >threshold)** — which *is* the attention-allocation scarcity law. Absolute strength
  can't tile a pyramid; relative prominence can.
- **Tile-addressable API:** `get_tile(zoom, bbox)` instead of `get_subgraph(min_strength, limit)` — semantic
  zoom is a tiling problem (the map-tile API Brian already built once).
- **`expert_surprise` self-scored by the dream model = fox/henhouse** (and it gates CLAIM graduation) → compute
  structurally or use a separate critic.
- **Pre-register the v1 success test** — "one apt surprise, self-judged" is n=1 confirmation bias, against
  Brian's own pre-register ethos → N dreams, written rubric, ε-vs-neighbor endpoints blinded.
- **lucid-extract = accelerator without brake:** dream concepts fold back → seed next dream (positive feedback),
  but the degenerate-loop breaker is deferred → pull it into v1; add a TTL/GC for unpromoted `proposed` clutter.
- Also: schema-migration + re-ingest-idempotency missing from §7; "where is the user in the graph?" (promotion
  provenance); node-content versioning; lean-flip DECISION into v1.

Overlap with the frontier consensus (reached independently): proposal/quarantine value; defer-protobuf (→
all-TS); SESSION-mode-policy concern, sharpened to *"strategy pattern, or five types in a trenchcoat?"*;
sticky-clustering-is-the-hard-part.

**Emerging profile — Claude subagent = deep design-logic + thesis-alignment + values-awareness.** It found
actual internal *contradictions*, reframed problems more precisely (O(n²), not recall), made the deepest
*framework* connection (prominence conservation = the attention law), and invoked Brian's own *ethos*
(pre-register). Distinct from Codex (ops-hardening) and Grok (conceptual). **This was the strongest single
review of the three — the native reviewer is NOT redundant; the ensemble beats any one.** Caveat for axis-1:
same family as the orchestrator, so its independence is by prompt+blindness, not architecture.

## Round 3 — first live LOCAL reviewer (Linux `qwen3-coder:30b`) — 2026-07-12

First end-to-end `local_review` run: Mac → SSH tunnel → box Ollama → `qwen3-coder:30b` (30B total /
3B active). **Infra works.** ~64 s first call (includes loading the model onto the 2× RTX 6000; warm calls faster).

**Artifact:** a `binary_search` with ONE seeded canary — `lo = mid` (should be `lo = mid + 1`) → infinite loop.
**Result vs IOS ground truth** *(adjudicated by Claude — smoke-test only; real rounds need cross-family):*
- ✅ **Seeded canary CAUGHT** — Bug 1: the `lo = mid` infinite loop, exact line + correct fix. Recall = 1/1 on the planted defect.
- ⚠️ **2 false positives:** Bug 2 (`hi = len(arr)` → "out-of-bounds") is a **convention-mismatch FP** — correct
  under the original's half-open `[lo,hi)` design; the model imposed the closed-interval convention. Bug 3
  (empty-array) is already handled by `lo < hi`. FDR ≈ 2/3 on this artifact.

**What it demonstrates on the very first run:** exactly the design rationale — the small local model is a
**high-recall line-level catcher** (nailed the seeded bug, consistent with the habituation hypothesis: small
models excel line-level) **but noisy** (FDR > 0) — which is *precisely why* the architecture pairs it with
**frontier scrutiny.** A frontier model would filter Bug 2/3 as false alarms. Noisy-proposer + precision-gate,
proven in one shot.

## Methodology upgrade — demand a *demonstration*, not a description (Brian, 2026-07-12)

Prompt every reviewer to back each flaw with the **most concrete demonstrable form available** — a **runnable
failing test** (bug / perf / race) where possible; else a **specific failing scenario** (concrete inputs → the
wrong outcome) or a worked counterexample; **never a bare assertion.** Why it's load-bearing:

- **It self-adjudicates "catch"** — fixes the circularity the frontier flagged. A repro either runs or it
  doesn't (execution-verified, not prose-matched), so the *demonstrable* subset gets objective ground truth for
  free, no blind rater needed.
- **It's a capability probe:** **demonstration-rate** per reviewer measures the describe-vs-reproduce gap
  (Aspire / Brian's work-side finding). New meta-study axis — does it split by size (can small models repro, or
  only narrate)?
- **Tier by demonstrability:** architectural flaws (no clean repro) must still be accepted with a concrete
  failing scenario, or we exclude the frontier's best catches / invite fabricated repros.
- **Goodhart guard (ε-explore):** demanding repros makes reviewers **camp where demonstration is easy** → keep a
  "described-but-not-yet-demonstrated" lane (flagged lower-confidence, queued for adjudication); never let
  "demonstrable" become 100% of the reward, or we lose exactly the class the frontier is best at.

## Second saturation mechanism — context-dilution (ASPIRE, 2026-07-12)

ASPIRE (NVIDIA): *"too much raw visual context can distract the agent from the causal chain that produced the
failure."* This is a **distinct** attention-allocation failure from habituation — the channel saturates by BOTH:
- **Habituation:** the prior *darkens the familiar* — signal skipped because seen-before.
- **Context-dilution:** *excess raw context* buries the causal chain — signal skipped because drowned.

Implications: (1) it **validates the "padding" arm** of the review-size saturation design — padding = adding raw
context *without* new defects → isolates *dilution*; ASPIRE gives it a named mechanism + evidence. The
review-size axis's real variable is **causal-density / SNR, not raw token count.** (2) Practical law for tessera
*and* the review harness: **curate context to the causal chain; don't dump raw** — the book's "dark cockpit"
(only judgment-requiring content stays lit), applied to reviewer prompts, the Dream/Connector candidate set, and
epistemic zoom (show the causal chain, not raw everything).

# Capability observation — reviewer locality & habituation (v2, cross-checked)

*Cross-checked by a 4-reviewer team pass (local Qwen-30B, blind-Claude, Codex, Grok) and rewritten. The review
found the v1 draft **over-claimed** and its experiment was **near-unfalsifiable**; both are fixed below. This is
an **observation about one small/large pair generating a hypothesis** — NOT a result, NOT a size effect (see §3).
Companion to `review-of-reviews.md`. Raw cross-checks in `reviews/capobs-*.md`.*

## The five holes the team found (and what changed)

1. **"Size" is unsupported — every evidence row is cross-vendor** (Qwen-local vs a Claude subagent), differing on
   training/RLHF/provider, not size. There is **no within-lineage size ladder anywhere in the actual evidence.**
2. **The two models were never run on the same artifact.** "Zero architectural reframes" (small) was measured on
   a *different document* than the frontier's reframes. Locality was confounded with artifact identity — and the
   v1 experiment reproduced exactly that.
3. **The prediction couldn't fail.** "Line-local recall flattens *or* decreases" put *flat* on the confirmation
   side — but flat is the **null** (local recall hits ceiling, spare capacity goes global = additive gain, no
   reallocation). It couldn't distinguish habituation from a ceiling effect.
4. **Familiarity was never manipulated** — yet the mechanism is "skip the *familiar*." Without it, a clean result
   can't separate **habituation** (skips because seen-before) from a **budget** story (large just scans lines less).
5. **The "class of catch" coder was Claude itself** (circular), and the one architectural win was **n=1/3** —
   Codex and Grok *both missed* R2's reframes, fully consistent with sampling luck.

## 1. The observation (shrunk to what the evidence carries)

In **one pair** — a small local model (Qwen3-Coder-30B) and a frontier subagent (Claude) — on our first real
artifacts, the local model's catches were **local/completeness** (seeded line bug; missing API verbs, error
cases, tests) and the frontier subagent's were **architectural reframes**. That is *all* the data shows. **Size,
family, quantization, and artifact type are entangled; there is no paired comparison.** Every "size" or
"habituation" or "complementary-by-construction" statement is **deferred to §4's outcome** — do not read §1 as a
claim about model classes.

## 2. Mechanism (the hypothesis §4 tests — not a description of what happened)

*Candidate* mechanism: a large model's rich prior is a learned salience function; the faculty that holds the big
picture also **skips the familiar** (normalization-of-deviance / LGTM / alarm fatigue). A small model lacks the
prior → can't hold the global, but doesn't habituate. If true, "reviewer attention as a saturating channel" is
literal: **habituation is how the channel saturates for a large model.** This is motivation, not evidence.

## 3. Evidence & its confounds

| # | Artifact | Reviewer | Catches | Class |
|---|----------|----------|---------|-------|
| R3 | binary_search, 1 seeded bug | Qwen-30B (local, 4-bit) | the seeded loop (1/1) + 2 FPs | line-level; noisy |
| R4 | Graph Store spec | Qwen-30B (local, 4-bit) | missing verbs/errors/tests | completeness/local |
| R2 | plan-v1 | Claude subagent (frontier) | prominence-conservation; a contradiction | architectural (Codex+Grok **missed**) |

**Confounds (all live):** (a) **family ≠ size** — cross-vendor, no lineage ladder; (b) **no paired comparison** —
each model saw different artifacts; small was *never asked* to reframe plan-v1; (c) **artifact affords the class**
— a spec invites enumeration, a plan invites contradiction-spotting; (d) **quant/host** — 30B is 4-bit on Linux,
80B (Mac) is 8-bit, so "size" ≡ "different compute regime"; (e) **FP asymmetry** — frontier FDR never measured;
the small model's "completeness" may be a **liberal-threshold artifact** (report recall at *matched precision*);
(f) **circular coding** — Claude labeled "architectural vs local," and the architectural win is **n=1/3**
(sampling luck); (g) **difficulty × length** — line seeds in short code are easier than invariant contradictions
in plans; (h) **ceiling** — "flat" local recall may be saturation, not reallocation. **Until same-artifact ×
same-family × same-quant × blind-labeled, §1 is pattern-matching, not a size effect.**

## 4. Reproducible experiment (pre-registered; decisive; re-runnable in 6 months)

**Design — crossed & paired (fixes the core confound):** put **both a seeded line-local defect AND a seeded
architectural defect in the *same* artifact**, and run **every model on every artifact.** "Small gets the local,
large gets the global" then becomes a *within-artifact* fact, not an across-artifact inference.

**Reviewers:** **≥3 same-lineage sizes** (a crossover is a shape — two points can't show one), e.g. a small
Qwen-Coder floor + 30B + 80B, all **A3B** (note: this varies *total knowledge/experts*, not compute-per-token —
the right control for a "rich prior" mechanism; say so). **Lock quant, runtime, decode, context packing, output
budget; one flat prompt for all sizes** (Phase-2 shaping stays parked). Frontier models = a **separate family
cell for generalization, NOT points on the size slope.**

**Primary estimand (interaction, not a cartoon):** mixed-effects logistic
`catch ~ size * locality + (1|artifact) + (1|defect)`.
- **Claim L (locality specialization):** `slope(size|architectural) > slope(size|line-local)`.
- **Claim H (habituation) — the load-bearing, strictly-directional test:** the **line-local size slope is
  strictly negative** (habituation *costs* local recall), 95% CI excluding zero-or-positive. *Flat is the null.*
  **Design against ceiling:** line-local defects hard enough the small model is below ceiling (add a **floor**
  defect neither catches and a **positive control** both must catch, to prove the instrument is in a sensitive range).

**Habituation must be *measured*, not inferred — three direct probes (§2 lives or dies here):**
- **McNemar paired miss-asymmetry:** on identical line-local defects, is `P(large misses | small catches) >
  P(small misses | large catches)`? (Large *skips* what small catches.)
- **Familiarity manipulation (the crux):** line-local defects split **canonical/textbook (high familiarity, LGTM-
  shaped)** vs **weird/novel (low familiarity)**, matched for locality *and* difficulty. Habituation predicts the
  large model's miss rate is **higher for familiar than novel** while the small model shows no such gap (size ×
  familiarity interaction). If large misses familiar and novel equally → **budget/capacity, not habituation.**
- **Directed-probe recovery gap (tightest, cheapest):** if a large model's free-review line misses **recover
  under a directed prompt** ("any issue on line 42?"), the deficit is *allocation/salience* (habituation); if
  they don't, it's *capability.* One number, no architectural adjudication.

**Blinding / stats / power:** seed authors ≠ adjudicators ≠ runners; reviewers never see the seed list or other
outputs; locality/familiarity labels fixed **before** runs; adjudicators see **source-stripped atomic claims**,
≥2 raters + IRR (κ/α), **cross-family tie-break (no Claude-grades-Claude)**; **K≥3 samples per (model, artifact)**
at fixed temp; **N/M from a power calc** (~≥30 defects per locality×size cell for recall CIs ≈ ±0.09);
pre-register α, minimum effect size, exclusions, and a stopping rule by CI width. **Prefer mined real
bugs/diffs** over insertions (frontier models smell a planted seam); else human-confirm each seed reads natural.

**Falsifiers (any one kills the strong claim):** line-local slope not-strictly-negative; no architectural gain
with size; or the **McNemar/familiarity/directed-probe tests show no preferential large-miss of familiar line
defects** — in which case drop "habituation," keep only "specialization."

**6-month drift re-run:** same frozen (hashed) artifacts + same prompts + *current* model versions → re-fit the
interaction. Shifted result ⇒ capability drift; vanished ⇒ generation-specific. Log exact model IDs, quant, ctx,
prompt hash, decode, packing, seed manifest, harness + scoring-code versions.

## 4b. Run this FIRST — the cheap experiment that kills or confirms the mechanism

Skip architectural adjudication (subjective, expensive) for the first pass, because habituation's falsifiable
heart is on the **line-local, familiar-vs-novel** axis: **one same-lineage small/large pair · a bank of line
bugs split canonical vs weird · paired within-artifact · fixed quant/prompt/budget · K=3.** DVs: McNemar
miss-asymmetry + size × familiarity interaction. **If the large model does not preferentially miss *familiar*
line bugs, habituation-as-salience is dead — cheaply, no 6-month program.** Only if it survives do we fund the
full locality ladder.

**This is executable, not described — the harness is `experiments/habituation/` (`manifest.jsonl` seed bank +
`run.py` + `score.py`, stdlib-only).** Run: `python3 run.py --model qwen3-coder:30b --endpoint
http://127.0.0.1:11435 --label 30b`, then the 80B, then `python3 score.py`. (Per NVIDIA's *Aspire*: coarse
narrative feedback says a rollout failed but not *why* — validation needs a runnable engine; a described
experiment is a narrative, the harness is the reproduction.) v0 `score.py` uses a keyword *proxy* matcher so it
runs today; a real result needs blind two-rater adjudication (§4) — or better, **reviewer-supplied runnable
repros that self-adjudicate** (see `review-of-reviews.md` → "demand a demonstration").

## 4c. A no-seeding allocation measure (bonus, ceiling-proof)

Give both models the **same real artifact**; blind-code the **topic distribution of their output** (fraction of
review text on line-level vs structural). Reallocation predicts the large model writes *proportionally less*
about line-level and more about structure **on identical input** — a within-artifact paired measure that needs
no seeding and no ceiling assumption. Measures allocation directly rather than inferring it from recall curves.

## 5. What this is / isn't

**Is:** an exploratory observation about **one cross-vendor pair**, with a mechanism sketch and a now-decisive,
cheaply-runnable, pre-registered test. **Isn't:** a result, a size effect, or established. The "frontier produces
reframes" line rests on **n=1/3** (two frontier models missed the reframe). **Do not cite §1/§2 as established
until §4b returns confirmatorily.** Architectural complementarity remains an engineering bet, not a finding.

The protocol is already a real measurement instrument, not just a review log — the gaps below are what turn it from a strong engineering practice into a study that can support claims about saturating reviewer attention.

---

## I LIKE

**The append-only, dated protocol (Protocol section).** Logging artifact size, reviewers, consensus / unique / blind / adjudication as a fixed schema is the right unit of observation. Most “multi-model review” writeups never freeze a row schema; you did.

**Separating recall from precision via adjudication.** The trickle → frontier-scrutiny split (Reviewer roster) is methodologically sound: high-recall locals + precision gate is how you get usable error rates without pretending every local finding is gold.

**Blind Claude as a controlled comparison (Round 2).** Same artifact, same I-like/I-wish/I-wonder brief, no sight of peers is the first real experiment in the file. That design is stronger than Round 1’s retroactive seed.

**Stating the three axes up front (Meta-study axes).** Family × size × review-size maps cleanly onto the framework claim (different training → different blind spots; capacity saturates with input size). Naming them early keeps the log from drifting into “vibes about reviewers.”

**Explicit family-dependence caveat.** Calling out that Claude’s independence is “prompt+blindness, not architecture” (Round 2 / roster) is the kind of honesty that makes later claims credible.

**Treating profiles as tentative at tiny n.** Round 1’s “TENTATIVE — n≈2 artifacts, one domain” is the correct epistemic posture.

---

## I WISH

### (a) Objective “catch” — break the circularity

**Wish:** Stop treating “another reviewer said it” as the definition of a true positive.

**Stronger version — dual ground truth:**

1. **Pre-seeded defect injection (for code / structured diffs).** Before review, plant *N* labeled defects in a holdout copy (bugs, missing API ops, O(n²) loops, missing tests). Reviewers never see the seed list. Catch = recovery of a seeded item (fuzzy-matched by adjudicator under a fixed rubric). Miss = false negative. Unique catch of an *unseeded* issue goes to a separate “emergent finding” bucket, not into the blind-spot matrix until promoted to ground truth by a later process (fix, human adjudication, or consensus-then-verify).

2. **Human-adjudicated finding registry (for design prose).** Every atomic finding gets an ID, a one-line claim, a severity (blocker / load-bearing / nice-to-have / noise), and a disposition after the fact: *accepted into plan*, *rejected as wrong*, *deferred*, *already known*. “Caught” = reviewer output matches a registry item (embedding + human confirm, or structured tags). Ground truth accumulates longitudinally; Round 2’s quarantine-embedding contradiction becomes GT only once it’s dispositioned as accepted — which plan-v3 already did. That breaks circularity: peer discovery is a *signal*, disposition is the *label*.

3. **Never grade “catch” by prose beauty.** Thesis-alignment catches (prominence conservation) are valuable but are a different DV than “defect found.” Split DVs: *defect recall*, *design-coherence catch*, *framework-alignment catch*. Mixing them inflated Claude’s “strongest single review” claim in Round 2.

### (b) Confounds — design them out or measure them

| Confound | Stronger control |
|---|---|
| **Plan evolves across versions** | Freeze a **canonical artifact snapshot** per round (hash + path + commit). Reviews of plan-v1 vs v2 vs v3 are *different trials*, never pooled as repeats. Log `artifact_id`, not just “the plan.” |
| **Same artifact, different times / order** | Randomize reviewer order; run all reviewers in the same wall-clock window when possible; forbid later reviewers from seeing earlier raw reviews *and* from seeing plan revisions that incorporated earlier reviews. Round 2 on virgin plan-v1 was good; don’t “re-review” v3 with models that shaped v3 unless labeled **contaminated**. |
| **Orchestrator-family bias (Claude)** | Blind Claude stays; add a **non-Claude adjudicator** for Claude findings (Codex or Grok as scrutiny for Claude’s unique catches — already half-present in “frontier scrutiny,” make it mandatory and crossed). Better: a human binary accept/reject on unique catches before they enter the profile. |
| **Tiny n** | Pre-register a stopping rule: e.g. profiles are **exploratory** until ≥12 artifacts spanning ≥2 modalities (prose plan, code diff, schema, API) and ≥3 size bins. Until then, no “strongest reviewer” language — only per-round tables. |

Also log **prompt template version**, **temperature/settings**, and **context packing** (full file vs chunked). Those are massive confounds for “model” effects.

### (c) Consensus / unique-catch inferences — weaken the causal story

**Wish:** Drop “consensus ⇒ high-confidence” and “unique ⇒ edge / others’ blind spot” as default semantics in the Protocol bullets.

**Stronger version:**

- **Consensus ⇒ high *redundancy*, not high confidence.** Two models agreeing can share a training prior or a prompt cue. Confidence comes only from *downstream disposition* (accepted + verified) or *seeded recovery*. Relabel Protocol: **Consensus (redundant)** / **Unique (non-redundant)** / **Verified (dispositioned true)** / **Miss (verified true, that reviewer absent)**.

- **Unique catch ⇒ candidate specialization, not proven edge.** Until verified, unique catches are *hypotheses about attention allocation*. After verification: if true and others missed → **true positive unique** (edge). If false → **false alarm** (that reviewer’s noise profile — equally important for a saturating-channel story: capacity wasted on noise).

- **Blind spot of B for finding F** requires: F verified true ∧ A caught F ∧ B reviewed the *same* artifact under *comparable* conditions ∧ B did not catch F. Without (c) and (d), Round 1 “Codex unique / Grok unique” lists are specialization *candidates*, not measured gaps.

- Add **false-discovery rate** per reviewer: unique_false / unique_total after adjudication. Specialization without precision is just a different failure mode.

### (d) Make the three axes actually measurable

**Axis 1 — family.** Operationalize as fixed roster cells per round (Codex / Grok / Claude-subagent / Qwen-80B / Qwen-30B). Metric per cell: recall@verified, precision@adjudicated, unique-verified rate. Report family effects only after matching on artifact and size bin.

**Axis 2 — size within family (the Brian work replication).** Stronger design:

- Pick **one family** with ≥2 sizes you can run identically (Qwen 30B-A3B vs 80B-A3B is the gift in the roster — same lineage, different capacity, same prompt, same artifact).
- Hold constant: prompt, artifact snapshot, decode settings, review-size packing.
- Vary only: model size (and quantization — log 4-bit vs 8-bit as a *nuisance factor* or second factor; don’t confound size with quant).
- Primary DV: recall of verified/seeded findings. Secondary: unique-verified, FDR.
- Pre-register: “catch-rate scales with size” vs “diminishing returns past X” vs “size helps only above review-size threshold S” (interaction with axis 3 — the interesting claim).

**Axis 3 — review size / saturation.** Stronger design:

- Define size as **tokens in the reviewed pack** (and optionally structural complexity: #files, #Hunks, cyclomatic sum) — “lines” alone is too coarse for plans.
- Bin or continuous: small / medium / large, or plot recall vs tokens.
- **Within-reviewer saturation curve:** same model, same family of defects, increasing artifact size. Saturation = inflection where recall drops or FDR rises while unique noise rises.
- Controlled construction: take a medium diff, then concatenate / nest / add unrelated modules to inflate size *without adding new seeded defects* (padding) vs inflate *with* proportional seeded defects. Padding isolates attention dilution; proportional seeding isolates capacity.

Put a **measurement matrix** in the Protocol: rows = rounds, columns = family, size_bin, review_tokens, recall, precision, unique_verified, FDR. Emerging profiles become columns of that matrix, not narrative paragraphs.

### (e) Inter-rater reliability & Claude grading Claude

**Wish:** Orchestrator (Claude) must not be the sole coder of “who caught what” or “load-bearing.”

**Stronger version:**

1. **Atomicize findings before attribution.** Extract findings into a checklist *blind to source* (strip model names). Two independent labelers (ideally: one human + one non-Claude model, or two humans) map each review sentence → finding IDs. Cohen’s κ / Krippendorff’s α on the mapping. Only then compute consensus/unique matrices.

2. **Cross-family adjudication.** Claude unique catches → adjudicated by Codex or Grok (and vice versa). Human is tie-break. Log adjudicator identity.

3. **Pre-register severity rubric** so “load-bearing” isn’t post-hoc (Round 2’s “decisively strongest” is currently an orchestrator judgment).

4. **For publishable claims:** at least one fully human-blinded scoring pass on a subset (e.g. 20% of rounds).

---

## I WONDER

**A fourth axis: review *mode*.** Spec-first vs implementation-diff vs “red-team dream harness” may shift specialization more than family. That would connect to tessera’s own clean-room / spec-first process and test whether “ops lens vs thesis lens” is modality-dependent (your Round 1 caveat already hints this).

**Saturation as allocation, not just miss-rate.** If attention is a channel, measure *where* attention went: fraction of review tokens / bullets spent on severity tiers, or topic tags (concurrency, schema, thesis, UX). Saturation might look like: as size grows, high-severity share falls while low-severity / stylistic share rises — a cleaner operationalization of “attention line” than binary catch/miss.

**Time-on-task / compute budget as the true capacity variable.** Fix wall-clock or max output tokens; plot verified recall vs budget. Model size × budget interactions are publishable; “Grok vibes” are not.

**Planted-contradiction packs for design docs.** Analogous to fault injection: insert 3–5 known contradictions into a throwaway plan fork (like the embedding/quarantine bug, but seeded). Measure recovery. That gives design-prose the same GT discipline as code.

**Ensemble theory as the estimand.** Pre-register: *union recall* of the roster vs best single; *marginal gain* of adding Claude given Codex+Grok; diminishing returns of the local trickle after adjudication. “Ensemble beats any one” (Round 2) becomes a cumulative gain curve — the engineering claim your process already needs.

**Negative controls.** Empty or near-clean small diffs: any “catches” are pure FDR. Without this, unique-catch tallies are upward-biased.

**Path to a real result.** Minimal publishable package: (1) seeded + dispositioned finding registry; (2) Qwen 30B vs 80B same-prompt same-artifact ladder across size bins; (3) frontier trio blind on the same ladder; (4) human-adjudicated labels on a subset; (5) report recall–size curves + FDR + union-vs-best. Frame as *empirical measurement of multi-agent review as scarce attention under input load* — with tessera as the living lab, not the sole object. The attention-allocation book gets a methods figure; the repo gets a gate policy justified by data.

---

**Bottom line:** Keep the protocol schema and the blind Round-2 design; replace peer-relative “catch” with seeded + dispositioned ground truth; demote consensus/unique from confidence claims to redundancy statistics; run the Qwen size ladder as the first controlled axis-2×3 experiment; and cross-adjudicate so Claude never grades Claude alone. That’s the jump from an excellent longitudinal engineering log to a study that can carry the framework’s empirical claim.

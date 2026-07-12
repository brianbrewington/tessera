## I LIKE

- `§3 Evidence we actually have (and its limits)` is unusually honest for a draft: tiny `n`, post-hoc pattern notice, confounds, and “habituation inferred not measured” are all explicitly named.
- `§4 Reproducible experiment` has the right bones: frozen artifacts + hashes, same-family size ladder, fixed prompt/decode/packing, blinded adjudication, negative controls, and an explicit falsification clause.
- `§5 What this is / isn't` correctly blocks over-claiming: “observation/hypothesis, not result.”
- The core framing (local vs architectural recall split) is testable, not metaphysical.
- You already separate recall from noise (FDR), which many drafts miss.

## I WISH (stronger version)

### (a) `§1` still over-generalizes from tiny n

Current language still reads broader than evidence supports (“small model ... not prey to habituation,” “large models ... prey”).  
**Stronger wording for `§1`:**

- “In a small exploratory sample (`n` very small, mixed artifact types), we observed a *candidate pattern* consistent with local-vs-global specialization by reviewer size.”
- “No general claim about model classes is warranted yet.”
- “For small models, we observed no habituation signal in this sample; absence of evidence is not evidence of absence.”

That keeps the thesis alive without implying class-level truth.

---

### (b) `§3` caveats are good but miss key confounds

You already list major ones, but add these explicitly:

- **Modality confound (code vs spec) × locality confound**: local defects were mostly code-like, architectural defects mostly prose-like.  
  - **Fix:** cross both modalities with both defect localities (local+global seeds in code artifacts *and* in design artifacts).
- **Evaluator confound (“class of catch” coded by orchestrator)**:
  - **Fix:** source-blinded atomic finding IDs + 2 independent raters + tie-breaker; report kappa/alpha.
- **False-positive asymmetry confound**:
  - **Fix:** include near-clean controls per modality; report per-model precision/FDR separately from recall.
- **Size confounded with runtime setup** (quantization, context limits, output token budget, timeout):
  - **Fix:** lock these or include as nuisance covariates; don’t let “bigger model” also mean “different compute regime.”
- **Contamination/re-review confound**:
  - **Fix:** pre-register “virgin artifact” vs “contaminated/re-review” conditions and never pool.

---

### (c) Is `§4` truly falsifiable? Not yet decisive enough

“Architectural rises while line-local flattens or decreases (crossover)” is directionally falsifiable, but currently too interpretable after the fact.

**Stronger falsifiable form (pre-register):**

- **Primary test:** size × locality interaction on seeded-defect recall in mixed-effects logistic model.  
  - Hypothesis: slope(size) for architectural recall > slope(size) for line-local recall.
- **Secondary strict test (your crossover):** line-local slope <= 0 beyond a prespecified size tier.
- **Mechanism falsifier:** if large model does not exhibit excess “small-caught/large-missed” on line-local seeds, habituation mechanism unsupported.
- **Pre-specify effect thresholds** (e.g., minimum meaningful delta in recall/FDR), not just sign.

**Scoring/blinding/seeding upgrades:**

- Seed list generated before runs with fixed RNG seed logged.
- Uniform output schema from reviewers (JSON fields: claim, evidence span, fix).
- Adjudicators see only de-identified claims and artifact text; no model identity.
- “Catch” requires correct + specific + mapped to seeded defect ID (or validated emergent ID).

**Power / n (practical, not giant):**

- Start with a **minimal decisive matrix**: 2 sizes (same family) × 2 localities × 2 modalities.
- Aim for ~150-250 seeded opportunities total (balanced cells) for stable interaction estimates.
- Add ~20-30 near-clean artifacts for FDR estimation.
- Pre-register stopping rule by CI width (e.g., interaction CI narrower than target), not “until it looks clear.”

**Is crossover the right falsifiable form?**

- Keep crossover as a strong secondary claim.
- Make **interaction** the primary claim; it is cleaner statistically and less brittle than requiring literal curve crossing.

---

### (d) Habituation is inferred; measure it directly

Right now your own `§3` diagnosis is correct: mechanism is inferred.

**Direct habituation measurements to add:**

- **Cross-miss metric (key):** proportion of line-local seeds where small catches and large misses, on identical artifacts.
- **Familiarity manipulation:** matched defects placed in repeated/familiar patterns vs novel patterns; habituation predicts larger miss increase in familiar condition for large models.
- **Two-pass design:** free-form review pass, then forced line-by-line checklist pass.  
  - If misses recover in pass 2, that supports attention allocation failure (not incapacity).
- **Attention reallocation metric:** share of findings/tokens spent on local vs global issues under fixed output budget.

## I WONDER

- **Cheaper decisive experiment:** skip multi-family at first; do only same-family size pair (e.g., Qwen 30B vs 80B), fixed harness, balanced seeded set. This answers your main mechanistic claim fastest.
- **Missed confound:** output verbosity/style affects adjudication mapping. Force structured outputs to reduce mapping bias.
- **Cleaner operationalization of “attention reallocation”:** treat review as a fixed budget allocation problem; measure where budget goes (local/global, high/low severity) as size changes.
- **Even simpler falsifier:** if over enough seeded line-local cases you cannot find a reliable “large missed / small caught” excess, drop “habituation” and keep only “specialization” language.

---

Most important upgrade: make the headline claim an **interaction claim** with a predefined falsifier, and make “habituation” contingent on a **direct cross-miss metric** rather than narrative plausibility. That keeps the draft bold but honest.

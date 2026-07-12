Methodology-focused critique of `docs/reviews/review-of-reviews.md`, in your requested format.

## I LIKE (methodologically strong)

- **You already define key constructs and units of observation** in `Protocol (log per review round)`: consensus, unique catches, blind spots, adjudication. That is the right scaffold for a longitudinal measurement system, not just ad hoc notes.
- **The `Meta-study axes` are exactly the right causal candidates** (family, size, review size). This is a strong starting theory for attention saturation and reviewer specialization.
- **You explicitly include caveats in `Round 1` and `Round 2`** (tiny n, one domain, family-independence caveat). That epistemic hygiene is rare and crucial for turning logs into science.
- **Blind setup for the Claude subagent in `Round 2` is good experimental instinct** (same artifact, same brief, no sight of other reviews). That directly addresses leakage from prior reviewer outputs.
- **Append-only longitudinal framing** is excellent: it enables later re-analysis, model drift studies, and pre/post methodological comparisons.

## I WISH (with stronger version proposed)

- **I wish “catch” were defined against an independent target, not only relative to other reviewers (`Protocol`).**  
  **Stronger version:** define an **Issue Opportunity Set (IOS)** per artifact:
  - IOS built by independent adjudicators (not the reviewers being tested), plus optional seeded canary defects.
  - Each issue has ID, severity, type, and evidence snippet.
  - A reviewer “catches” issue *i* only if output includes a mapped claim meeting a pre-registered rubric (actionable + correct + specific enough).
  - Report weighted recall/precision/F1 by severity, not just counts.

- **I wish adjudication were independent of reviewer family (`Protocol`, `Reviewer roster`, `Round 2` caveat).**  
  **Stronger version:** make adjudication a **blinded 2-rater panel**:
  - Strip reviewer identity/model family from outputs before scoring.
  - Two independent raters label (valid issue / duplicate / false positive / out of scope).
  - Third rater resolves disagreements.
  - Compute inter-rater reliability (Krippendorff’s alpha or Fleiss’ kappa).  
  This avoids “Claude grading Claude” and also “orchestrator family grading itself.”

- **I wish repeated-artifact and evolving-plan confounds were controlled (`Round 2 same artifact`, longitudinal edits).**  
  **Stronger version:** adopt a blocked design:
  - Freeze artifact snapshots (immutable hashes).
  - Run compared reviewers in same time window with fixed prompt template/version.
  - Randomize reviewer order and artifact assignment (Latin-square or balanced incomplete block).
  - Mark “re-review of same artifact” as a separate condition, not pooled with first-pass reviews.

- **I wish your inference rules were empirical, not assumed (`Consensus ⇒ high-confidence`, `Unique ⇒ edge`).**  
  **Stronger version:** estimate these as hypotheses:
  - Measure PPV by support tier: 1-of-K, 2-of-K, 3-of-K.
  - “Consensus = high-confidence” is valid only if tier-PPV is empirically monotonic.
  - “Unique = edge” only if (a) adjudicated true, and (b) replicated across artifacts controlling for issue type and severity.
  - Track false-positive rate of unique catches separately (they’re often noisier).

- **I wish the three axes were operationalized with a concrete design (`Meta-study axes`).**  
  **Stronger version:** predefine a factorial matrix:
  - Family: e.g., Codex vs Grok vs Qwen vs Claude.
  - Size-within-family: at least one controlled pair (e.g., Qwen 30B vs 80B) with identical prompt/budget/context.
  - Review size bins: e.g., S (<=300 loc), M (301–1200), L (>1200) or token-based equivalents.
  - Minimum per cell target (or mixed-effects model if sparse cells).
  - Primary outcome: weighted recall; secondary: precision, time-to-first-valid-catch, cost.

- **I wish “saturating channel” were measured directly, not only narratively (`Meta-study axes` #3, thesis framing).**  
  **Stronger version:** manipulate and model attention budget:
  - Vary allowed context/review budget (tokens, passes, or minutes).
  - Fit saturation curves (e.g., asymptotic/logistic) for recall vs artifact size and budget.
  - Report half-saturation point and asymptote by reviewer/family.
  - This gives a publishable quantitative interpretation of “attention as channel capacity.”

- **I wish tiny-n risk were addressed with explicit statistical plan (`Round 1` caveat).**  
  **Stronger version:** pre-register:
  - hypotheses, outcomes, exclusion criteria, adjudication process;
  - mixed-effects logistic model (issue caught ~ family * size * review_size + (1|artifact) + (1|issue));
  - bootstrap CIs for per-reviewer recall/precision and tier-PPV.

## I WONDER (sparks for a publishable result)

- **Issue-type saturation curves:** do models saturate differently for correctness vs security vs architecture vs performance issues?
- **Artifact modality axis:** prose design docs vs code diffs vs test changes might have different channel capacities and blind-spot fingerprints.
- **Correlation of errors across reviewers:** consensus may hide shared blind spots. A “diversity gain” metric (marginal recall added by each reviewer conditioned on existing ensemble) could quantify true ensemble value.
- **Sequential allocation policy:** test whether adaptive reviewer routing (cheap high-recall first, expensive specialist only if uncertainty remains) beats static ensembles at fixed cost.
- **Drift analysis:** rerun a fixed benchmark monthly to estimate reviewer drift over time, separating model updates from methodology effects.
- **Canary perturbation set:** seeded, known defects with varying subtlety gives a stable anchor so “catch” is never circular.

If useful, I can draft a **v2 protocol template** you can paste into this doc: fields for IOS, blinded adjudication form, tier-PPV table, and the minimum experiment matrix for family × size × review-size.

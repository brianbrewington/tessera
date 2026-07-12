---
source: thread-summary-attention-allocation.md.docx
author: Brian Brewington & Claude
original_date: 2026-07-08
captured: 2026-07-12
origin: Google Drive export (drive-download-20260712T124422Z-2-001)
note: Thread summary: reviewer attention as the bottleneck. The reviewability-experiment pivot from proxy-repair to a theory of the saturating channel.
---

Reviewer Attention as the Bottleneck — Thread Summary

*Brian Brewington & Claude, 2026-07-08. Continuation of the reviewability-experiment thread (see reviewability-experiment-plan.md, phase 0/1/2 findings).*

Where the thread started

Can we measure how *reviewable* code is — and clamp code generation toward clarity? The plan proposed a capability-spectrum of LLM reviewers whose catch-rate curve (slope, floor) would be the maintainability signal.

What the experiments killed (cheap-first, in order)

- **Phase 0a** — "clever code is cheaper in tokens" is mostly false; token cost is length-dominated (o200k packs Python at 4.28 chars/token; density r = −0.21).
- **Phase 0b** — natural YAGNI is rare in the personal corpus; the abstraction axis must be synthetic. (Also flagged: the detector sees only *formal* abstraction; informal over-abstraction wears street clothes.)
- **Phase 1** — review-token cost is **flat in input length** (log-log slope ≈ 0, both duplication and distinct-content modes). The reviewer emits a fixed ~700–1000-token review regardless of input size. Raw token cost is dead as a proxy. Method lesson: Ollama temp-0 is deterministic; noise floor needs temp > 0.
- **Phase 2 proof** — the harness works and the capability gradient is real, but the **LLM judge is the bottleneck**: it mis-graded exactly at the weak rungs that matter (false-negatived a real catch, false-positived confabulation). There is a "coherence floor" below which reviewability is *unmeasurable*.

The pivot: from proxy repair to a theory of the channel

The flat review budget was reframed from instrument failure to **finding**: the reviewer is a *saturating channel*. Review-per-1k-prompt fell 1130 → 105 as input grew — long artifacts don't get reviewed worse, their excess gets **not reviewed at all**.



This connected to Brian's PhD thesis (optimal allocation of scarce observational attention over a changing world): the optimal policy under a budget has a **hard threshold** — items whose marginal value falls below the shadow price get *zero* observations, not fewer (water-filling; Koopman search theory). Web pages never re-crawled ≙ imagery tiles never refreshed ≙ code blocks never read. Same invariant, third domain.



Two thesis leftovers turned out to be the design laws of the whole program:



- **The Goodhart failure**: optimizing "changes caught" makes the observer camp where change is certain. The fix was weighting by *user penalty* — i.e., severity-priced objectives, not catch counts.
- **The epsilon trickle**: a hard attention wall prevents ever learning that a dark region's change rate changed. A small random re-observation budget keeps the allocator calibrated. In 1999 this was unaffordable; in 2026 LLM reviewers make the trickle nearly free.

Key ideas generated (chronological-ish)

- **Execution-verified catch signal**: replace the LLM judge with a machine check — reviewer must emit a concrete failing input + expected-vs-actual; run it against buggy and fixed variants. Prose can confabulate; a demonstrated failing input cannot. Report both signals; the *gap* per rung (recognition vs. operational understanding) is itself a finding.
- **Involuntary signals beat self-reports** (the comedian's laugh): per-token surprisal of the *input* under each reviewer model is free, unfakeable, localizable, and capability-indexed. Upgrade: **repo-conditioned surprisal** (train/fit on the repo's own history) as a label-free salience sensor. Caution: surprisal is a change-rate sensor with no importance term — the severity join supplies the other axis.
- **Attention-dilution / bimodality test**: one bug per block at 1×/2×/4×/8×. Uniform thinning (→ ~1/N per block) vs. bimodal (some blocks fully attended, others at zero) distinguishes "dilution" from "hard threshold." Pre-registered kill criterion for the thesis connection.
- **Permutation test**: identical content, block order varied (risk-first / risk-last / shuffled). If catch rate moves with order alone, reviewability is a property of the (code, presentation, reviewer-policy) triple — presentation is free to optimize.
- **Review-optimized presentation** ("dark cockpit for code"): machine-verifiable content goes dark; only judgment-requiring claims stay lit; the fixed budget is aimed at the lit region. Author-supplied salience maps are disqualified (author blind spots caused the bug — correlated errors; cf. 737 MAX / ODA capture). The salience map must come from an independent instrument.
- **Escaped defects as training signal**: fix commits traced to review-approved inducing commits label exactly where the review channel's allocation failed; review comments that forced pre-merge changes label successes. Severity/incident data prices each escape. A learned attention router follows — potentially reviewer-specific (blind-spot profiles; review assignment as coverage-ensemble). Two structural cautions: the label is censored (silent bugs absent), and a live router creates off-policy drift in its own dark regions — the epsilon audit budget must not be the router's to spend.
- **Ten-domain generalization** (each with shaping mechanism, memorable escape, dark-sensor pathology): peer review (Reinhart–Rogoff; unread supplements), financial audit (materiality thresholds; Wirecard), aviation certification (ODA capture; 737 MAX), drug approval (surrogate endpoints; Vioxx; unfunded Phase IV), contracts (boilerplate; pari passu), legislation (omnibus saturation; riders), structural engineering (Hyatt Regency shop-drawing diff), open-source security (Heartbleed underprovisioning; XZ — an adversary reverse- engineering the reviewer's attention line), clinical medicine (checklists; alarm fatigue = inverted dark cockpit), NASA flight readiness (normalization of deviance = administrative re-binning of live signals into dark regions). Brian's addition: automotive certification (self-certification; NCAP approval theatre — a frozen attention line is a published exploit spec).
- **Synthesis**: every shaping mechanism is dual-use (capturable by adversaries, authors, or schedule pressure); the recurring root cause is the cut audit-of-the-dark-region budget.
- **2026 state of AI interventions**: code-review tooling has independently converged on crude routers (severity ranking, confidence-scored triage, even autonomous approval of "low-risk" PRs) — with no published escape rates and no epsilon audits. Medicine (alarm triage) second; certification the dangerous laggard. Industry is publicly conceding that naive human-in-the-loop fails (attention decay, normalization of deviance) — the replacement is a *routed* human.
- **The attention guardian**: a personal router (chief-of-staff agent) is coming; it inherits every pathology on the list; the distinguishing variable between guardian and predator is **whose objective function the router serves** — plus an audit trickle the principal controls.
- **Attention economy as keystone**: the one domain where the router was built *before* any review layer existed — engagement optimization is the steering experiment run at planet scale, proving the machinery works and isolating the moral variable to the principal.

Validation discipline (for the eventual deployment claim)

Escapes are rare, slow, censored → surrogate endpoints (pre-registered, Vioxx-aware): seeded-defect catch rate under shaped vs. unshaped presentation; comment relocation (manipulation check); time-to-verdict at constant catch. Randomize at team/repo level (reviewers carry salience across PRs); stepped-wedge rollout; control arm doubles as the unbiased escape-rate sensor. Pre-register Hawthorne and **risk compensation** (net escapes, including router-induced ones in darkened regions).

Prior-art verdict (searched 2026-07-08)

Pieces exist — rational inattention (Sims; Maćkowiak/Matějka/Wiederholt review), attention-based view of the firm (Ocasio), Normal Accidents (Perrow), Vaughan, Gawande, HRO literature, human factors — but **no unified treatment** of institutional review as bandwidth allocation over a saturating channel, with the AI turn forcing it open. The measurement paper (harness + threshold experiments + one public-repo escape study) is the book's load-bearing chapter.

Tooling decision

Prototype in Claude Code (harness still molten); run final batteries and anything touching NVIDIA code in Claude Science (provenance packaging + trace-back reviewer = the dark-cockpit principle applied to the write-up; results Brian *wants* to be true most need the independent check).

# Phase 2 — attention-directed prompt shaping (parked direction)

*A follow-on to the review-of-reviews meta-study (`review-of-reviews.md`). Parked 2026-07-12 by Brian; **not yet
active** — Phase 1 (measurement on a flat prompt) comes first.*

## The idea

Once each reviewer's catch/miss profile is measured (Phase 1, **flat/uniform prompt**), **shape the prompt per
reviewer to counter its measured attention deficit.** Examples:
- A big, habituation-prone model → prompt it to *read each line as if unfamiliar; distrust the familiar; the
  "obviously fine" is where you're blind* — deliberately **re-lighting the region its prior darkened.**
- A small model that can't hold the big picture → keep its prompt on the **line-level checks it can actually
  do**; don't ask it for architecture.

**This is attention-shaping the reviewer.** The prompt is the router; shaping it to counter habituation is the
epsilon-trickle / audit-the-dark implemented as prompt design. The framework stops merely *describing* the
reviewers and starts *prescribing* how to correct them.

## The loop

**flat → measure catch/miss (vs the IOS ground truth) → shape prompt → re-measure → converge.** This sits in the
prompt-optimization family (DSPy/MIPRO, OPRO, APE, TextGrad, GEPA-style) — but the **distinctive objective** is
not generic accuracy; it's **closing a measured saturation / blind-spot gap.** Attention-directed prompt tuning
against a saturation curve. *(Prior-art survey of the last-few-months prompt-tuning-loop papers: pending — do
before claiming novelty.)*

## Two hazards — both are the framework biting back

1. **Goodhart.** Shaping to maximize *measured* catch overfits to the seeded/known issues — the dissertation's
   own "the observer camps where change is certain" failure. **Fix:** optimize on **held-out** artifacts; keep
   the confirmatory/exploratory wall. **And the deeper fix — an ε-search:** never spend 100% of review bandwidth
   on the shaped (exploit) prompt; **explore/exploit must keep some bandwidth *always* on explore** — an
   unshaped/flat pass, novel/unseen artifact types, random probes into regions the optimizer isn't rewarded to
   look. This is the *same recurring invariant*: the dream-walker's ε-teleport = the dissertation's ε
   re-observation budget = the book's audit-the-dark = now the prompt-loop's explore budget. Goodhart is
   defeated by structurally refusing to ever let exploit reach 100%.
2. **Confound.** A shaped prompt destroys the **flat-prompt control** the meta-study needs to compare models
   cleanly. **Fix (makes it a *stronger* study):** treat shaping as a separate intervention condition — Phase 1
   profiles on the flat prompt (clean model effect); **Phase 2 measures the lift of shaped vs flat** ("does
   attention-directed shaping raise blind-region recall without collateral loss?"), a falsifiable result, not a
   contaminant.

## Status

Parked. **Prerequisite:** the Phase-1 measurement rig running (IOS ground truth + flat-prompt reviewer
profiles). Do not start until then.

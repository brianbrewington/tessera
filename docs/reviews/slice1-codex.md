# Slice-1 code review — durable map state

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-06
**Scope:** `git diff main...HEAD -- src/ test/ scripts/bench/`, plus adjudication of the cohesion finding

---

Not sound enough to build slice 2 on top of yet.

## CONFIRMED Findings (Most Severe First)

- **Critical — slice 1 is functionally unwired in product paths (`view`/`ingest`), so the new layout subsystem does not run where users need it.**  
  `layoutPass` is only referenced by tests and one bench script, not CLI/runtime paths. `tessera view` still just exports current graph data, and `tessera ingest` does not run post-ingest layout persistence.  
  - `scripts/cli.ts:108-113` (`view`) calls only `exportViewer(...)`  
  - `scripts/cli.ts:36-106` (`ingest`) loops ingest files but never calls `layoutPass`  
  - `scripts/export-viewer.ts:15-36` exports `{nodes, edges, name}` only, no stored layout field  
  - `src/layout/pass.ts:46` exists, but runtime usage is absent  
  This means core “wiring” behavior can be missing while most new tests still pass.

- **High — the cohesion benchmark used to justify the open §10 claim is methodologically broken: the “scatter” arm never relaxes.**  
  In `scripts/bench/cohesion-metric.mts`, the `scatter` branch writes seeded coordinates directly and does not run `layoutPass`/`settleIncremental`; the `cohesive` branch does. So the reported inversion compares “relaxed cohesive” vs “unrelaxed scattered,” not two relaxed outcomes.  
  - `scripts/bench/cohesion-metric.mts:27-34`  
  This invalidates the evidence base for the “seed-independent equilibrium” hypothesis as currently documented.

- **Medium — tests described as “wiring” are mostly unit-level and would not fail if CLI/view wiring is absent.**  
  They call `layoutPass` directly on in-memory stores and never exercise the CLI/export path where regressions matter.  
  - `test/layout-pass.test.ts:51,73,105,...` direct `layoutPass(...)` usage  
  - No tests asserting `scripts/cli.ts` integrates layout persistence or that exported viewer payload includes stored layout  
  So they are strong algorithm tests, but weak end-to-end wiring guards.

- **Low/Medium — benchmark reproducibility claim is undermined by machine-specific absolute imports.**  
  Several bench scripts import from absolute local paths under `/home/brian-brewington/...`, so they are not portable as checked-in reproducible harnesses.  
  - e.g. `scripts/bench/cohesion-metric.mts:2-5`, `scripts/bench/ingest-latency.mts:179-182`

## HYPOTHESIS / Plausible but Not Proven

- **The “relax converges largely independent of seed” claim may still be true for larger disconnected components, but current evidence does not establish it.**  
  Physics-wise, with strong internal springs + many iterations + gravity, path dependence can shrink, but you need an apples-to-apples relaxed-vs-relaxed experiment to prove that.

## Job 2 Adjudication (Open Finding)

- **Judgment:** the hypothesis is **not currently validated**; the supporting measurement is confounded by a harness bug (scatter not relaxed).  
- **What the author likely mismeasured:** they attributed inversion to equilibrium behavior, but the experiment compares different pipelines.  
- **What acceptance criterion should be now:** do **not** use current §10 cohesion metric as a gate yet. First fix experiment design:
  1. Run both arms through identical relax dynamics (same iterations/forces), differing only in seed policy.  
  2. Measure displacement from seed and component compactness post-relax across realistic sizes.  
  3. Repeat across multiple graph topologies, not one synthetic chain.

If corrected experiments still show weak seed influence at realistic sizes, then there may be **no meaningful final-state acceptance criterion for seed policy under current physics**, and the design should change (e.g., explicit seed-attraction term / fewer relax iterations / staged relax) before defining a pass/fail metric.



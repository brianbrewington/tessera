# Slice-1 code review — durable map state

**Reviewer:** Grok 4.5 (`cursor-grok-4.5-medium`) via Cursor · **Date:** 2026-08-06
**Scope:** `git diff main...HEAD -- src/ test/ scripts/bench/`, plus adjudication of the cohesion finding

---

## Verdict

**Not yet sound enough to treat as a finished slice-1 foundation for slice 2.** The settle port, layout store API, and jitter/welding guards are real and well-aimed. The incremental pass is a plausible core, but (1) nothing product-facing calls it, (2) §10’s placement-quality gate is broken and the author’s own measurement of that fact is methodologically wrong, and (3) several tests that claim to police seeding do not.

---

## JOB 2 — Seeding / cohesion hypothesis

**Hypothesis is largely correct for post-relax *shape* at realistic sizes; partly wrong about *cause* and about *position*; the published numbers were mismeasured.**

### What the author actually measured (CONFIRMED)

`scripts/bench/cohesion-metric.mts` (and scratchpad `cohesion.mts` / `cohesion2.mts`) compare:

- **cohesive:** `layoutPass` → places + **`settleIncremental`**
- **scatter:** `putLayoutBatch` of scattered seeds → **no relax**

So “cohesive span 513 vs scattered 351” is settled-vs-unsettled, not two seeding strategies under the same physics. Rest length 90 + repulsion inflate the cohesive arm; the scatter arm never gets that treatment. The inversion is an artifact of that asymmetry.

### Fair re-measure (CONFIRMED, pure `settleIncremental`, both arms relaxed)

| case | size | shape metrics | centroid distance between seeds |
|---|---|---|---|
| linked, cohesive vs scatter | 4 | still differ | **164** |
| linked | 12 | spans ~equal | **123** |
| linked | 28 | spans/ratios ~identical | **27** |
| **unlinked** (seed “load-bearing”) mapA vs mapB vs far | 28 | spans ~equal | **centroids within ~17** |
| unlinked map vs scatter | 28 | spans ~equal | **~53** |
| map seed → final centroid drift | 4–28 | — | **~180–200** (seed R = 220) |

Physics: with A frozen, N feels gravity → origin, N↔A repulsion, and internal springs (rest 90). After 500 steps that basin dominates **component shape**. For **rule (c)** (no spring into A), even *where* the component lands converges toward the same near-origin equilibrium — the `r = 220 + 60·j` peripheral park is largely washed out. Seed still matters more at small `|C|` and somewhat for which side of A you start on; it does **not** preserve post-relax bbox / intra-inter discrimination at `|C| ≈ 12–28`.

### What §10 should be

**Do not** assert post-relax bbox-vs-median-cluster, NN purity, or intra/inter — those do not police the ladder.

**Do assert**, separately:

1. **Pre-relax seed cohesion** — every member of C is `seedPoint + memberJitter(m)` (already what `placeComponent` does; test *that*, including “scatter would place at many seeds”).
2. **Rule selection** under production `SEMANTIC_FLOOR` / `k` (branch reachability — keep).
3. **A never moves** (keep; this is what slice 2 actually needs).
4. **Optional position check for (a)/(b) only**, at modest `|C|`: after relax, centroid nearer the chosen anchor than a map-seed alternative — *not* a shape metric.
5. If product intent is “rule (c) stays peripheral,” that is a **physics/design change** (weaker gravity, fewer iters, or a soft pin), not a metric retune. As written, the ladder’s (c) offset is mostly theatre after full relax.

**Seeding design need not be thrown out** — component-first still prevents the *seed-time* scatter (28 independent semantic hits), and jitter still prevents welding. What fails is treating post-relax geometry as the acceptance proof of the ladder.

---

## JOB 1 — Code review (severity order)

### 1. CONFIRMED — Slice 1 product path is unwired

`layoutPass` is only referenced from `src/layout/pass.ts` and tests. **No** `scripts/cli.ts` / ingest / `view` call, **no** `exportViewer` `layout` field (`scripts/export-viewer.ts` still emits `{nodes,edges,name}`), **no** viewer §3.4 all-or-nothing read of `GRAPH.layout`.

§11’s slice 1 checklist (CLI write, export field, viewer read, poisoned/mixed-layout/bundle wiring tests) is mostly absent from this diff. Slice 2 (scene anchors on stored geometry) cannot rely on “the map is durable in the product” yet — only on library code that nothing invokes.

### 2. CONFIRMED — “SEED INFLUENCE” / cohesion guards do not earn their names

`test/layout-pass.test.ts` (“SEED INFLUENCE…”) only asserts cohesive `intra/inter < 0.75` with **no scatter control**.

Fair check: after relax, **scatter scores better** on that threshold (≈0.45 vs ≈0.65) and still passes `< 0.75`. Seeds-only cohesive (delete `settleIncremental`) also passes (~0.31).

So this test survives:

- node-first scatter + relax  
- cohesive place + **no** relax  

The skipped §10 test correctly records a gap; the active substitute does not close it.

### 3. CONFIRMED — Mutations that were not tried (and would stay green)

| Mutation | Likely caught by? |
|---|---|
| Delete `settleIncremental` call in `pass.ts` | **No** (SEED INFLUENCE, branch rules, A-frozen, coincide still pass) |
| Per-node scatter seeds then same relax | **No** for SEED INFLUENCE; shape tests skipped |
| Coincident `placeComponent` | **Yes** — `layout-incremental` / e2e coincide |
| Visible-only bootstrap seeds | **Yes** — `layout-settle` full-list vs visible |
| Strip `ORDER BY rowid` | Only the SQL tripwire (author admits behaviour is invisible today) |
| Entire CLI/export/viewer wiring omitted | **No test in this slice** |

Strongest real guards: template-extracted bit-identical settle, coincident welding characterisation + jitter distinctness, `putLayout`/`Batch` no-op + atomicity, “A never moves”, branch `byRule` under `SEMANTIC_FLOOR === 0.75`.

### 4. CONFIRMED — Graph-anchor centroid ≠ design’s set-centroid

```112:120:src/layout/pass.ts
    const anchorPts: AnchoredPoint[] = [];
    for (const c of C) for (const nb of adj.get(c) ?? []) if (anchoredPos.has(nb)) anchorPts.push(anchoredPos.get(nb)!);
    ...
        x: anchorPts.reduce((s, p) => s + p.x, 0) / anchorPts.length,
```

Design §3.3(a): `anch = { neighbours(c) ∩ A }` — a **set**. Two members linking the same anchor (or one member with multi-edges into the same A node if adjacency ever duplicated) **double-weight** that point. Dominant drop case (few links) softens impact; still a spec deviation.

### 5. CONFIRMED — Rule (c) product intent vs physics

`componentOffset` parks at ~220+, but after 500 incremental iters unlinked centroids drift ~200 toward the origin and different (c) seeds collapse together. The ladder still chooses a seed; the map does not keep that park. Either document “seed is transient” or change forces — don’t leave §3.3 prose claiming peripheral placement as if post-settle.

### 6. HYPOTHESIS — `layout-pass` / `layout-store` tests may not be runnable here

`vitest` on those files: worker exits (sqlite-vec load path). Pure settle/incremental tests pass. May be environment-specific; if CI shares it, the GraphStore half of the suite is dark.

### 7. Minor / non-blockers

- `extractSettleSource` uses first `"\n}"` — works on today’s compact `template.html` settle; reformatting could truncate (bit-identical test would then fail loudly — acceptable).
- Branch-reachability + “semantic nearer than map” tests are meaningful for **rule selection**, not post-relax cohesion.
- Store no-op / batch atomicity / non-finite rejection look solid on inspection.

---

## Test-quality summary

| Claimed role | Earns it? |
|---|---|
| Settle bit-identical to template | **Yes** |
| Full-list seeding vs visible | **Yes** |
| Coincident welding + jitter distinctness | **Yes** |
| `putLayout` no-op / batch one-log / atomic | **Yes** (if suite runs) |
| A never moves on incremental | **Yes** |
| Branch reachability @ floor 0.75 | **Yes** (selection, not quality) |
| “SEED INFLUENCE” / cohesion | **No** |
| Poisoned layout / mixed all-or-nothing / layout-in-bundle / CLI additive | **Absent** |

---

## Build slice 2 on this?

**Partially.** Safe to build scene anchoring on: durable `layout` rows, no-op writes, verbatim settle port, and “incremental never moves A.”

**Do not** treat seeding-ladder acceptance or “slice 1 done” as settled until: CLI/`view`/export/viewer are wired, §10 is rewritten around pre-relax cohesion + rule selection (and honest physics for (c)), and at least one test fails if `settleIncremental` is removed or newcomers are scatter-seeded then relaxed.

Reviewed as an independent pass against the repo and a fair physics re-run — not against the author’s comments alone.

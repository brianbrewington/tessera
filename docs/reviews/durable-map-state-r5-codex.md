# Round 5 — narrow re-check of the component-first placement rewrite

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-06

---

## Narrow Re-check (Round 5)

### CONFIRMED findings (most severe first)

- **High — §3.3 semantic-anchor rule is still not implementation-deterministic against real code, and can make rule (b) effectively dead or rule (c) starved depending on implementer choice.**  
  - Spec text: `docs/durable-map-state-design.md:99-101` says `querySimilar(text, {k: 25})`, filter to `A`, cosine floor `>= 0.60`.  
  - Real API: `src/store/graphStore.ts:265-271` requires `querySimilar(vector, k, { index: "quarantine" | "shared" })`; index choice is mandatory and not specified in §3.3.  
  - Concrete failure scenario:  
    - Impl A queries `shared` (often sparse/empty in early states) -> no hits -> rule (b) rarely/never executes -> rule (c) dominates.  
    - Impl B queries `quarantine` -> hits exist -> rule (b) frequently executes -> rule (c) rarely executes.  
    - Same graph, different placement behavior; this is still not “single implementation from text.”

- **Medium — the mixed-layout acceptance criterion can still pass while the targeted hybrid-start defect is present.**  
  - Acceptance line: `docs/durable-map-state-design.md:461-463` (“delete one row -> assert full fallback settle and no half-stored map”).  
  - Risk mechanism already acknowledged in spec: `docs/durable-map-state-design.md:203-206` and actual settle behavior `viewer/template.html:242-254` (no reseed; settle starts from current `x/y`).  
  - Concrete failure scenario: implementation pre-applies stored positions for present rows, seeds missing rows, then calls full `settle()`. The test can pass “settle ran” and “not half-stored” while still producing the forbidden stored/seeded hybrid trajectory dependence.

### HYPOTHESIS (plausible, not proven)

- **Medium — cosine threshold `0.60` may be under-justified for production behavior.**  
  - Spec uses fixed floor at `docs/durable-map-state-design.md:101,155-156` but no bench in `scripts/bench/` calibrates semantic-anchor cosine distribution for this decision (README enumerates settled benches; no cosine-threshold harness).  
  - This could be too permissive (semantic anchor almost always fires, starving map-seed in practice) or too strict (semantic anchor rarely fires), depending on corpus/model drift.

## Checks that now look clean

- **No new §3.4/§3.5 contradiction**: all-or-nothing fallback and “ignore `GRAPH.layout` entirely on incomplete” now align (`docs/durable-map-state-design.md:167-206`).  
- **No governing-section revocation for this slice**: §11 explicitly keeps slice-1 `exportViewer` layout inclusion and all-or-nothing read path (`docs/durable-map-state-design.md:510-513`), consistent with §3.5.

## Live data / code verification performed

- Confirmed on `graphs/big` (read-only query path): `387` visible nodes, visible edge kinds `['RELATED']`, newcomer set `28`, links into existing map `2`, components `1` of size `28`, graph-anchor fallback `26/28 = 92.9%` (matches the document’s topology/fallback claims in §3.3.1 and bench README).  
- Verified benchmark scripts and claims source in `scripts/bench/README.md:48-53`.

**Can slice 1 be implemented from this text as-is?** **No.**

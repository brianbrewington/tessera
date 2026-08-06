# Round 4 — targeted re-check of the rewritten layout section

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-06
**Scope:** did round-3 fixes hold, and attack the NEW material introduced by those fixes

---

## 1) Fixes Hold Check (your prior `r3-codex` findings)

- **Critical: `content_key` missing `focus_node`** → **FIXED**  
  - Revised key now includes `focusNode` explicitly in §5 (`docs/durable-map-state-design.md:255-263`) and adds a dedicated test (`:432-434`).

- **High: `newNodes` API contradiction vs unchanged `IngestResult`** → **RENAMED (problem moved)**  
  - `POST /ingest` now uses `laidOut` and explicitly says not to change `IngestResult` (`docs/durable-map-state-design.md:290,296-299`), which fixes the original contradiction.  
  - But §7.4 still emits `event: {phase:'done', ..., newNodes}` (`docs/durable-map-state-design.md:353-355`), so the naming split now exists between HTTP response and SSE completion payload.

- **High: upload flow conflicted with “`ingestFile()` unchanged”** → **FIXED**  
  - Doc now explicitly says `ingestFile` is **not** unchanged and requires display overrides (`docs/durable-map-state-design.md:339-345`), consistent with current code behavior where `readDoc(path)` drives title/source from path (`src/ingest/ingest.ts:38-39`, `src/ingest/adapters.ts:57-77`).

- **High: anchored incremental settle underspecified** → **STILL BROKEN**  
  - Big improvement, but determinism-critical details are still missing (see confirmed finding #2 below): `idx(n)` / component ordering and semantic-anchor KNN selection are not pinned tightly enough (`docs/durable-map-state-design.md:97-104`; `src/store/graphStore.ts:129-133`).

- **Medium: mixed-layout fallback unsafe/undefined** → **STILL BROKEN**  
  - §3.4 now states all-or-nothing correctly (`docs/durable-map-state-design.md:141-148`), but §3.5 introduces behavior that can reintroduce partial-state influence (confirmed finding #1).

- **Medium: impossible temp-file cleanup guarantee (“including crash”)** → **FIXED**  
  - Revised failure semantics now correctly scopes `finally` and adds startup temp sweep for kill/power-loss cases (`docs/durable-map-state-design.md:390`).

- **Low: wrong `connect --commit` citation** → **FIXED**  
  - Now cites edge write site in connector (`docs/durable-map-state-design.md:57-58`; `src/connect/connector.ts:549-552`).

---

## 2) Attack on New Material (targeted sections)

### CONFIRMED

- **High — §3.4 all-or-nothing rule is contradicted by §3.5 layout-application rule**
  - §3.4 says: any missing visible layout row => run full fallback settle (`docs/durable-map-state-design.md:146-148`).
  - §3.5 says viewer applies `GRAPH.layout[id]` at construction, then skips settle only when complete (`docs/durable-map-state-design.md:171-172`).
  - Current settle does **not** reseed; it updates from current `x/y` (`viewer/template.html:240-254`, especially `:242-243`).
  - **Failure scenario:** 1 visible node missing layout, 386 present. If construction preloads 386 stored positions, fallback settle starts from mixed initial state; output depends on which rows existed. That is not a true “full fallback settle,” and two implementations can diverge here.

- **High — incremental seeding is still not deterministic enough for independent implementation**
  - §3.3 uses `idx(n)` and “component index” but does not define stable ordering source (`docs/durable-map-state-design.md:102-104`).
  - Semantic-anchor rule says “knnNodes ... results filtered to A” but does not define query depth/retry strategy (`docs/durable-map-state-design.md:97-99`), while store KNN requires explicit `k` (`src/store/graphStore.ts:129-133`).
  - **Failure scenario:** impl A queries `k=1` (top match outside `A` => fallback), impl B queries wider and finds in-`A` match => different placement, different ring-fallback rate, different persisted geometry.

- **Medium — new acceptance criterion is not objectively checkable as written**
  - Test target says ring-fallback rate `<10%` “on a real corpus” (`docs/durable-map-state-design.md:421-423`).
  - Repo bench README explicitly says this metric is corpus-dependent (`scripts/bench/README.md:51-52`).
  - **Failure scenario:** CI/dev choose different corpora and both claim correctness; criterion becomes non-reproducible.

- **Medium — residual naming inconsistency remains in new API material**
  - `POST /ingest` contract is `laidOut` (`docs/durable-map-state-design.md:290,296-299`), but done event is still `newNodes` (`:353-355`).
  - **Failure scenario:** client logic reading both channels drifts (display/API telemetry mismatch).

### HYPOTHESIS (plausible risk, not fully proven in-tree)

- **`RELATED`-only spring rule may diverge from current viewer physics if new visible edge kinds appear**
  - Incremental rule restricts springs to `RELATED` (`docs/durable-map-state-design.md:111`), while current viewer settle springs over all visible edges in `EDGES` (`viewer/template.html:211,251-252`).
  - Today this may be mostly equivalent, but if visible `RESONATES_WITH`/`REFERENCES` edges grow, incremental/full paths may disagree unless this is intentionally documented as a behavior change.

---

## Plain verdict on layout section

**The layout section is not yet buildable as written.**  
Core direction is much better and several prior blockers are truly fixed, but §3.4 vs §3.5 conflict plus remaining determinism gaps in §3.3 are still implementation-blocking for a geometry-safe slice 1.

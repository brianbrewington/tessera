# Round 1 review — durable map state + tessera serve (outline v1)

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-05
**Reviewed:** `docs/viewer-state-and-serve-outline.md` v1 · unsteered (dimensions only, no file paths)

---

## Confirmed Findings (Verified Against Code)

### 1) **Section 2 overstates “No HTTP anywhere in the repo”** (High)
- Claim says no HTTP anywhere, but runtime code already makes HTTP requests to Ollama:
  - `src/embedder.ts:85-89` (`fetch(.../api/embeddings)`)
  - `src/llm.ts:20-31` (`fetch(.../api/chat)`)
- More precise statement would be: **no HTTP listener/server socket exists yet** (that part does appear true from repo search of `createServer`, `node:http`, `listen(` in `src/` and `scripts/`).

### 2) **Section 2 claim “every mutation appended to mutation_log” is false as written** (High)
- Core graph writes (`putNode`, `putEdge`, `promoteNode`) do log (`src/store/graphStore.ts:155-261`, `317-381`, `553-560`).
- But at least two mutating paths do **not** append to `mutation_log`:
  - `markExtracted()` writes `extracted_chunks` (`src/store/graphStore.ts:492-494`)
  - `recordIngestedSource()` upserts `ingest_sources` (`src/store/graphStore.ts:508-522`)
- If spec assumptions depend on full replay/audit coverage, this is a premise bug.

### 3) **Section 2 claim “one Ollama call per ~1500-char chunk” is materially understated** (High)
- Ingest loop is sequential (`for ... await`), yes (`src/ingest/ingest.ts:69-109`), and chunk size default is ~1500 chars (`src/ingest/chunker.ts:12`).
- But per chunk, there are multiple model calls, not one:
  - chunk embedding (`src/ingest/ingest.ts:73`)
  - extraction chat (`src/ingest/ingest.ts:100`, `src/extract/extractor.ts:152`)
  - per-entity embedding in mapper (`src/ingest/mapper.ts:32`)
  - edge-reason embeddings when `putEdge` is called without vector (`src/store/graphStore.ts:312`)
- This affects D9 sizing and any queue/progress design assumptions.

### 4) **D5 migration strategy is under-specified at a one-way door** (High)
- You correctly identify origin scoping risk (`file://` vs `http://localhost`), but current architecture gives no existing bridge from browser `localStorage` to DB.
- Today scene state is browser-only localStorage (`viewer/template.html:584-587`) and DB writes are store-side only.
- A failure scenario: ship `serve` without a robust pre-switch export/import UX; users permanently lose `narr` and scene history on first switch.

### 5) **Test plan item “layout round-trips” can pass while behavior is unwired** (High)
- Because current layout seed + settle is deterministic (`viewer/template.html:198-199`, `240-254`), a naive reload-equality test can pass even if persisted layout is ignored.
- Need a test that proves **read path wiring** (e.g., poison stored coordinates and assert first render uses them without running settle).

### 6) **D3 scene-anchor proposal can regress existing “selected node” semantics if not constrained** (Medium)
- Current restore behavior explicitly reopens selected node (`viewer/template.html:593`) and flies to stored camera (`594`).
- Anchor-centroid restore might show “same area” but fail to reopen/focus expected node context.
- This is especially risky because `node` is already part of saved scene contract (`viewer/template.html:589`).

### 7) **Section 2 benchmark row counts/ratios are mostly grounded** (Info, verified)
- I verified `graphs/big` counts directly from DB: `12` document nodes, `199` chunk nodes, `598` total nodes, `387` non-provenance nodes.
- That matches the table’s 387/598 references and the 12-doc / 199-chunk claim.
- Ratio `~2.2` also matches total edges/nodes (not semantic-visible subset), so wording should clarify which population it refers to.

---

## Hypotheses (Plausible Risks, Not Fully Proven Yet)

### H1) **D7 Origin check alone may not be a sufficient long-term CSRF/rebinding posture**
- Likely needs stricter request validation (Host/Origin policy, null-origin handling, maybe CSRF token for state-changing routes), especially once upload/write endpoints exist.
- Section 6 acknowledges trust-boundary risk, which is good; mitigation details are still thin.

### H2) **Whole-list `PUT /scenes` is race-prone even in “single user” reality**
- Two tabs can overwrite each other; narration editing currently writes on each input (`viewer/template.html:628`), so server-side whole-list PUT could amplify lost updates/churn.
- Suggest ETag/versioning or per-scene patch semantics before rollout.

### H3) **Pinned-field incremental settle may accumulate layout debt without guardrails**
- Section 6 already flags this; I agree risk is real.
- Missing concrete trigger/metric: e.g., stress/edge-crossing threshold, max displacement budget, or scheduled rebase policy.

---

## Sections That Are Sound

- **D2 direction (server as sole writer)** aligns with existing store authority design and transaction discipline (`BEGIN IMMEDIATE` pattern in `src/store/graphStore.ts`).
- **D4 (`scenes` in DB, not `meta.json`)** is architecturally coherent with current `meta.json` being create-time metadata (`src/graph.ts:30-32`, `49-51`).
- **D8 principles** (size bounds, extension gate, path safety, ingest seam reuse) are the right defaults for v1.
- **Risk framing in section 6** is candid and useful; it correctly surfaces the hardest problems instead of hiding them.

---

## Bottom Line

The outline has good architectural instincts, but a few section-2 “ground truth” claims are inaccurate enough to distort design choices (HTTP presence, mutation-log coverage, ingest call count). Fix those premises first, then tighten D5 migration mechanics and strengthen tests so they fail when wiring is missing, not just when algorithms change.

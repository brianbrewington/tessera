# Round 3 review — durable map state + tessera serve (FULL design write-up)

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-06
**Reviewed:** `docs/durable-map-state-design.md` · unsteered (dimensions only, no file paths)

---

Not ready to implement yet.

## Confirmed Findings

- **Critical — Scene import idempotency key can collapse distinct scenes**
  - Spec defines `content_key = sha256(name ⧺ narr ⧺ sorted(anchors) ⧺ scale ⧺ show_prov)` in `docs/durable-map-state-design.md:179-181`, but `focus_node` is explicitly part of restore semantics (`:161-162`) and is **not** in the key.
  - Failure scenario: two scenes with same camera/anchors/name/narr but different `focus_node` import as one row due unique `idx_scenes_content`; panel-selection intent is silently lost.

- **High — API contract contradiction on `newNodes`**
  - `POST /ingest` response is specified as `{ chunks, entities, edges, newNodes }` (`docs/durable-map-state-design.md:205`, `:254`), but the same doc says `IngestResult` is left unchanged (`:58`).
  - Current `IngestResult` has no `newNodes` (`src/ingest/ingest.ts:17-27`).
  - Failure scenario: two engineers implement different contracts (one adds field in ingest core, one computes elsewhere), causing test/API drift and client breakage.

- **High — Upload design conflicts with “ingestFile unchanged” and SOURCE-title claim**
  - Spec says client filename is used for `isSupported()` and SOURCE title, and then `ingestFile()` is unchanged (`docs/durable-map-state-design.md:243-246`).
  - Current `ingestFile` calls `readDoc(path)` (`src/ingest/ingest.ts:38`), and `readDoc` derives `source` from resolved file path and title from filename/H1 (`src/ingest/adapters.ts:57-77`).
  - Failure scenario: server temp filename/path becomes persisted provenance/title for non-H1 docs unless ingest API is changed (contradicting “unchanged”).

- **High — Anchored settle is underspecified enough to produce incompatible implementations**
  - `docs/durable-map-state-design.md §3.3` omits precise force equations, damping, and explicit tie/order rules for newcomer indexing while requiring deterministic jitter (`:88-89`).
  - It also does not state whether spring force is only for existing graph edges or all A↔N pairs.
  - Failure scenario: two conforming-but-different implementations both “pass” prose review but produce different geometry, invalidating slice-1 “geometry-preserving” goal.

- **Medium — Fallback behavior for partially populated layout is not enforceable**
  - Precedence is stated as “stored layout ≻ fallback settle ≻ error” (`docs/durable-map-state-design.md:105-108`), but mixed-state behavior (some nodes have layout, some do not) is not fully specified.
  - Failure scenario: fallback accidentally re-settles all visible nodes and moves anchored nodes, violating additive durability invariants.

- **Medium — Failure semantics overclaim impossible cleanup guarantees**
  - Spec says temp file is unlinked in `finally` on “every exit path including crash” (`docs/durable-map-state-design.md:242`, `:290`).
  - A process crash/kill cannot execute `finally`.
  - Failure scenario: orphan temp files accumulate and disk-pressure behavior diverges from stated risk model.

- **Low — One factual citation is wrong**
  - `connect --commit` writer claim cites `scripts/connect.ts:64` (`docs/durable-map-state-design.md:57`), but line 64 is embedder selection; edge writes occur in `src/connect/connector.ts:549-552`.
  - Statement is directionally true (connect can write), but citation hygiene matters here because this round is premise verification.

## Hypotheses / Unverified Risks

- **Header-behavior measurement artifact is missing in repo**
  - Write-up treats §7.2 as measured fact, but I cannot verify the claimed probe artifact (`scratchpad/probe.mjs` mentioned in prior outline) exists in current tree.
  - Risk: security rule may still be right, but provenance is not reproducible from repository state.

- **Settle timing and ingest-latency numbers are not independently reproducible from checked-in harness**
  - Spec references measured numbers (`docs/durable-map-state-design.md:112-114`, `:258-261`, `:323`), but I did not find an obvious checked-in harness for those specific measurements.
  - Risk: planning/scope decisions may be anchored to non-repeatable local runs.

- **Queue deferral argument may overstate durability**
  - Claim “chunk memo already provides the durability a queue would buy” (`docs/durable-map-state-design.md:271-273`) is plausible for retry-after-rerun, but not equivalent to durable background job continuation across server restarts/client disconnect without re-upload.
  - Needs explicit lifecycle semantics for POST/SSE/job ownership.

## Sections That Are Sound

- Core factual baseline about current viewer settle constants and visible-set behavior is accurate (`viewer/template.html:208-215`, `:240-254`).
- Scene-id collision premise is correct (`viewer/template.html:589`, `:595`).
- No existing inbound HTTP listener in `src/` is correct.
- `layout` seam existence and current zero-layout-row posture are correctly rooted in DDL/spec (`src/db/ddl.ts:55-62`, `docs/specs/graph-store-spec-v2.md:33-34,64`).

If you want, I can do a follow-up pass that proposes exact spec text patches for each high/critical gap (still review-only, no code changes).

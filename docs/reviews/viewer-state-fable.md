# Round 2 review — durable map state + tessera serve (outline v2)

**Reviewer:** Fable 5 · **Date:** 2026-08-05
**Reviewed:** `docs/viewer-state-and-serve-outline.md` v2 · unsteered (dimensions only, no file paths)
**Note:** run as a local review agent rather than through the `cursor-review` skill, which excludes Anthropic
models by design — its purpose is a *different lab's* eyes, which round 1 (Codex + Grok) supplied.

---

**Verdict up front.** The ground truth in §2 is now solid — I verified every file:line citation and every number
against the code and the live `graphs/big` db, and they all hold. The round-1 criticals are genuinely fixed as
stated. But the document is not ready for the full write-up yet, for two reasons: **the corrected build order
still has one one-way door open — it's in slice 1, not slice 2** (F1), and **one of the round-1 security fixes
introduced a bug of its own** — the missing-`Origin` rejection on `/events` blocks the app's own EventSource
(F3). Fix F1–F4 and the rest can ride into the write-up as noted revisions.

---

## Task 1 — Ground truth (§2): verified, correct

Every claim checked against code and data. Confirmed exactly:

- `exportViewer` quine-bundle: `scripts/export-viewer.ts:35-38` ✓ (including the `<` escape).
- No listener in `src/`/`scripts/`; outbound `fetch` at `src/llm.ts:20`, `src/embedder.ts:85` ✓.
- Settle: 500 iterations, O(n²) pair loop, ring seed `Math.cos(i)*220` (`viewer/template.html:198-199, 240-254`), run by `rebuild()` (`:208-215`) before first `draw()` (`:633`), re-run on `h` (`:580`) ✓.
- **Benchmark population, re-verified against the db:** `graphs/big` = 598 nodes / 1,316 edges total (ratio 2.20 ✓), **387 visible nodes / 416 visible edges** (ratio 1.07 ✓), 199 chunks, 12 docs, 2,354 `mutation_log` rows, **0 `layout` rows** — every number in §2 matches. The table's scaling is internally consistent with quadratic repulsion (387²→1000² predicts ~1.7 s vs the measured 1.50 s; 2,000→4,000 is clean 4×). The ~32 nodes/doc column is arithmetically right (387/12 = 32.25).
- `layout` DDL `src/db/ddl.ts:55-62` ✓; spec reservation `graph-store-spec-v2.md:33, 64` ✓; `schema.md:60` ✓; `nodes.pinned` at `ddl.ts:25` ✓.
- Scene shape `{id,name,ox,oy,scale,showProv,node}` at `template.html:588-590` ✓; `narr` added by the tour textarea `:627-628` ✓; `node` restores selection only, `flyTo` uses raw camera coords `:591-594` ✓; panel save `:527` ✓.
- `markExtracted` `graphStore.ts:492` and `recordIngestedSource` `:508` do not log ✓; WAL/`tx.immediate` `:116, 237` ✓.
- Per-chunk call inventory ✓ (`ingest.ts:73` chunk embed, `:100` extract chat, `mapper.ts:32` per-entity embed, `graphStore.ts:312` per-reason embed — and note every `putEdge` in the pipeline passes no vector, so `APPEARED_IN`/`ORIGINATED_FROM` reasons each cost an embedding too; §2's phrasing covers this).
- `IngestResult` counts-only (`ingest.ts:17-27`) ✓; no node deletion anywhere in `src/` ✓; `meta.json` write-once (`graph.ts:30-32`) ✓; sequential ingest loop ✓.

One addition §2 missed, checked: **`tessera connect --commit` is also a writer** (`scripts/connect.ts:64` — edges only, no nodes, verified). It doesn't break D1/D2 today, but the doc's implicit "nodes only arrive via ingest" should be stated as a checked invariant, and it strengthens the case for making D8's `nodesLackingLayout()` the *primary* mechanism rather than the alternative — it heals any future writer path for free.

## Task 2 — Do the round-1 fixes hold?

- **CLI-as-writer order:** holds structurally. `tessera ingest`/`view` exist (`scripts/cli.ts:36, 108`), so a writer exists from slice 1, and the origin door is sequenced before `serve`. ✓ — *but see F1: a different door was left open.*
- **D5 two-artifact bridge:** executable end-to-end as mechanics (a `file://` page can read its own localStorage, compute anchors, download JSON; the CLI can import). ✓ — *but its fidelity assumption fails under the slice-1 ordering (F1) and its idempotency keys on ids that aren't unique (F4).*
- **D7 missing-`Origin` fix:** the round-1 fix overcorrected and introduced a real bug (F3).
- **§10 "noted, deferred → belongs in `docs/backlog.md`":** the `mutation_log`-coverage entry is **not in `backlog.md`** (grepped; nothing there). A finding routed to the backlog that never lands in the backlog is documented-not-handled (F10).

## Task 3 — Findings, most severe first

### CONFIRMED (verified against code/data)

**F1 — CRITICAL. The one-way door is in slice 1, not slice 2.** §5 slice 1 ships "viewer reads [stored layout] and skips settle," and D10 mandates that stored layout include chunk nodes. Today's layout that users saved scenes against is the **visible-set** settle (chunks excluded, `template.html:209-215`); D10's all-node settle produces different geometry by construction. So the moment slice 1 ships, every existing localStorage scene's `ox/oy/scale` frames the wrong region — and the anchor-recovery bridge doesn't exist until slice 2. Worse: D5's export computes anchors from stored camera coords against the *current* layout, so an export run after slice 1 binds scenes to the **wrong nodes and bakes the breakage in permanently**. The corrected order closed the writer door and the origin door but left the layout door open. Fixes (either works): (a) ship the export button + anchor computation *before or with* slice 1, against the legacy layout; or (b) defer D10, make the slice-1 TS settle a verbatim visible-set port (deterministic seed + same population ⇒ geometry-preserving), bridge in slice 2, then land D10. Also state plainly that migration fidelity is best-effort: `settle()` never re-seeds (`:242` zeroes velocities only), so within a session each `h` toggle drifts positions — layout is toggle-history-dependent — and any ingest since a scene was saved already invalidates its camera coords. The doc should instruct: *export scenes before your next ingest.*

**F2 — HIGH (security). No Host-header validation → DNS rebinding reads the whole graph.** D7's checks cover mutating routes and `/events` only; `GET /` (full graph JSON) and `GET /scenes` have no check at all. A remote page at `evil.com` whose DNS is rebound to `127.0.0.1` issues a same-origin-in-the-browser's-eyes `GET http://evil.com:7777/` — no preflight, no `Origin` header, `127.0.0.1` binding doesn't help — and exfiltrates a personal knowledge graph. The fix is one line of spec: **validate `Host` against `127.0.0.1:PORT`/`localhost:PORT` on every route**, and add the corresponding test to §8.

**F3 — HIGH. "Reject missing `Origin` on `GET /events`" breaks the server's own client.** Per the Fetch spec, a same-origin GET — which is exactly what the served page's `EventSource` issues — carries **no `Origin` header** (Origin is appended only for non-GET/HEAD or CORS-tainted requests). D7 as written rejects the app's own SSE connection. And the stated goal ("wide open to any local process") isn't achieved anyway: any local process can forge `Origin: http://127.0.0.1:7777`, and a local process can simply open the SQLite file. Replace with: strict `Origin` compare *when present* + `Sec-Fetch-Site: same-origin` enforcement + the F2 `Host` check (or a page-injected token for `/events` and mutations). Note the test-plan trap: §8's "rejects missing `Origin` on `/events`" test would pass while *enforcing* this bug; the missing test — squarely in §8's own wired-behaviour category — is "**the served page's own EventSource actually connects and receives events**." (Recommend the one-line empirical check in a browser before writing the spec text.)

**F4 — HIGH. Scene ids are not unique; D4's versioning and D5's idempotency key on identity that doesn't exist.** `id: 'sc'+performance.now().toFixed(0)` (`template.html:589`) is milliseconds-since-page-load — collisions across sessions are routine (any two scenes saved at similar page ages). An "idempotent" import keyed on `id` silently merges or drops distinct scenes at the door crossing; `delScene` (`:595`) already deletes all matches. The import must re-key (or use content-based identity) and D4 must state the id policy.

**F5 — MEDIUM. D10 changes the default map's geometry, not just its cost.** §6.4 frames the all-node-layout risk as timing. The bigger effect: putting 199 chunk + 12 doc nodes into the force field re-clusters the semantic map around document structure and leaves voids where hidden provenance sits — the default (provenance-off) view is settled today *without* those nodes. This is a different map, which also feeds F1. Either accept and say so, or promote the parenthetical two-layout alternative to a real option with the tradeoff written down.

**F6 — MEDIUM. Post-migration scene divergence is permanent and undecided.** "`file://` export keeps working throughout" — so after slice 2, a user saving a scene in `view.html` writes localStorage again, while `serve` reads the `scenes` table. Two live stores, forever, with the bridge framed as one-time. Missing decision: what does the exported HTML embed (db scenes?), are `file://`-side saves second-class, is re-import a recurring merge (which re-invokes F4)?

**F7 — MEDIUM. §8's viewer tests have no harness to run in.** The repo is vitest-only (`package.json` — no jsdom/playwright/puppeteer; `test/` is all Node-side). "Load the viewer, assert `settle()` never runs" and the scene-restore test are browser tests. Either name the harness — a new dev dependency, worth saying out loud given D6's no-new-dependencies stance — or restructure the viewer so layout/scene logic is an importable module under vitest with a thin DOM layer.

**F8 — LOW/MEDIUM. Layout-missing fallback unspecified.** `export-viewer.ts:42-46` is also a standalone entry point that bypasses `tessera view`; old dbs reach a viewer that "only reads and skips settle" with zero layout rows. Keep the settle fallback and define precedence (stored ≻ fallback settle ≻ error).

**F9 — LOW. `putLayout` no-op discipline unstated.** `tessera view` re-settling and rewriting N rows + N `mutation_log` ops per run bloats the log and churns `version`s — and skipping unchanged writes is quietly *required* for §8's "byte-identical positions" test to mean anything. One sentence in D2.

**F10 — LOW (process). The deferred `mutation_log` finding never reached `docs/backlog.md`.** Grep confirms no entry. Add it before check-in; "belongs in the backlog" without the entry is a finding without FIXED/TEST/ACCEPTED-RISK.

**F11 — LOW. The driving use case has no post-drop refresh story.** Live delta-patching is deferred (§5), SSE carries progress only — so after a drop, the new nodes appear… how? Presumably `{done}` → full page reload. Fine for v1; say it in D6/D9 so nobody discovers it as a surprise.

**F12 — NIT. D1 under-specifies newcomer–newcomer interaction.** Several new entities from one chunk can share the same anchored neighbours and thus the same centroid seed; without mutual repulsion during the relax they stack. One sentence ("newcomers repel each other; anchored nodes exert forces but never move") closes it.

### HYPOTHESES (plausible, not verified)

- **F3's spec reading should be confirmed empirically** (Chrome + Firefox, same-origin EventSource, inspect headers). I'm confident in the Fetch-spec derivation but this is exactly the kind of fact to check before it becomes spec text.
- **Node-vs-browser float determinism:** both V8, so a verbatim visible-set TS port likely reproduces the browser layout bit-for-bit (relevant to fix (b) in F1); Firefox-settled history would differ. The §8 benchmark harness is the right place to test this.
- **Scene names/narration served into HTML** need the same `</script>`-escape treatment as `export-viewer.ts:35` if `serve` injects them as a JSON literal — implementation-dependent, worth a line in D6.
- DNS-rebinding exploitability varies with browser local-network-access rollouts; treat F2 as live regardless — the `Host` check costs nothing.

## What's sound

Saying it plainly: §2 is now trustworthy ground truth — the strongest section of the document, and the benchmark table survives independent recomputation. D1's algorithm specification, D2's honest repurposing of the Resonator seam (with §6.3 flagging it), D8's contradiction fix, the D9 cost re-estimate, and §8's poisoned-coordinates test (a genuinely wiring-sensitive test) are all in good shape. The two round-1 criticals were fixed with real fixes, not renames. The remaining problem is that the revision closed two doors and left a third open (F1) and hardened one route into breaking itself (F3) — both are cheap to fix at the outline stage, which is the point of doing this now.

**Recommendation:** resolve F1–F4 in the outline (F1 changes slice boundaries; F2/F3 rewrite D7; F4 is a paragraph in D4/D5), fold F5–F12 in as noted, then proceed to the full write-up.

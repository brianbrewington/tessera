# Durable map state + `tessera serve` — design OUTLINE v3

Status: **outline v3, post two cross-agent review rounds** — round 1 Codex 5.3 + Grok 4.5 (via Cursor), round 2
Fable 5. Step 4 of: outline → review → revise → review → **revise** → full write-up → check-in. Reviewer
recommendation after round 2: resolve the criticals in the outline, fold the rest in as noted, then proceed to
the write-up. That is what this revision does.

**What the rounds changed** (§10 has the full response):
- **Round 1** found two criticals — the localStorage migration as written was *impossible*, and the build order
  contradicted its own writer rule — plus seven factual errors in what v1 called "ground truth."
- **Round 2** confirmed §2 is now correct and both criticals genuinely fixed, then found that the corrected
  order **left a third one-way door open in slice 1** (F1), that one round-1 security fix **broke the app's own
  client** (F3), that `GET /` was left entirely unprotected against DNS rebinding (F2), and that scene ids
  **are not unique** (F4), which silently undermines the migration's idempotency.

## 1. Goal & use case

Make the map **durable and additive**. A tessera graph persists perfectly; its *view* does not. Layout is
recomputed from scratch on every load, and saved scenes are camera coordinates in browser localStorage. The
driving use case: **drop a file onto a live map** and have both the map you learned and the views you saved
survive the addition, and survive a reboot.

Four slices, in the order the constraints force. The ordering rule that governs all of them: **scenes are
fragile until they are anchored (slice 2), so no slice before that may change the map's geometry.**

1. **Layout persistence, geometry-preserving.** The CLI settles and persists positions using a *verbatim port
   of today's visible-set algorithm*, so the map does not move. Viewer reads it. `file://` export keeps working.
2. **Scene re-anchoring + the export/import bridge.** Scenes become layout-independent; a `file://`-side export
   and a CLI-side import carry them across the origin door *before* it moves. **This is the one-way door.**
3. **`tessera serve` + drop target.** The local HTTP server and its trust boundary.
4. **Provenance nodes enter the layout** (was D10). Only safe *after* slice 2, because it changes geometry.

## 2. Current state (ground truth — corrected in round 1, independently re-verified in round 2)

Round 2 re-checked every citation and number in this section against the code and the live `graphs/big` db and
confirmed all of them. Two additions it found are marked ★.

- **The viewer is a quine-bundle.** `exportViewer()` inlines the whole graph as a JSON literal into
  `viewer/template.html` and writes a static file opened over `file://`. (`scripts/export-viewer.ts:35-38`)
- **No inbound listener exists.** No `createServer`/`node:http`/`listen(` in `src/` or `scripts/`. **Outbound
  HTTP already exists** — `fetch` to Ollama at `src/llm.ts:20`, `src/embedder.ts:85`. `serve` is tessera's
  first *listener*, not its first HTTP.
- **Layout is recomputed every load, over the VISIBLE SET ONLY.** `rebuild()` filters to visible nodes/edges
  and then calls `settle()` on that subset (`viewer/template.html:208-215`) — so today's geometry is
  provenance-excluded by construction. `settle()` is 500 iterations of an O(n²) n-body pass, run synchronously
  before first paint, and re-run on the `h` toggle (`:240-254, 580`).
- ★ **`settle()` does not re-seed positions.** It zeroes velocities only (`:242`); `x/y` carry over from
  wherever the nodes currently are. Seed positions are set once at construction (`:199`). Consequence: layout
  is deterministic **per fresh page load**, but *within* a session it is **toggle-history-dependent** — pressing
  `h` twice does not return you to the original map. The v2 gap thesis was right about reloads and silent about
  sessions.
- **Measured settle cost.** Verbatim port of `settle()`, run at the **visible-view** edge:node ratio of
  **1.07** (`graphs/big` default view = 416 edges / 387 nodes; the 2.20 ratio is the *whole* graph, the wrong
  population):

  | visible nodes | settle | ≈ docs (at ~32 semantic nodes/doc) |
  |---|---|---|
  | 387 (`graphs/big` today) | 0.26 s | 12 |
  | 1,000 | 1.50 s | ~30 |
  | 2,000 | 6.00 s | ~60 |
  | 4,000 | 23.6 s | ~125 |

  Repulsion is O(n²) and edges are linear, so the corrected ratio moved nothing meaningfully. Round 2
  independently recomputed the scaling as internally consistent. Author-measured, no checked-in harness (§8).
- **The `layout` table is a RESERVED SEAM, not a dead table.** `node_id, x, y, tile_id, zoom_min, version`,
  zero rows (`src/db/ddl.ts:55-62`), spec'd as Resonator-owned and written **only via
  `putLayout(nodeId, {x,y,zoom_min}, {expectedVersion}, meta)`** (`docs/specs/graph-store-spec-v2.md:33, 64`;
  `docs/schema.md:60`).
- **`nodes.pinned` already exists** (`src/db/ddl.ts:25`), unrelated to layout. This doc says **anchored**.
- **Scenes live in localStorage**, keyed `tessera-scenes-<graph>`. `saveScene()` writes
  `{id, name, ox, oy, scale, showProv, node}` — **raw world-space camera coordinates** (`:588-590`). `narr` is
  added later by the tour textarea (`:627-628`), so the stored shape differs from the saved shape.
- ★ **Scene ids are not unique.** `id: 'sc'+performance.now().toFixed(0)` (`:589`) is milliseconds *since page
  load* — two scenes saved at similar page-ages in different sessions collide. `delScene` (`:595`) filters by
  id and would delete all matches. Any import keyed on `id` is unsafe (see D5).
- **Human-authored content in a scene is `name` AND `narr`** — both must survive migration. Everything else in
  the viewer is derived from the db and regenerable.
- **The db is the durable authority**: WAL, single-writer `BEGIN IMMEDIATE`, 2,354 `mutation_log` rows in
  `graphs/big`. **`mutation_log` coverage is not universal** — `markExtracted()` (`graphStore.ts:492`) and
  `recordIngestedSource()` (`:508`) mutate without logging. Recorded in `docs/backlog.md` as ACCEPTED-RISK.
- **Ingest is sequential and costs more model calls per chunk than v1 claimed.** Per chunk: one chunk embedding
  (`ingest.ts:73`) + one extraction chat (`:100`) + **one embedding per extracted entity** (`mapper.ts:32`) +
  one per edge reason, since every `putEdge` in the pipeline passes no vector (`graphStore.ts:312`) — including
  `APPEARED_IN` and `ORIGINATED_FROM`. `graphs/big` = 12 docs → 199 chunks.
- **`IngestResult` carries no node ids** (`src/ingest/ingest.ts:17-27`) — counts only.
- **Nodes are never deleted** — no `DELETE FROM nodes` or delete API in `src/`.
- ★ **`tessera ingest` is not the only writer.** `tessera connect --commit` constructs a real `GraphStore` and
  writes **edges** (`scripts/connect.ts:64`). It adds no nodes today, so it doesn't break D1 — but "nodes only
  arrive via ingest" is an invariant to state and test, not assume (see D8).

## 3. Design decisions (proposed — reviewers should challenge)

- **D1. Positions persist; existing nodes are ANCHORED and new nodes relax against them.** Removes the
  quadratic pre-paint stall and keeps the map you learned. Algorithm: anchored nodes **do** exert repulsion and
  spring force on newcomers but never move themselves; **newcomers repel each other** during the relax (or
  several entities from one chunk sharing the same anchored neighbours stack on one point); a new node is
  seeded at the **centroid of its already-anchored neighbours**, not on the `Math.cos(i)` ring, which parks a
  low-degree newcomer on the periphery permanently; a newcomer with *no* anchored neighbours falls back to the
  ring, declared. Acceptance criterion in §8.
- **D2. The CLI is the layout writer, via `putLayout`, honoring the spec'd contract.** Settle moves from
  browser JS to TS and runs at the end of `ingest` / on `view`. Writes go through a real `putLayout` with
  `expectedVersion` + `meta` + a `mutation_log` op, per `graph-store-spec-v2.md:64`. This **repurposes a seam
  the spec reserved for the Resonator** — said out loud rather than pretending the table was free; when the
  Resonator lands it inherits a working `putLayout` instead of colliding with an ad-hoc one. **`putLayout` must
  no-op on unchanged coordinates** — otherwise every `tessera view` rewrites N rows, bumps N versions, and
  appends N log ops, and §8's "byte-identical positions" test loses its meaning.
- **D3. Scenes are anchored to node ids.** Store `{anchors: [nodeId…], scale, showProv, node, name, narr}`;
  compute `ox/oy` at restore from the anchors' *current* positions. This is a **new semantic**, not the
  completion of an existing hook — today's `node` field restores panel selection only, never framing
  (`template.html:592-594`). Open sub-decisions: anchor **selection rule** (all nodes in frame at save time?
  top-k by degree? the selected node's neighbourhood?); **framing math** (centroid vs bounding box); **scale
  policy** when a cluster has spatially expanded (restore stored `scale`, or refit to the anchors' bbox?).
  "Save as scene" from a node panel (`:527`) yields a single anchor; that case must work.
- **D4. Scenes move to a `scenes` table**, not `meta.json` (write-once create-time metadata, `graph.ts:30-32`).
  Two policies this needs and v2 lacked: a **per-scene `version`** so a whole-list write can't lose a
  concurrent edit, and a **stable id policy** — `performance.now()` ids are not unique (§2), so the table mints
  its own ids on import and the localStorage id is kept only as a provenance field.
- **D5. The migration is a TWO-ARTIFACT BRIDGE, because a `file://` page cannot write SQLite.**
  1. On the `file://` viewer: an **"Export scenes"** button that reads its own localStorage, computes anchors
     client-side against the *current* layout, and downloads `scenes.json` (including `name` and `narr`).
  2. On the CLI: **`tessera scenes import <graph> <scenes.json>`**, which re-keys ids per D4 and is idempotent
     on content, not on the incoming `id`.

  **Fidelity is best-effort, and the doc must say so to the user.** A scene's stored camera coords are only
  meaningful against the layout that produced them: any ingest since the scene was saved already invalidated
  them, and within a session each `h` toggle drifts positions (§2 ★). The export instruction is therefore
  *"export your scenes before your next ingest."* Anchors recovered from a stale camera are wrong anchors,
  permanently — which is exactly why slice 1 must not move the map (§5).
- **D6. `tessera serve <graph>`** — `node:http`, no new dependencies. `GET /` serves the injected template plus
  stored layout, `POST /ingest`, `GET /events` (SSE), `GET`/`PUT /scenes`. **After a completed drop the client
  reloads** (live delta-patching is deferred, §5) — stated so nobody discovers it as a surprise. If scene
  `name`/`narr` are injected as a JSON literal, they need the same `<` escaping as
  `export-viewer.ts:35`.
- **D7. Deny-by-default on the network surface — rewritten after round 2 found two holes.**
  - **Validate the `Host` header on EVERY route**, against `127.0.0.1:PORT` / `localhost:PORT`. Binding to
    loopback does **not** stop DNS rebinding: a page on `evil.com` rebound to `127.0.0.1` is same-origin in the
    browser's eyes, sends no `Origin`, triggers no preflight, and `GET /` would hand it the entire personal
    knowledge graph. v2 protected mutating routes and left the read of everything wide open.
  - **`Origin`: strict compare when present; do NOT reject when absent.** v2's "reject missing `Origin`" would
    reject the served page's own `EventSource`, because a same-origin GET carries no `Origin` header per the
    Fetch spec. The v2 fix broke the v2 client. Add **`Sec-Fetch-Site: same-origin`** enforcement as the
    positive signal instead.
  - Reject server-side; CORS headers alone are insufficient (simple form POSTs still reach the handler).
  - Accept explicitly: a *local process* can forge any header and can also just open the SQLite file. The
    threat model is hostile **web pages**, not local processes. Say so rather than implying otherwise.
  - Pin the default port for UX predictability — **not** for scene durability, which D4 solved.
- **D8. Uploads are bounded, and `ingestFile()` is NOT unchanged.** Temp file with `finally` unlink, size cap,
  gate on the existing `isSupported()` allowlist, never trust a client filename as a path. Incremental settle
  needs the new node ids, which `IngestResult` doesn't carry — resolve with **`nodesLackingLayout()` as the
  primary mechanism** (rather than extending `IngestResult`), because it heals *any* writer path, including
  `connect --commit` (§2 ★) and anything added later, instead of only the one the drop target calls.
- **D9. Progress is streamed; SSE is sufficient for v1, and the job queue stays deferred. MEASURED.**
  11 chunks of `docs/corpus/immune-system-as-adversarial-attention.md`, `qwen2.5:14b` + `nomic-embed-text`,
  warm model:

  | | per chunk | share |
  |---|---|---|
  | extraction chat | **9.6 s** | **97%** |
  | chunk embedding | 0.02 s | 0% |
  | entity + reason embeddings (avg 6.8 + 3.0 per chunk) | 0.3 s | 3% |
  | **total** | **9.9 s** (range 5.5–20.6, tracking output size) | |

  Cold start adds ~15 s to the first chunk only (22.3 s cold vs 7.6 s warm on a comparable chunk) — and a
  drop after an idle period is exactly when that hits, so first feedback is the slow one.

  **This corrects the v1→v3 framing in both directions.** The high *call count* is real (Codex was right) but
  is latency noise — embeddings are ~0.03 s each. The dominant term is one extraction chat per chunk. So a
  20-page drop ≈ 35 chunks ≈ **6 minutes**; `graphs/big`'s 199 chunks ≈ **33 minutes**.

  Six minutes is too long to hold a tab hostage — but **the chunk memo already provides the durability a queue
  would buy**: `markExtracted()` commits per chunk (`ingest.ts:108`), so an aborted ingest resumes and skips
  completed chunks. A dropped connection costs the tail of one document, not the document. That, not
  throughput, is why the queue is deferred. Progress-bar ETAs will swing ±2× with output size; report chunks
  done, not time remaining.
- **D10. Provenance nodes enter the layout — in slice 4, not v1.** *(Round 2, F5: this was mis-framed as a
  timing risk.)* Putting 199 chunk + 12 doc nodes into the force field doesn't just cost more; it **re-clusters
  the semantic map around document structure** and leaves voids where hidden provenance sits. It is a different
  map. Since scenes are only safe once anchored, this lands after slice 2. Alternative still open: two stored
  layouts (visible-set and all-node), chosen by the `h` toggle.
- **D11. Layout-missing fallback is explicit.** Precedence: **stored layout ≻ fallback settle ≻ error**. Old
  dbs have zero layout rows, and `scripts/export-viewer.ts:42-46` is a standalone entry point that bypasses
  `tessera view` entirely — a viewer that "only reads and skips settle" would render nothing. Keep the settle
  path in the viewer as the fallback; it is not dead code.

## 4. Proposed surface (for review)

```
tessera scenes import <graph> <file>     # slice 2 — the origin-door crossing (export is the file:// button)
tessera serve <graph> [--port 7777]      # slice 3

  GET  /            → template + graph data + stored layout      [Host-checked]
  POST /ingest      → body = one .md/.txt → ingest → counts      [Host + Origin + Sec-Fetch-Site]
  GET  /events      → SSE: {chunk: 7, of: 42} … {done}           [Host + Sec-Fetch-Site; no Origin required]
  GET  /scenes  ·  PUT /scenes                                   [Host-checked; PUT also Origin-checked]
```

## 5. Scope

**Slice 1 — geometry-preserving.** Settle ported to TS as a **verbatim visible-set port** (same algorithm, same
population, same deterministic seed) so existing scenes keep framing what they framed; `putLayout` with version
+ meta + no-op-on-unchanged; CLI writes layout on ingest/view; viewer reads it and skips settle, with D11's
fallback. Anchored-incremental settle per D1. `file://` export unchanged.

**Slice 2 — the one-way door.** Scene anchoring; `scenes` table with per-scene version and minted ids; the
`file://` export button; `tessera scenes import`.

**Slice 3.** `tessera serve`, drop target, SSE, D7 hardening.

**Slice 4.** D10 — provenance nodes in the layout (safe only once scenes are anchored).

**Deferred:** authentication; multi-user; Barnes-Hut or any sub-quadratic layout (D1 buys headroom, it does not
change the asymptote); live delta-patching of an open map; named tours; drag-reorder; non-`.md`/`.txt` uploads.

## 6. Highest-risk decisions (for the write-up)

1. **The trust boundary.** D7 was wrong twice — too narrow in v1, then broken-by-overcorrection in v2. It wants
   an implementation-time empirical check (§7), not more armchair reasoning.
2. **Does an anchored field degrade?** Nodes added over 50 documents relax into a field settled for 12. What
   triggers a full re-settle, and how does the user learn their map is about to change under them? Once scenes
   are anchored this is a quality question rather than a correctness one — which is the point of the ordering.
3. **D2's repurposing of the Resonator's seam.** Genuinely forward-compatible, or a collision deferred?
4. **Post-migration divergence** *(round 2, F6)*: `file://` export keeps working after slice 2, so a user can
   still save scenes into localStorage while `serve` reads the `scenes` table. Two live stores, with the bridge
   framed as one-time. Undecided: does the exported HTML embed db scenes? Are `file://`-side saves second-class
   or read-only? Is re-import a recurring merge — and if so, D4's id policy has to survive it.

## 7. Open questions (genuinely unknown)

- ~~Per-chunk end-to-end latency~~ — **MEASURED, closed.** See D9: 9.9 s/chunk, 97% extraction, ~6 min for a
  20-page drop; the chunk memo makes SSE sufficient and keeps the queue deferred.
- **D7's header behaviour still wants empirical confirmation** before it becomes spec text: does the served
  page's own `EventSource` connect under the rewritten rules, in Chrome and Firefox, and what headers does it
  actually send? Fable's F3 derivation from the Fetch spec is convincing and I have not independently confirmed
  it — the v2 bug came from reasoning about exactly this instead of checking it, so the rule is: **do not write
  D7 into the spec until a real browser has been observed hitting a real `/events`.** A probe server
  (`scratchpad/probe.mjs`) logs `Origin` / `Host` / `Sec-Fetch-*` per route and reports whether the page's own
  EventSource connected; it needs one browser load to answer.
- Does `view.html` survive as a "share a snapshot" artifact once `serve` exists? (It should.)
- Re-dropping an *edited* file re-extracts and may only reinforce existing entities — no new node ids, no
  visible map change. Surprising enough to need UI feedback?
- Will a Node/TS verbatim port reproduce the browser's layout closely enough for slice 1's
  geometry-preservation claim? Both are V8, so likely near-identical; a Firefox-settled history would differ.
  The §8 harness is where this gets tested, not assumed.

## 8. Test plan (each ships with the behaviour, in the same turn)

- **Layout read path is wired:** write *poisoned* coordinates to `layout`, load the viewer, assert the render
  uses them and `settle()` never runs. (A naive round-trip passes even if stored layout is ignored, because the
  seed is deterministic — this is the version that fails when someone unwires D1.)
- **Geometry preservation (slice 1):** the TS port's output matches the browser's settle for the same graph
  within a stated tolerance. This is the test that protects every pre-existing scene.
- **Additive settle, through the real path:** `tessera ingest` on a laid-out graph → every pre-existing node's
  stored position byte-identical. Must exercise CLI→`putLayout`, not a free function.
- **`putLayout` no-ops:** a second `tessera view` with no graph change appends zero `mutation_log` ops.
- **Placement acceptance for D1:** a new node with ≥1 anchored neighbour lands within N units of that
  neighbourhood's centroid (catches periphery-parking); two newcomers sharing one neighbour do not coincide.
- **Nodes-only-arrive-via-ingest invariant:** assert `connect --commit` adds no nodes, so `nodesLackingLayout()`
  stays complete.
- **Scene anchoring survives a re-settle:** save → force a full re-settle (needs a deliberate test/admin escape
  hatch, since no product path triggers one) → restore → the same nodes are in frame.
- **Migration crosses the door:** a real localStorage payload (with `name` *and* `narr`, **including two scenes
  with colliding `performance.now()` ids**) → export → import → `scenes` table, lossless, both scenes present,
  idempotent on a second run.
- **Server:** `Host` mismatch rejected on **every** route including `GET /`; foreign `Origin` rejected on
  mutating routes; oversized body rejected; unsupported extension rejected; repeat drop of identical bytes
  writes nothing; concurrent double-POST doesn't corrupt.
- **The served page's own `EventSource` connects and receives events during a real ingest.** *(Round 2, F3:
  §8's previous "rejects missing `Origin` on `/events`" test would have passed while enforcing the bug that
  broke the app — a test that passes because the false claim is present.)*
- **Benchmark harness checked in** so §2's timings are reproducible rather than author-asserted.
- **Harness gap, stated:** the repo is vitest-only — no jsdom/playwright/puppeteer, and `test/` is entirely
  Node-side. The viewer tests above need either a new dev dependency (worth saying out loud given D6's
  no-new-dependencies stance) or a restructure that makes layout/scene logic an importable module with a thin
  DOM layer. **Decide in the write-up; do not discover it during implementation.**

## 9. Hypotheses carried forward (not yet verified)

- Concurrent `POST /ingest` interleaves LLM calls while SQLite serializes writes → single-flight lock likely
  required.
- Two tabs + whole-list `PUT /scenes` → last-writer-wins narration loss. D4's per-scene `version` is the
  proposed mitigation.
- Crash mid-ingest orphans temp uploads without D8's `finally` unlink.
- DNS-rebinding exploitability varies with browser local-network-access rollouts; treat F2 as live regardless —
  the `Host` check costs nothing.

## 10. Response to the review rounds

**Round 1 (Codex 5.3 + Grok 4.5) — accepted and fixed:** both criticals (impossible `file://` db write →
two-artifact bridge; build order vs. writer rule → CLI writer); all seven §2 factual errors;
`newNodeIds`/`ingestFile` contradiction; missing-`Origin` and `/events` coverage; stale port rationale;
`nodes.pinned` collision; `layout`-as-reserved-seam; D3's overclaim; unspecified settle algorithm; the
unwirable test plan; benchmark population. *Accepted with different framing:* Codex's "anchoring regresses
selected-node semantics" — `node` is retained and selection still restores, so the regression isn't real; the
useful version was Grok's, that anchors are new semantics needing an explicit selection rule.

**Round 2 (Fable 5) — accepted and fixed:** F1 (the third one-way door: slice 1 changed geometry before scenes
were anchored → slice 1 is now a verbatim geometry-preserving port and D10 moved to slice 4); F2 (`Host`
validation on every route — DNS rebinding could read the whole graph via `GET /`); F3 (the v2 missing-`Origin`
rule broke the app's own `EventSource` → strict-when-present + `Sec-Fetch-Site`, plus the test that would have
caught it); F4 (scene ids not unique → D4 id policy + a colliding-id migration test); F5 (D10 re-framed as a
geometry change, not a timing risk); F6 (post-migration two-store divergence → §6.4); F7 (no browser test
harness → §8 states the decision); F8 (layout-missing fallback → D11); F9 (`putLayout` no-op → D2 + test); F11
(post-drop reload → D6); F12 (newcomer–newcomer repulsion → D1). Round 2's ★ additions to §2 — `settle()`'s
non-re-seeding and `connect --commit` as a writer — are folded in.

**F10 (process): closed.** The round-1 `mutation_log` finding was marked "belongs in the backlog" and never put
there. It is now in `docs/backlog.md` with an explicit **ACCEPTED-RISK** disposition. A finding routed to a
backlog that never reaches it is a finding without a disposition.

## 11. Where this stands

Round 2's recommendation was: fix F1–F4 in the outline, fold F5–F12 in as noted, then proceed to the full
write-up. Done. Two things should happen **before** the write-up rather than inside it: measure per-chunk
ingest latency (gates D9), and empirically check the D7 header behaviour in a browser (the v2 bug came from
reasoning where a five-minute check was available).

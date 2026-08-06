# Durable map state + `tessera serve` — full design (write-up)

Status: **full write-up**, following `docs/viewer-state-and-serve-outline.md` v3 and its two cross-agent review
rounds (Codex 5.3 + Grok 4.5; Fable 5) plus two empirical measurements. This is the spec the implementation
follows. §11 is the **v1 cut and it governs** — where this document and §11 disagree, §11 wins.

Nothing here is built yet.

## 1. Goal

Make the tessera map **durable and additive**. The graph persists; the *view* does not. Layout is recomputed
from scratch on every load, and saved scenes are camera coordinates in browser localStorage. The driving use
case: **drop a file onto a live map** and have both the map you learned and the views you saved survive the
addition, and survive a reboot.

## 2. Foundational decisions (locked by the reviews, the measurements, and Brian's steers)

- **F-1. The CLI is the layout writer** (Brian's call, resolving round 1's order-vs-writer contradiction). A
  writer exists from slice 1; the browser never writes the store.
- **F-2. Scenes are fragile until anchored, so nothing before slice 2 may change the map's geometry**
  (round 2, F1). This is the ordering rule the whole plan hangs on.
- **F-3. A `file://` page cannot write SQLite** (round 1). Migration is a two-artifact bridge, never a direct
  write.
- **F-4. The threat model is hostile web pages, not local processes.** A local process can forge any header
  and can open the SQLite file directly. Stated, not implied.
- **F-5. Header rules are measured, not derived** (round 2 F3 + both self-inflicted bugs). §7.2's table is
  observed behaviour from Chrome and Firefox.
- **F-6. Extraction is 97% of ingest latency and the chunk memo already provides crash-resumability**
  (measured). SSE is sufficient; the job queue is deferred on that basis.
- **F-7. `layout` is a seam the store spec reserved for the Resonator.** We repurpose it deliberately and
  implement the spec'd `putLayout` rather than an ad-hoc write, so the Resonator inherits a working API.

## 3. The layout subsystem (highest-risk section)

### 3.1 Store API (new, in `GraphStore`)

```ts
putLayout(nodeId: string, pos: {x: number; y: number; zoomMin?: number | null},
          opts: {expectedVersion?: number}, meta: Meta): {version: number; changed: boolean}

putLayoutBatch(entries: Array<{nodeId: string; x: number; y: number; zoomMin?: number | null}>,
               meta: Meta): {written: number; unchanged: number}

getLayout(): Map<string, {x: number; y: number; zoomMin: number | null; version: number}>
nodesLackingLayout(): string[]
```

Contract:

- **No-op on unchanged coordinates** (round 2, F9). If `x`/`y`/`zoomMin` are identical, return
  `{changed: false}`, do **not** bump `version`, do **not** append to `mutation_log`. Without this, every
  `tessera view` rewrites N rows and appends N log ops, and §10's byte-identical-position test means nothing.
- **Optimistic concurrency**: `expectedVersion` mismatch throws, per `graph-store-spec-v2.md:64`.
- **Batch form is the normal path** — 387 individual transactions is the wrong shape. `putLayoutBatch` runs one
  `BEGIN IMMEDIATE`, applies the no-op rule per row, and emits **one** `mutation_log` op summarising the batch.
- **`nodesLackingLayout()` is the primary newcomer mechanism** (round 2). It heals *any* writer path —
  including `connect --commit`, which writes edges today (`scripts/connect.ts:64`) and could write nodes
  tomorrow — rather than only the path the drop target calls. `IngestResult` is left alone.

### 3.2 The settle port (`src/layout/settle.ts`)

A **verbatim port** of `viewer/template.html:238-254`. Same constants, same schedule, same integration order:

```
kRep=5200  kSpring=0.045  rest=90  grav=0.012  iterations=500
alpha(it) = max(0.03, 0.992^it)
seed:  x = cos(i)*220 + (i%7-3)*30 ,  y = sin(i)*220 + (i%5-2)*30 ,  vx = vy = 0
per iteration:  pairwise repulsion kRep/d² → gravity (-pos*grav) → springs kSpring*(d-rest)
                → integrate x += vx*alpha ; damp vx *= 0.82
```

Two requirements that make "verbatim" mean something:

- **Node ordering is load-bearing**, because the seed is index-derived. The viewer's order is `allNodes()`
  order, which is `SELECT * FROM nodes` with no `ORDER BY` — de facto rowid order. The port and `allNodes()`
  both become explicit **`ORDER BY rowid`**: identical to today's behaviour, no longer implicit.
- **Population is the visible set** — provenance nodes excluded, exactly as `rebuild()` does
  (`template.html:209-215`). Slice 4 changes this; slices 1–3 must not.

### 3.3 Anchored incremental settle

```
A = nodes with layout rows (anchored)     N = nodesLackingLayout() (newcomers)

1. Load A positions via getLayout().
2. Seed each n ∈ N:
     nbrs = neighbours(n) ∩ A
     if nbrs ≠ ∅ : centroid(nbrs) + deterministic jitter (index-derived, never Math.random)
     else        : ring formula at the next ring index (declared fallback)
3. Relax for `iterations` steps:
     - A exerts repulsion and spring force on N, and never moves
     - N ↔ N repel and spring each other        ← without this, several entities from one chunk
                                                   sharing a neighbour stack on one point (round 2, F12)
     - gravity applies to N only
     - integrate N only
4. putLayoutBatch(positions of N)
```

Cost is **O(|N|·(|A|+|N|)) per iteration — linear in the existing map**, not quadratic. Adding 30 nodes to a
400-node map is ~30×430 pair-ops per iteration, i.e. free. This is the property that makes the drop target
viable at a scale where a full re-settle is not.

### 3.4 Read path and fallback (round 2, F8)

Precedence: **stored layout ≻ fallback settle ≻ error.** The viewer keeps `settle()` and uses it when a node
has no stored position — old dbs have zero `layout` rows, and `scripts/export-viewer.ts:42-46` is a standalone
entry point that bypasses `tessera view` entirely. The in-browser settle is **not** dead code; it is the
fallback, and it must stay correct.

### 3.5 What this fixes, quantified

`settle()` runs synchronously before first paint: 0.26 s at today's 387 visible nodes, 1.50 s at 1,000, 6.00 s
at 2,000 (~60 documents), 23.6 s at 4,000. Reading stored positions removes that stall entirely. It does **not**
change the asymptote — a full re-settle is still O(n²), which is why §11 keeps Barnes-Hut on the deferred list
rather than pretending the problem is solved.

## 4. The scenes subsystem

### 4.1 Schema

```sql
CREATE TABLE IF NOT EXISTS scenes (
  id          TEXT PRIMARY KEY,              -- minted here; NEVER the localStorage id
  name        TEXT NOT NULL,
  narr        TEXT,
  scale       REAL NOT NULL,
  show_prov   INTEGER NOT NULL DEFAULT 0,
  focus_node  TEXT REFERENCES nodes(id),     -- panel selection (today's `node`)
  ordinal     INTEGER NOT NULL,              -- tour order
  legacy_id   TEXT,                          -- provenance from localStorage; NOT unique, NOT a key
  content_key TEXT NOT NULL,                 -- idempotency key, see §5
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenes_content ON scenes(content_key);

CREATE TABLE IF NOT EXISTS scene_anchors (
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  node_id  TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (scene_id, node_id)
);
```

**Id policy** (round 2, F4). `id: 'sc'+performance.now().toFixed(0)` (`template.html:589`) is milliseconds
*since page load* — two scenes saved at similar page-ages in different sessions collide, and `delScene`
(`:595`) filters by id and would delete all matches. The table mints its own ids; the localStorage id is kept
only as `legacy_id`, for provenance, and is never used as a key.

### 4.2 Anchoring semantics

- **Selection at save time:** nodes whose screen position falls inside the viewport, ranked by degree, capped
  at **K = 12**. If the viewport contains none (a scene framing empty space), fall back to the **3 nearest
  nodes to viewport centre** — a scene must always resolve to something.
- **Save-from-node-panel** (`template.html:527`) yields exactly one anchor: that node. This case must work and
  gets its own test.
- **Framing at restore:** compute the bounding box of the anchors' *current* positions; centre on the bbox
  centre; **scale = min(stored scale, fit scale)** where fit-scale makes the bbox occupy ~70% of the viewport.
  Rationale: honour the user's zoom intent, but if the cluster has spread since the scene was saved, zoom out
  enough that they still see the thing they saved. Pure stored-scale would frame the centre of a cluster that
  no longer fits; pure refit would discard a deliberate close-up.
- `focus_node` still restores the panel selection, exactly as today. Anchors govern the camera; `focus_node`
  governs the panel. They are independent (round 1 established the first, round 2 corrected the framing of it).

## 5. The migration — the one-way door

localStorage is origin-scoped. `file://…/view.html`, `http://127.0.0.1:7777`, and `http://127.0.0.1:7778` are
three different origins. Once `serve` ships, the old scenes are unreachable from the new page. The bridge must
therefore land **in slice 2, before `serve` exists** (F-3, F-2).

**Artifact 1 — `file://` side.** An "Export scenes" control in the viewer:
1. read `localStorage['tessera-scenes-<graph>']`;
2. for each scene, *replay its framing* — set the camera to its stored `ox/oy/scale`, compute which nodes fall
   in the viewport, select anchors per §4.2;
3. download `scenes.json` carrying `{name, narr, scale, showProv, focusNode, anchors[], legacyId, ordinal}`.

**Artifact 2 — CLI side.** `tessera scenes import <graph> <scenes.json>`:
1. resolve every anchor id against `nodes`; drop unresolvable ids with a **counted warning**, never silently;
2. a scene whose anchors *all* fail to resolve is reported and skipped, not written empty;
3. mint `id`, preserve `legacy_id`, compute `content_key = sha256(name ⧺ narr ⧺ sorted(anchors) ⧺ scale ⧺
   show_prov)`;
4. **idempotent on `content_key`**, not on the incoming id — re-running the import is a no-op.

**Fidelity is best-effort, and the user must be told.** A scene's camera coordinates are only meaningful
against the layout that produced them. Two things already invalidate them: any ingest since the scene was
saved, and — within a single session — each `h` toggle, because `settle()` zeroes velocities but never re-seeds
positions (`template.html:242`), so layout is toggle-history-dependent. The export control therefore carries the
instruction **"export before your next ingest,"** and slice 1 is geometry-preserving precisely so that this
window stays open.

## 6. Post-migration divergence (round 2, F6 — decided)

After slice 2 the `file://` export still works, so a user could save scenes into localStorage while `serve`
reads the `scenes` table. **Decision: the db is the single source of truth for scenes.** The exported
`view.html` embeds db scenes read-only — it can *restore and tour* them, and its "save scene" control is
removed rather than left to write a store nothing reads. Re-import stays available as an escape hatch and is
safe to run repeatedly (§5, `content_key`). This closes the two-live-stores problem by removing the second
store rather than by synchronising it.

## 7. `tessera serve`

### 7.1 Routes

```
GET  /            → template + graph data + stored layout + scenes (read-only bundle)
POST /ingest      → one .md/.txt → { chunks, entities, edges, newNodes }
GET  /events      → SSE progress
GET  /scenes      → scenes + anchors
PUT  /scenes      → replace list (per-scene `version`; stale version → 409)
```

`node:http`, **no new runtime dependencies**. Bind `127.0.0.1` explicitly, never `0.0.0.0`. Default port 7777,
pinned for UX predictability (not for durability — §4.1 solved that).

### 7.2 The header rule — measured in Chrome and Firefox, which agreed on every field

| request | `Origin` | `Host` | `Sec-Fetch-Site` |
|---|---|---|---|
| `GET /` — typed/opened URL (navigation) | absent | `127.0.0.1:7777` | **`none`** |
| `GET /events` — the page's own `EventSource` | **absent** | `127.0.0.1:7777` | `same-origin` |
| `POST /ingest` — the page's own `fetch` | `http://127.0.0.1:7777` | `127.0.0.1:7777` | `same-origin` |
| curl / any non-browser client | absent | (as sent) | **absent** |

Therefore:

- **`Host` validated on EVERY route**, against `127.0.0.1:PORT` / `localhost:PORT`. This is the only check that
  stops DNS rebinding: a page on `evil.com` rebound to `127.0.0.1` is same-origin in the browser's eyes, sends
  no `Origin`, triggers no preflight — and would otherwise read the entire personal knowledge graph from
  `GET /`. Loopback binding does not help.
- **Navigation (`GET /`): accept `Sec-Fetch-Site: none` or `same-origin`.** Never require `same-origin` — a
  typed URL sends `none`, and requiring `same-origin` blocks the page from loading at all.
- **API routes (`/events`, `/scenes`, `/ingest`): require `Sec-Fetch-Site: same-origin`.**
- **`Origin`: strict-compare when present; never require presence.** The SSE GET has none.
- Reject server-side. CORS headers alone are insufficient — a simple form POST still reaches the handler.

Both of the rules this replaces would have broken the app: "reject missing `Origin` on `/events`" rejects our
own EventSource, and "require `same-origin` everywhere" blocks the initial page load. Neither was caught by
reasoning; both were caught by one browser load. **Do not modify §7.2 without re-running the probe.**

### 7.3 Upload handling

- `Content-Length` cap of **4 MB**, enforced before reading the body and again while streaming.
- Stream to a server-generated temp path; **`finally` unlink** on every exit path including crash (round 2).
- The client-supplied filename is used **only** to test `isSupported()` (`src/ingest/adapters.ts`) and to set
  the SOURCE title. It never contributes to a filesystem path.
- Then `ingestFile()` unchanged — content-hash dedup already makes a repeat drop a true no-op
  (`ingest.ts:48-50`).
- **Single-flight per graph.** A second concurrent `POST /ingest` gets **409**, rather than interleaving LLM
  calls against a serialised SQLite writer.

### 7.4 Progress and completion

```
event: {phase:'chunk', i, of}      per chunk
event: {phase:'done', chunks, entities, edges, newNodes}
event: {phase:'error', message}
```

Measured budget: **9.9 s per chunk** (extraction 97%, embeddings 3%; range 5.5–20.6 s tracking output size),
plus ~15 s once for cold model load — which a drop-after-idle always pays, so first feedback is the slow one. A
20-page drop is ~6 minutes; `graphs/big`'s 199 chunks would be ~33.

Report **chunks done, not time remaining** — per-chunk variance is ±2×.

On `done` the client **reloads** (live delta-patching is deferred, §11). An `EventSource` auto-reconnects on
connection loss carrying identical headers, so the progress stream self-heals across a server restart with no
client code.

### 7.5 Why no job queue

Six minutes is too long to hold a tab hostage — but `markExtracted()` commits per chunk (`ingest.ts:108`), so
an aborted ingest resumes and skips completed chunks. **The chunk memo already provides the durability a queue
would buy.** A dropped connection costs the tail of one document, not the document. Deferred for that reason,
not for throughput.

## 8. CLI surface

```
tessera view <name>                          # now also settles + persists layout
tessera ingest <name> <path...>              # now also settles newcomers + persists layout
tessera scenes import <name> <scenes.json>   # slice 2 — the origin-door crossing
tessera serve <name> [--port 7777]           # slice 3
```

## 9. Failure semantics

| failure | behaviour |
|---|---|
| crash mid-ingest | chunk memo resumes; unmarked chunks retry (existing behaviour, unchanged) |
| crash mid-layout-write | batch is one transaction — all or nothing; newcomers stay in `nodesLackingLayout()` and are settled next run |
| upload crash / abort | temp file unlinked in `finally` |
| concurrent ingest | 409, single-flight |
| stale scene write | 409 on `version` mismatch |
| unresolvable anchor on import | counted warning; scene with zero resolvable anchors is skipped, not written empty |
| no layout rows (old db, or standalone `export-viewer`) | fallback to in-browser settle (§3.4) |

## 10. Test plan

Every item ships with its behaviour in the same commit. Tests marked **(wiring)** fail if the feature is
unwired, not merely if an algorithm changes.

- **(wiring) Poisoned layout:** write absurd coordinates to `layout`, render, assert they are used and
  `settle()` never runs. A naive round-trip passes even when stored layout is ignored, because the seed is
  deterministic.
- **Geometry preservation:** the TS port's output matches the browser's settle for the same graph within a
  stated tolerance. This is the test that protects every pre-existing scene, and it is what makes slice 1 safe.
- **(wiring) Additive settle through the real path:** `tessera ingest` on a laid-out graph → every
  pre-existing node's stored position byte-identical. Must exercise CLI → `putLayoutBatch`, not a free function.
- **`putLayout` no-ops:** a second `tessera view` with no graph change appends **zero** `mutation_log` ops.
- **Placement acceptance:** a newcomer with ≥1 anchored neighbour lands within N units of that neighbourhood's
  centroid (catches ring-parking); two newcomers sharing one neighbour do not coincide (catches stacking).
- **Ordering invariant:** `allNodes()` returns `ORDER BY rowid` and the port consumes the same order.
- **Writer invariant:** `connect --commit` adds no nodes, so `nodesLackingLayout()` stays complete.
- **Scene anchoring survives a re-settle:** save → force a full re-settle (via a deliberate test-only escape
  hatch; no product path triggers one) → restore → the same nodes are in frame.
- **(wiring) Migration crosses the door:** a real localStorage payload including `name`, `narr`, and **two
  scenes with colliding `performance.now()` ids** → export → import → both present, lossless, idempotent on a
  second run.
- **Server:** `Host` mismatch rejected on **every** route including `GET /`; foreign `Origin` rejected on
  mutating routes; navigation with `Sec-Fetch-Site: none` **accepted**; oversized body rejected; unsupported
  extension rejected; repeat drop of identical bytes writes nothing; concurrent double-POST → 409.
- **(wiring) The served page's own `EventSource` connects and receives events during a real ingest.** The
  outline's earlier "rejects missing `Origin` on `/events`" test would have passed *while enforcing the bug*.
- **Benchmark harness checked in**, so the settle timings are reproducible rather than author-asserted.

**Harness decision (round 2, F7).** The repo is vitest-only — no jsdom/playwright/puppeteer, and `test/` is
entirely Node-side. Resolution: **extract layout and scene logic into `src/layout/` and `src/scenes/` as
importable modules tested under vitest**, and keep the browser-only surface (canvas, DOM events) thin enough
that the two `(wiring)` viewer tests are the only ones needing a DOM. Those two use **jsdom as a dev
dependency** — a real cost, stated up front rather than discovered mid-implementation, and it does not violate
D6's no-new-*runtime*-dependencies rule.

## 11. THE v1 CUT — this section governs

### v1 (GO) — four slices, in this order

**Slice 1 — geometry-preserving layout.** `putLayout`/`putLayoutBatch`/`getLayout`/`nodesLackingLayout`;
verbatim visible-set settle port with `ORDER BY rowid`; anchored incremental settle; CLI writes layout on
`ingest`/`view`; viewer reads it, skips settle, keeps the fallback. `file://` export unchanged. **Ships with:**
geometry-preservation test, poisoned-layout wiring test, additive-settle test, no-op test.

**Slice 2 — the one-way door.** Scene anchoring; `scenes` + `scene_anchors`; the `file://` export control;
`tessera scenes import`. **Ships with:** the colliding-id migration test, anchor-survives-re-settle test,
single-anchor test.

**Slice 3 — `tessera serve`.** Routes, drop target, SSE, §7.2 header rule, upload bounds, single-flight.
**Ships with:** the full server test row above, including the EventSource-connects wiring test.

**Slice 4 — provenance in the layout.** Safe only once scenes are anchored, because it changes geometry.

### Deferred (v1.5+), stated not hidden

Authentication · multi-user / concurrent viewers · Barnes-Hut or any sub-quadratic layout · live delta-patching
(v1 reloads on `done`) · a job queue (§7.5) · named tours, drag-reorder · non-`.md`/`.txt` uploads (the adapter
backlog governs) · full-re-settle as a product feature (test-only escape hatch in v1).

### Known v1 limitations

- **Migration fidelity is best-effort.** Scenes saved before the last ingest already have stale cameras; their
  recovered anchors will be approximate. Mitigated by slice 1 being geometry-preserving and by telling the user
  to export first — not eliminated.
- **The anchored field accumulates layout debt.** Nodes added across 50 documents relax into a field settled
  for 12. There is no automatic re-settle trigger in v1. Once scenes are anchored this is a *quality* problem,
  not a correctness one — which is the whole reason for the ordering.
- **A full re-settle has no product path.** Only a test/admin escape hatch. If the map degrades, v1 has no
  supported cure.
- **`layout` is repurposed from a seam the store spec reserved for the Resonator.** Implementing the spec'd
  `putLayout` is the mitigation, not a guarantee of no future collision.
- **The O(n²) wall is unmoved.** Stored layout removes the per-load stall; it does not raise the ~2,000-node
  ceiling for any operation that must re-settle everything.
- **`mutation_log` coverage is still not universal** (`markExtracted`, `recordIngestedSource` — backlog,
  ACCEPTED-RISK). Layout writes are logged; those two remain unlogged.

## 12. Open product judgements (not missing measurement)

- Should a re-dropped *edited* file surface "3 entities reinforced, 0 new" in the UI? Content-hash dedup means
  it may produce no visible map change, which will read as a failed drop.
- Does `view.html` remain a first-class "share a snapshot" artifact, or drift to a debug tool once `serve`
  exists? §6 makes it read-only for scenes; its long-term role is undecided.
- What is the re-settle trigger a user would actually want — a count threshold, a stress metric, or an explicit
  "re-tile my map" button they choose to press?

## 13. Suggested next step

This write-up has not been reviewed. Round 1 and round 2 both found criticals in a document that felt finished,
and the two measured questions both changed a decision. A third cross-agent round against **this** document —
unsteered, dimensions only — is the cheap version of finding out whether §3.3, §4.2, and §7.2 survive contact
with an implementer.

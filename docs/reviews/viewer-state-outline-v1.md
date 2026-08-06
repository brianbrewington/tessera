# Durable map state + `tessera serve` — design OUTLINE

Status: **outline for cross-agent review** (step 1 of: outline → review → full write-up → review → check-in).
Deliberately a skeleton — decisions and open questions surfaced for reviewers to poke *before* the full
write-up is invested. Not a spec yet.

## 1. Goal & use case

Make the map **durable and additive**. Today a tessera graph persists perfectly and its *view* does not: the
layout is recomputed from scratch on every export, and saved scenes are camera coordinates in browser
localStorage. The driving use case: **drop a file onto a live map** and have both the map you learned and the
views you saved survive the addition — and survive a reboot.

Three coupled changes, in an order that matters:

1. **Layout persistence** — settled node positions become durable state, not a per-load recomputation.
2. **Scene re-anchoring + migration** — scenes become layout-independent and move out of localStorage.
3. **`tessera serve` + drop target** — a local HTTP server so the browser can trigger ingest at all.

## 2. Current state (ground truth — verified, with citations)

- **The viewer is a quine-bundle.** `exportViewer()` inlines the whole graph as a JSON literal into
  `viewer/template.html` and writes a static file opened over `file://`. (`scripts/export-viewer.ts:36`)
- **No HTTP anywhere in the repo.** `grep` for `createServer`/`node:http`/`listen(` across `src/` and
  `scripts/` returns nothing. Three runtime deps (`better-sqlite3`, `sqlite-vec`, `zod`). tessera has never
  opened a socket. (`package.json`)
- **Layout is recomputed every load.** `settle()` is 500 iterations of an O(n²) n-body pass from a
  deterministic seed (`x: Math.cos(i)*220…`), run **synchronously before first paint**, and re-run by
  `rebuild()` on the `h` (show-provenance) toggle. (`viewer/template.html:199, 238-254`)
- **Measured settle cost** (verbatim port of `settle()`, edge:node ratio 2.2 matching `graphs/big`):

  | visible nodes | settle | ≈ docs (at ~32 semantic nodes/doc) |
  |---|---|---|
  | 387 (`graphs/big` today) | 0.26 s | 12 |
  | 598 (with provenance shown) | 0.57 s | — |
  | 1,000 | 1.7 s | ~30 |
  | 2,000 | 6.0 s | ~60 |
  | 4,000 | 23.8 s | ~125 |

- **A `layout` table already exists and is dead.** `node_id, x, y, tile_id, zoom_min, version` — defined in
  DDL, never read, never written. (`src/db/ddl.ts:55`)
- **Scenes live in localStorage**, keyed `tessera-scenes-<graph>`, as
  `{id, name, ox, oy, scale, showProv, node, narr}` — i.e. **raw world-space camera coordinates**.
  (`viewer/template.html:584-590`)
- **`narr`** (per-stop tour narration, edited in `renderNow()`) is the only human-authored prose in the
  system. Everything else in the viewer is derived from the db and regenerable. (`viewer/template.html:626`)
- **The db is the durable authority**: WAL, single-writer `BEGIN IMMEDIATE`, every mutation appended to a
  replay-grade `mutation_log` (2,354 rows in `graphs/big`). (`src/store/graphStore.ts`)
- **Ingest is strictly sequential** — one Ollama call per ~1500-char chunk, no batching or concurrency;
  `graphs/big` = 12 docs → 199 chunks → 199 serial extractions. (`src/ingest/ingest.ts:69`)

**The gap.** Scenes work today *by accident*: the seed is deterministic and the node set is fixed, so every
re-export re-settles to the same map and saved cameras land where they did before. Ingesting one document
breaks that invariant silently — no error, just scenes framing the wrong region. The drop target is a machine
for breaking it.

## 3. Design decisions (proposed — reviewers should challenge)

- **D1. Positions persist in the `layout` table; new nodes settle against a pinned field.** Existing nodes
  load their stored `x/y` and are held fixed; only newly-added nodes are relaxed against them. The map you
  learned stays the map you learned. Also removes the quadratic pre-paint stall on every load.
- **D2. The server writes layout; the viewer only reads it.** Keeps the single-writer + `mutation_log`
  discipline intact rather than opening a second write path. (Alternative for review: viewer POSTs positions
  after settling — simpler, but puts the browser in the writer seat.)
- **D3. Scenes are anchored to node ids, not camera coordinates.** Store `{anchors: [nodeId…], scale,
  showProv, node, narr}`; compute `ox/oy` at restore from the anchors' *current* positions. A scene then means
  "show me these things," which stays true across any re-settle or layout-algorithm swap. The record already
  carries `node` — this extends a half-built hook.
- **D4. Scenes move to a `scenes` table**, not `meta.json`. The sidecar is write-once self-describing
  metadata (`graph.ts:31`); scenes are mutable user content and belong under the same writer discipline.
- **D5. The localStorage migration runs BEFORE the origin changes — it is the one-way door.** localStorage is
  origin-scoped; `file://…/view.html` and `http://localhost:PORT` are different origins, and so are two
  different ports. Once step 3 ships, every pre-existing scene (and its narration) is unreachable. The import
  path must land and be exercised while the viewer is still on `file://`.
- **D6. `tessera serve <graph>`** — `node:http`, no new dependencies. `GET /` serves the injected template,
  `POST /ingest` accepts a file, `GET /events` streams progress (SSE), `GET/PUT /scenes`.
- **D7. Bind to loopback explicitly, pin the port, and check `Origin`.** Bind `127.0.0.1` (not `0.0.0.0`),
  reject requests whose `Origin` isn't the server's own, and pin the default port so scenes don't vanish
  between runs. **No authentication in v1 — stated, not hidden** (see §6).
- **D8. Uploads are bounded and go through the existing seam.** Write the body to a temp file, enforce a size
  cap, gate on the existing `isSupported()` allowlist, never trust a client-supplied filename as a path. Then
  call `ingestFile()` unchanged — content-hash dedup already makes a repeat drop a true no-op.
- **D9. Progress is streamed, because ingest latency is unmeasured and probably long.** A 20-page drop is
  40–60 serial LLM calls with the user watching. The per-chunk latency is an **open question** (§7) and it
  decides whether v1 needs a progress stream or a real job queue.

## 4. Proposed surface (for review)

```
tessera serve <graph> [--port 7777]

  GET  /            → viewer/template.html + injected graph data + stored layout
  POST /ingest      → body = one .md/.txt → ingestFile() → { entities, edges, newNodeIds }
  GET  /events      → SSE: {chunk: 7, of: 42} … {done}
  GET  /scenes      → the graph's scenes
  PUT  /scenes      → replace (whole-list write; scenes are small)
```

## 5. Scope (proposed v1 cut)

**In:** layout persistence + pinned-field incremental settle; scenes re-anchored to node ids; `scenes` table;
the localStorage → db migration; `tessera serve` with drop target, SSE progress, loopback bind + Origin check.

**Deferred:** authentication; multi-user / concurrent viewers; Barnes-Hut or any sub-quadratic layout (D1
buys headroom, it doesn't change the asymptote); live delta-patching of the open map (v1 may re-fetch);
drag-to-reorder tours; named tours; non-`.md`/`.txt` uploads (the adapter backlog governs those).

## 6. Highest-risk decisions (flag for the reviewers)

1. **The new trust boundary.** A loopback HTTP server that accepts file uploads, invokes an LLM, and writes
   SQLite. Any page in the user's browser can issue cross-origin POSTs to localhost; DNS-rebinding against
   loopback services is a known class. D7 is my proposed mitigation and I want it attacked, not ratified.
2. **Does a pinned field degrade over time?** Nodes added over 50 documents relax against a field settled for
   a 12-document graph. At some point the map is worse than a fresh settle. What's the trigger, and how does
   the user find out their map is about to change under them?
3. **Anchor semantics.** Centroid or bounding box? What does a scene do when its anchors' positions have
   drifted apart — reframe wide, or refuse? (Nodes are never deleted today, so "anchor missing" is not yet
   reachable — confirm that still holds.)
4. **D2 vs the alternative.** Server-writes is disciplined but means the browser can't settle-and-keep
   locally. Is that the right trade for a single-user local tool?

## 7. Open questions (genuinely unknown — not rhetorical)

- **Per-chunk extraction latency is unmeasured.** Ollama was not running when the ground truth above was
  gathered. This number gates D9 and should be measured before the full write-up.
- Do we re-export `view.html` at all once `serve` exists, or does the static export become a separate
  "share a snapshot" path? (It has real value as an offline artifact — don't delete it by accident.)
- Layout for provenance nodes: the `h` toggle changes the visible set. One stored layout for both states, or
  two?

## 8. Test plan (sketch — each item ships with the behaviour, not after)

- Layout round-trips: settle → persist → reload → identical positions.
- **Additive settle:** ingest a doc into a laid-out graph → assert every pre-existing node's position is
  unchanged. (This is the test that fails if someone unwires D1.)
- Scene anchoring: save a scene → force a full re-settle → restore → the same nodes are in frame.
- Migration: a localStorage payload (including `narr`) imports to the `scenes` table with no loss; running it
  twice is idempotent.
- Server: rejects a foreign `Origin`; rejects an oversized body; rejects an unsupported extension; a repeat
  drop of an identical file writes nothing (content-hash no-op).

## 9. Review dimensions (for the cross-agent pass — deliberately no file paths)

Security of a new local network surface · data durability and migration safety (one-way doors) · algorithmic
scalability under growth · separation of concerns between a browser client and a single-writer store ·
test coverage at call sites rather than capabilities · docs-vs-code consistency.

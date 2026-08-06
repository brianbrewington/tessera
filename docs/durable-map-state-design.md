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
  including `connect --commit`, which writes edges today (`src/connect/connector.ts:549`) and could write nodes
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

Three requirements that make "verbatim" mean something. The first two are separate populations and conflating
them is the single easiest way to build this wrong:

- **Node ordering is load-bearing**, because the seed is index-derived. The viewer's order is `allNodes()`
  order, which is `SELECT * FROM nodes` with no `ORDER BY` — de facto rowid order. The port and `allNodes()`
  both become explicit **`ORDER BY rowid`**: identical to today's behaviour, no longer implicit.
- **SEEDING population is the FULL node list, provenance included.** `template.html:199` maps over
  `GRAPH.nodes` — the complete `allNodes()` array — so each node's seed index `i` is its position among *all*
  598 nodes, not among the 387 visible ones. **Assign seeds before filtering, and never reindex after.**
  Seeding over the visible-filtered list instead would change the seed of **387 of 387** visible nodes on
  `graphs/big` — a different map, which silently voids slice 1's geometry-preservation guarantee and re-opens
  the migration door under a new mechanism.
- **FORCE population is the visible set** — provenance excluded, exactly as `rebuild()` does
  (`template.html:209-215`). Slice 4 changes this; slices 1–3 must not.

### 3.3 Anchored incremental settle

```
A = visible nodes WITH layout rows (anchored)
N = nodesLackingLayout() ∩ visible()          ← the ∩ visible() is load-bearing; see below

1. Load A positions via getLayout().
2. Partition N into CONNECTED COMPONENTS over visible-endpoint edges within N.
   ** The component, not the node, is the unit that gets placed.** See §3.3.1.
3. Seed each component C by the first rule that applies:
     a. GRAPH ANCHOR    anch = { neighbours(c) ∩ A : c ∈ C } over visible-endpoint edges
                        if anch ≠ ∅ → seedPoint = centroid(anch)
     b. SEMANTIC ANCHOR else: for the 3 highest-degree members of C, call the REAL API
                        querySimilar(vec, k, { index: "quarantine" })
                          vec   = the member's STORED embedding — read it, do not re-embed
                                  (re-embedding would make `tessera view` require an embedder)
                          k     = 25
                          index = "quarantine": every node is inserted there
                                  (graphStore.ts:221). "shared" is sparse, and choosing it
                                  would make this rule silently never fire.
                        keep hits in A, take the single best by cosine.
                        Accept only if cosine ≥ SEMANTIC_FLOOR (calibrated — see below).
                        → seedPoint = that node's position
     c. MAP SEED        else → seedPoint = bbox-centroid of A, displaced by
                        r = 220 + 60*j , θ = j * 2.399963 rad
                        j = the component's index after ordering components by their
                        MINIMUM member rowid. The partition step yields no inherent order,
                        so DFS vs BFS would otherwise produce different r/θ.

   **SEMANTIC_FLOOR is a CALIBRATED PARAMETER, not a number chosen in prose.** Current value
   **0.75**, derived by `scripts/bench/semantic-anchor-floor.ts` against `graphs/big`; re-derive
   it when the corpus or the embedding model changes. Measured best-cosine-to-A for the 6
   components that miss rule (a) — sizes 1,1,1,1,2,31 — is
   0.616 / 0.646 / 0.691 / 0.715 / 0.772 / 0.774:

     | floor | (b) fires | (c) fires        |
     |-------|-----------|------------------|
     | 0.60  | 6         | **0 — dead branch** |
     | 0.70  | 3         | 3                |
     | 0.75  | 2         | 4                |
     | 0.80  | 0         | 6                |

   The distribution has no clean gap, so any absolute floor is a judgement call over one corpus.
   That is precisely why it is a calibrated parameter with a checked-in harness, and why §10
   asserts both branches stay reachable **under the production value on the real graph** — not
   in a fixture that can force the branch.

   Then place every c ∈ C at seedPoint + jitter(c), so the component lands TOGETHER:
     jitter(c) = (ρ cos φ, ρ sin φ),  ρ = 18·√(m+1),  φ = m · 2.399963 rad   [golden angle]
     where m = c's index within C, ordered by rowid. Deterministic; Math.random() forbidden.
     **The jitter MUST yield distinct positions for distinct m — this is a correctness
     requirement, not cosmetics.** Two nodes at exactly the same coordinates never separate:
     with dx = dy = 0 the repulsion is fx = f·dx/d = 0 for any softening value, so the
     `|| 0.01` guard prevents a 0/0 NaN and nothing else. Coincident seeds are welded
     together permanently. Found by mutation-testing the settle port; pinned by
     test/layout-settle.test.ts (coincident case) and the incremental placement tests.
   There is no ring rule. The `Math.cos(i)*220` ring is the FULL-settle seed (§3.2) and has
   no place here — it was what parked newcomers on the periphery.
4. Relax for **500 iterations with §3.2's exact constants** (kRep 5200, kSpring 0.045,
   rest 90, grav 0.012, alpha = max(0.03, 0.992^it), damp 0.82) — the incremental pass must
   not have its own physics, or incremental and full maps diverge:
     - A exerts repulsion and spring force on N, and never moves (one-sided: full force
       applied to the N endpoint, none to the A endpoint)
     - N ↔ N repel and spring each other (else members of one component stack on a point)
     - repulsion population is N×A plus N×N — never A×A (that is what makes the cost linear)
     - springs act on **all visible-endpoint graph edges**, matching what the browser settle
       does (`template.html:211, 251-252`) — not a RELATED-only subset. On `graphs/big` every
       visible-endpoint edge is RELATED today, but `RESONATES_WITH` enters the visible set
       after `connect --commit`, and a RELATED-only rule would silently diverge from the full
       settle at exactly that point.
     - gravity applies to N only; integrate N only
5. putLayoutBatch(positions of N)
```

**`N` must be intersected with the visible set until slice 4.** `nodesLackingLayout()` alone returns every
node without a row — which after slice 1 includes all **211** provenance nodes in `graphs/big` (199 chunks +
12 documents). Unfiltered, the first `ingest` after a `view` would pull them into the force field and write
them positions: slice 4's geometry, delivered in slice 1, with scenes not yet anchored. Provenance nodes are
*deliberately* left without layout rows until slice 4.

Cost is **O(|N|·(|A|+|N|)) per iteration — linear in the existing map**, not quadratic. Adding 30 nodes to a
400-node map is ~30×430 pair-ops per iteration, i.e. free. This is the property that makes the drop target
viable at a scale where a full re-settle is not.

### 3.3.1 Why component-first, and why the earlier node-first ladder was wrong

**Measured on `graphs/big`** (`scripts/bench/seed-fallback-rate.ts`, and the topology check in §10's fixture):
taking the entities exclusive to the most recently ingested document — exactly the drop-a-file case — gives
**N = 28**, of which only **2** have any edge into the existing map, and **all 28 form a single connected
component**. Under a half-split proxy the same "no anchored neighbour" rate is 89.7%; under this faithful one
it is **92.9%**.

That kills two designs, and the second one was mine:

- **A node-first rule that stops at "centroid of anchored neighbours" parks ~93% of every dropped document on
  the fallback** — the exact failure the anchored design exists to prevent.
- **A node-first ladder with a semantic rule ahead of a component rule is worse.** "Nearest node in A by
  cosine" *always* succeeds — `putNode` inserts an embedding for every node (`graphStore.ts:221`) and A is
  non-empty — so the component rule becomes unreachable dead code, and the one coherent 28-node document is
  seeded at **28 different scattered positions**. Trading a peripheral clump for a scatter is not an
  improvement: at least the clump kept the document together.

Hence: **place components, not nodes.** A dropped document is one thing arriving, and it should land in one
place. The semantic rule runs *per component* rather than per node, so it can no longer preempt the map-seed rule by
construction. **A floor alone did not achieve that** — the first floor written here (0.60) sat below the
minimum observed best-cosine-to-A (0.616), so rule (b) still fired for all 6 components and rule (c) was dead
again. Three rewrites, three versions of the same defect: a constant chosen in prose and never measured.
Hence SEMANTIC_FLOOR is now calibrated by a checked-in harness, and §10 asserts branch reachability under the
production value rather than in a fixture that can force the branch.

Correction to the previous draft: `knnNodes` is **private** (`src/store/graphStore.ts:129`). The public vector
API is **`querySimilar`** (`:265`), which is what §3.3(b) calls.

**Acceptance criteria (§10) — ring-rate alone is blind.** A scatter implementation and a cohesive one both
post a ~0% fallback rate, so that metric cannot police the thing that actually matters. The discriminating
criterion is **component cohesion**: after settle, the newcomer component's bounding-box diagonal must be
within 2× the median diagonal of comparable existing clusters, and its centroid must be within 1.5× the seed
radius of `seedPoint`. That fails the scatter and passes the intended placement.

### 3.4 Read path and fallback — ALL-OR-NOTHING

Precedence: **complete stored layout ≻ full fallback settle.** The decision is made once, over the whole
visible set, never per node:

- **every** visible node has a stored position → use them, never call `settle()`;
- **any** visible node is missing one → run the full in-browser `settle()` over the visible set and write
  nothing.

Per-node mixing is **forbidden**. Today's `settle()` moves *every* node it is given (`template.html:240-254`),
so "settle just the missing ones" using the existing function would move every anchored node too — one missing
row would destroy the additive guarantee for the whole map. A browser-side anchored settle matching §3.3 is a
possible future refinement; v1 does not have one, so v1 takes the coarse rule.

Reachable mixed states this covers: an `ingest` that ran before any `view`; a crash between the ingest and the
layout batch; and `scripts/export-viewer.ts:42-46`, a standalone entry point that bypasses `tessera view`
entirely. The in-browser settle is **not** dead code — it is the fallback, and it must stay correct.

### 3.5 Layout must reach the viewer — both paths

`exportViewer()` currently emits `{nodes, edges, name}` (`scripts/export-viewer.ts:35`). Nothing in the bundle
carries positions, so without this section slice 1 would write layout to SQLite that the default `file://` path
could never read — and the geometry-preservation and poisoned-layout tests would be unimplementable for the
path they matter most on.

Both readers get the same shape:

- `exportViewer()` adds `layout: { [nodeId]: [x, y] }` to the bundle, sourced from `getLayout()`, absent-keyed
  for nodes without rows (which §3.4 then reads as "incomplete → fallback").
- `GET /` injects the identical field.
- The viewer runs **§3.4's completeness test first, before applying anything**, and then takes exactly one of
  two branches — never a mixture:
  - **complete** → construct every node at its `GRAPH.layout[id]`, and never call `settle()`;
  - **incomplete** → **ignore `GRAPH.layout` entirely**, construct from §3.2's seed formula, and run the full
    `settle()`.

  Applying stored positions per-node and *then* settling is forbidden and would silently break §3.4: today's
  `settle()` does not re-seed (`template.html:242` zeroes velocities only), so it would start from a
  stored/seeded hybrid and move every anchored node along a trajectory that depends on which rows happened to
  exist. Both reviewers read the previous wording as licensing exactly that.

### 3.6 `tessera view` / `ingest` on a partially-laid-out graph

One rule covers bootstrap, incremental, and every mixed state, so no caller has to decide:

**Always compute `N = nodesLackingLayout() ∩ visible()` and run §3.3 on it.**

- `A = ∅` (nothing laid out yet) → §3.3 degenerates to the full settle: one component containing everything,
  seeded by §3.2's full-graph-index formula. This is the bootstrap path and it is the *only* path that may
  move existing nodes, because there are none.
- `N = ∅` → no work, no writes, no `mutation_log` ops (§3.1's no-op rule).
- otherwise → incremental, and **A never moves**.

A naive "if anything is missing, re-run the full settle" would move all of A and rewrite the geometry F-2
exists to protect. It is not an option at any point after the bootstrap.

### 3.7 What this fixes, quantified

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
- **Framing at restore — the actual equations**, because "centre on the bbox" has several implementations and
  the anchor-survives-re-settle test would pass all of them. The camera is `screen = world*scale + o`
  (`template.html:toScreen`), and `centerOn` is `ox = W/2 - n.x*scale` (`:441`). So:

  ```
  bbox over anchors' CURRENT positions → (minX,minY,maxX,maxY), cx,cy = centre
  bw = max(maxX-minX, ε)   bh = max(maxY-minY, ε)        ε guards the single-anchor case
  fit   = min( W*0.70/bw , H*0.70/bh )                   min over BOTH axes → whole bbox fits
  scale = min( storedScale , fit )                       single anchor (bw=bh=ε) → fit is huge → storedScale
  ox    = W/2 - cx*scale        oy = H/2 - cy*scale
  ```

  Rationale for `min`: honour the user's zoom intent, but if the cluster has spread since the scene was saved,
  zoom out enough that they still see the thing they saved. Pure stored-scale would frame the centre of a
  cluster that no longer fits; pure refit would discard a deliberate close-up.
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
3. mint `id`, preserve `legacy_id`, compute

   ```
   content_key = sha256( name ⧺ "\x00" ⧺ (narr ?? "") ⧺ "\x00" ⧺ sorted(anchors).join(",")
                         ⧺ "\x00" ⧺ scale.toFixed(6) ⧺ "\x00" ⧺ (showProv ? "1" : "0")
                         ⧺ "\x00" ⧺ (focusNode ?? "") )
   ```

   **`focus_node` is in the key** — it is independent of the anchors (§4.2), so two scenes differing only in
   panel selection are *different scenes*. Omitting it lets the unique index silently collapse them and lose
   the selection intent — and the colliding-id test would not catch it (both reviewers found this
   independently). `scale` is serialised at fixed 6 decimals so float formatting can't change the key. Fields
   are NUL-separated so `("ab","c")` and `("a","bc")` cannot collide.
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
GET  /            → template + graph data + layout (§3.5) + scenes (read-only bundle)
POST /ingest      → one .md/.txt → { chunks, entities, edges, laidOut }
GET  /events      → SSE progress
GET  /scenes      → scenes + anchors
PUT  /scenes      → all-or-nothing replace (per-scene `version`; any stale → 409, nothing applied)
```

`laidOut` is **the count returned by `putLayoutBatch`** after the post-ingest settle pass — *not* a new field
on `IngestResult`, which stays as it is (§3.1). Naming it `newNodes` invited exactly the ambiguity a reviewer
flagged: two engineers, two sources of truth, one of them wrong.

`PUT /scenes` is **all-or-nothing**: the server checks every incoming `version` first, and if any is stale it
applies nothing and returns 409 with the list of conflicting scene ids. Partial application would leave the
client's list and the db diverged with no way to tell which half landed. Deferring multi-user does not excuse
an ambiguous single-user contract.

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
- The client-supplied filename is used **only** to test `isSupported()` (`src/ingest/adapters.ts:13-16`) and
  to set the SOURCE title/provenance. It never contributes to a filesystem path.
- **`ingestFile()` therefore is NOT unchanged, and §3.1's "leave `IngestResult` alone" does not extend to its
  inputs.** `readDoc(path)` derives both `source` and `title` from the resolved path
  (`src/ingest/adapters.ts:57-77`), so a drop through an untouched `ingestFile()` would persist the server's
  temp filename as the document's title and provenance forever. `ingestFile` gains an optional
  `opts.display?: {title?: string; source?: string}` passed through to the SOURCE node, defaulting to today's
  behaviour when absent. Content identity is unaffected — it is the content hash, never the path
  (`ingest.ts:42`).
- Content-hash dedup still makes a repeat drop a true no-op (`ingest.ts:48-50`).
- **Single-flight per graph.** A second concurrent `POST /ingest` gets **409**, rather than interleaving LLM
  calls against a serialised SQLite writer.

### 7.4 Progress and completion

```
event: {phase:'chunk', i, of}      per chunk
event: {phase:'done', chunks, entities, edges, laidOut}
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
| upload crash / abort | temp unlinked in `finally` on every **handled** exit path. A `SIGKILL`/power loss cannot run `finally` — so `serve` **also sweeps its temp dir at startup**, unlinking anything older than 1 h. Stated because "unlinked on every exit path including crash" was an impossible guarantee. |
| concurrent ingest via `serve` | 409, single-flight |
| `tessera ingest` (CLI) run while `serve` is ingesting | **not covered by the HTTP single-flight** — two processes, one SQLite writer. `serve` takes an advisory lock file in the graph dir on ingest; the CLI refuses with a clear message if held, and vice versa. |
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
  **The reference must be the real template algorithm — full-graph seed indices, visible-set forces (§3.2).**
  If the port and the reference both seed over the visible list, the test passes green while every scene
  breaks; a shared wrong assumption is invisible to a self-consistent test.
- **(wiring) Layout reaches the `file://` bundle:** `tessera view` on a laid-out graph emits HTML whose
  `GRAPH.layout` is populated, and the rendered positions equal the stored ones (§3.5).
- **Mixed-layout is all-or-nothing — assert the OUTPUT, not that settle ran.** Delete one visible node's layout
  row, then assert the rendered positions are **bit-identical to a pure-seed full settle** of the same graph.
  Asserting only "settle ran" and "not half-stored" passes while the implementation pre-applies the 386 stored
  positions, seeds the 1 missing, and settles from that hybrid — the exact forbidden trajectory, since
  `settle()` never re-seeds (`template.html:242`). Comparing against the pure-seed result is the only assertion
  that can tell the two apart.
- **Provenance stays unlaid until slice 4:** after `view` + `ingest`, assert zero `layout` rows for
  `SOURCE/chunk` and `SOURCE/document` nodes — the test that fails if `N` loses its `∩ visible()`.
- **(wiring) Additive settle through the real path:** `tessera ingest` on a laid-out graph → every
  pre-existing node's stored position byte-identical. Must exercise CLI → `putLayoutBatch`, not a free function.
- **`putLayout` no-ops:** a second `tessera view` with no graph change appends **zero** `mutation_log` ops.
> **§10 COHESION CRITERION IS DISPROVEN BY MEASUREMENT — see `scripts/bench/cohesion-metric.mts`.**
> Running the implemented pass shows the bbox-diagonal criterion below does not measure cohesion; it is
> inverted at realistic sizes (cohesive span 513 vs scattered 351 at size 12; 704 vs 357 at size 28). Two
> further candidates — nearest-neighbour purity and intra/inter distance ratio — fail the same way. A test
> built on any of them would reject good placements and accept scatters.
> The cause appears structural: 500 relax iterations with gravity and springs converge to an equilibrium
> largely independent of the seed, even for a component with no edge into the anchored field where the seed
> is supposed to be load-bearing. If that holds, the seeding ladder matters far less above small sizes than
> rounds 3–5 assumed, and this criterion needs rethinking rather than retuning.
> `test/layout-pass.test.ts` carries a deliberately skipped test recording the numbers. **Open for review.**

- **Placement acceptance — COMPONENT COHESION, against a pinned fixture** *(superseded — see the box above)*. The dominant real case (§3.3.1) is
  a single newcomer component of ~28 nodes with 2 links into the map, so a test covering only the
  "≥1 anchored neighbour" node tests ~7% of reality. Assert, on a **checked-in fixture graph** (not "a real
  corpus" — a corpus-dependent threshold lets two runs both claim correctness):
  - the newcomer component's post-settle bbox diagonal is within **2×** the median diagonal of comparable
    existing clusters — **this is the assertion that fails a scatter implementation**;
  - its centroid is within **1.5×** the seed radius of the `seedPoint` §3.3 chose;
  - **branch reachability under the PRODUCTION constants, on `graphs/big`** — not on a fixture. Assert that
    rules (a), (b) and (c) each fire for at least one component with `SEMANTIC_FLOOR` and `k` at their shipped
    values. A hand-built fixture can always force (c) by mocking an empty A; that test would have gone green
    while the shipped floor made (c) unreachable, which is exactly the defect that survived two rewrites.
  - **`seedPoint` proximity is asserted per rule, since only (c) defines a radius:** for (a) and (b) the
    component centroid must land within `2 × jitterRadius(|C|)` of `seedPoint`, where
    `jitterRadius(n) = 18·√n`; for (c) the existing `1.5 × r` bound applies. The previous single
    "1.5× the seed radius" assertion was undefined for the two rules that actually fire on the drop-file case.
  - "comparable existing clusters" means: connected components of the visible graph with size within ±50% of
    `|C|`. Undefined before; two implementers would have measured different medians.

  A fallback-*rate* metric cannot police this: a scatter and a cohesive placement both score ~0%. That was the
  hole in the previous draft's acceptance target.
- **Ordering invariant:** `allNodes()` returns `ORDER BY rowid` and the port consumes the same order.
- **Writer invariant:** `connect --commit` adds no nodes, so `nodesLackingLayout()` stays complete.
- **Scene anchoring survives a re-settle:** save → force a full re-settle (via a deliberate test-only escape
  hatch; no product path triggers one) → restore → the same nodes are in frame.
- **(wiring) Migration crosses the door:** a real localStorage payload including `name`, `narr`, and **two
  scenes with colliding `performance.now()` ids** → export → import → both present, lossless, idempotent on a
  second run.
- **`content_key` separates what differs:** two scenes identical except for `focus_node` import as **two**
  rows; two panel-saves of the same node with empty `narr` collapse to one. The colliding-id test above does
  not cover this — it was the failure both round-3 reviewers found independently.
- **Server:** `Host` mismatch rejected on **every** route including `GET /`; foreign `Origin` rejected on
  mutating routes; navigation with `Sec-Fetch-Site: none` **accepted**; oversized body rejected; unsupported
  extension rejected; repeat drop of identical bytes writes nothing; concurrent double-POST → 409.
- **(wiring) The served page's own `EventSource` connects and receives events during a real ingest.** The
  outline's earlier "rejects missing `Origin` on `/events`" test would have passed *while enforcing the bug*.
- **Benchmark harnesses are checked in** at `scripts/bench/` (settle cost, ingest latency, header probe, seed
  fallback rate) with a README recording the results of record. Every number this document asserts is
  reproducible from repo state rather than from a local run nobody else can repeat.

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
`ingest`/`view`; viewer reads it via the §3.4 all-or-nothing branch, keeps the fallback. **`exportViewer()` gains the `layout` field (§3.5)** — slice 1 DOES change the `file://` export, and an earlier draft's "export unchanged" silently revoked its own fix, since §11 governs. The export stays a working offline artifact; only the bundle grows. **Ships with:**
geometry-preservation test, poisoned-layout wiring test, additive-settle test, no-op test, **component-cohesion
test, branch-reachability-under-production-constants test, mixed-layout all-or-nothing test, layout-reaches-the-
bundle test, provenance-stays-unlaid test.** The last five were in §10 but absent from this list in an earlier
draft — and since §11 governs, the only tests that can police scatter and hybrid-start would have sat outside
the governing checklist. Same class as the "export unchanged" revocation, quieter.

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

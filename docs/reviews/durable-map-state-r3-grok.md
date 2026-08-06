# Round 3 review — durable map state + tessera serve (FULL design write-up)

**Reviewer:** Grok 4.5 (`cursor-grok-4.5-medium`) via Cursor · **Date:** 2026-08-06
**Reviewed:** `docs/durable-map-state-design.md` · unsteered (dimensions only, no file paths)

---

## Verdict

**Not ready to implement.** The write-up fixed the round-1/2 criticals and the measured header/latency decisions are sound, but §3 still has a geometry-falsehood that would burn the migration window the whole plan is built to protect, plus several contracts an implementer would have to invent.

---

## CONFIRMED (verified against code / live `graphs/big`)

### 1. CRITICAL — §3.2 seed index is wrong; “verbatim” port as written remaps the graph

Browser seeding is over the **full** `GRAPH.nodes` array (including provenance), then `rebuild()` settles only the visible subset:

```198:215:viewer/template.html
const nodes = GRAPH.nodes.map((n,i)=>({ ...n,
  x: Math.cos(i)*220 + (i%7-3)*30, y: Math.sin(i)*220 + (i%5-2)*30, vx:0, vy:0, deg:0 }));
// ...
function rebuild(){
  const vis = new Set(nodes.filter(n=>showProv||!isProv(n)));
  NODES = [...vis];
  // ...
  settle();
```

§3.2 states the seed formula, then “**Population is the visible set**,” and that ordering is `allNodes()` / `ORDER BY rowid`. A competent reading is: filter visible, seed with `i` in that list, settle. On `graphs/big` that matches the browser’s seeds for **0 / 387** visible nodes.

**Failure:** slice 1 “geometry-preserving” settle writes a different map; every pre-slice-2 localStorage scene’s `ox/oy/scale` frames the wrong region; export (§5) then binds anchors to the wrong nodes permanently — recreating round 2’s F1 door under a new mechanism.

**Fix the spec must say:** assign seeds using each node’s index in the **full** `ORDER BY rowid` list (provenance included); run forces only on the visible set; do not reindex after filtering.

Note: `SELECT * FROM nodes` on `graphs/big` *does* match `ORDER BY rowid` today (598/598). The design’s “de facto rowid” claim holds for `allNodes()`’s actual SQL; making `ORDER BY rowid` explicit is fine. The seed-population bug is separate and worse.

---

### 2. CRITICAL — §3.3 vs §3.2: provenance / `nodesLackingLayout()` contradiction

§3.2: slices 1–3 use the **visible set**; slice 4 adds provenance.  
§3.3: `N = nodesLackingLayout()` with **no provenance filter**.

After `tessera view` lays out 387 visible nodes, **211** provenance nodes (`199` chunks + `12` docs) remain lacking layout. Next `ingest` / incremental settle then pulls those 211 into `N`, where they repel/spring against newcomers and get written into `layout` — i.e. slice 4 geometry in slice 1.

**Failure:** first post-view ingest changes newcomer placement vs visible-only settle; provenance gains stored positions early; `h` + “skip settle when layout exists” diverges further from today’s toggle re-settle.

§3.3 must filter `N` (and spring/repulsion population) the same way `rebuild()` does until slice 4.

---

### 3. HIGH — Driving use case: centroid seeding almost never fires

§3.3 seeds at `centroid(neighbours(n) ∩ A)`, else ring. New doc entities mostly link to **each other and their new chunk** (also in `N`), not into `A`.

Proxy on `graphs/big` (first half of visible nodes as `A`, second half as `N`): **174 / 194 (89.7%)** would take the ring fallback.

**Failure:** drop-file newcomers park as a peripheral clump — the failure mode D1 claimed to fix — while the placement test only covers the uncommon “≥1 anchored neighbour” case.

Spec needs a real rule for `nbrs ∩ A = ∅` clusters (e.g. seed the new component near map centroid / bbox, or soft-anchor via embedding), not only ring-at-next-index.

---

### 4. HIGH — `file://` / `exportViewer` never told to carry layout

`tessera view` is still `exportViewer` → static HTML (`scripts/cli.ts:109-112`, `export-viewer.ts:15-38`). Bundle today has nodes/edges/name only.  
§7.1 says `GET /` includes layout; §8’s poisoned-layout test assumes the viewer can see stored coordinates. **No section specifies** how `exportViewer` embeds `layout` into `GRAPH` (or equivalent) for the quine path.

**Failure:** slice 1 CLI writes SQLite layout; `file://` viewer never sees it → always fallback-settles → geometry preservation and poisoned-layout wiring tests are unimplementable as stated for the default UX path.

---

### 5. HIGH — §3.4 mixed layout is undefined and unsafe with current `settle()`

Precedence is “stored ≻ fallback settle,” phrased per-node (“when **a** node has no stored position”). Current `settle()` moves **every** visible node. Partial layout (ingest before view; crash; standalone export) + “run settle for missing” would move anchored nodes.

**Failure:** one missing row destroys the additive guarantee. Spec must say **all-or-nothing** (any missing visible → full fallback settle; else never call `settle()`), or define a browser-side anchored incremental settle matching §3.3.

---

### 6. HIGH — §5 `content_key` drops `focus_node` (and invites silent merge)

```text
content_key = sha256(name ⧺ narr ⧺ sorted(anchors) ⧺ scale ⧺ show_prov)
```

`focus_node` is explicitly independent of anchors (§4.2). Two scenes that differ only in panel selection share a key → second import no-ops → selection lost. Same for two panel saves of the same node/view (`saveScene(n.label)` at `:527`) with empty `narr`.

Colliding-`id` test (§10) does not catch this. Float `scale` serialization for the hash is also unspecified.

---

### 7. MEDIUM — §4.2 framing math not implementable to one answer

“Centre on bbox centre; `scale = min(stored, fit)` where fit ≈ 70% of viewport” never maps to `ox`/`oy`/`scale` as the camera actually works (`toScreen`: `x*scale+ox`, `centerOn`: `ox=W/2-n.x*scale` at `:441`). Fit axis (min vs max), padding, and the `ox`/`oy` equations are missing. Two engineers will ship different restore behaviour; the “anchor survives re-settle” test can pass both.

---

### 8. MEDIUM — §3.3 under-specified knobs

Undefined: jitter formula; “next ring index”; which edge kinds count as `neighbours` / springs; whether repulsion is all-pairs over `A∪N` or only `N`×`A` plus `N`×`N` (cost text says the latter). Springs to provenance if those nodes are wrongly in `N` amplify finding 2.

---

### 9. MEDIUM — `PUT /scenes` conflict semantics

“Replace list (per-scene `version`; stale → 409)” — entire PUT aborted? partial apply? client retry shape? Two tabs editing different scenes still need a defined merge. Deferred multi-user doesn’t excuse an ambiguous single-user contract.

---

### 10. LOW (citation) — `connect.ts:64`

Store is opened ~`:66`; edge writes are `connector.ts` `putEdge` on commit. Claim “writes edges today” is true; line pin is soft. Not load-bearing.

---

### Verified ground that holds

| Claim | Result |
|---|---|
| Settle constants / 500 iters / damp 0.82 (`:240-254`) | ✓ |
| Visible-set rebuild (`:209-215`); `h` re-settle (`:580`); no re-seed (`:242`) | ✓ |
| Scene id / `delScene` (`:589`, `:595`); panel save (`:527`) | ✓ |
| `layout` DDL + Resonator `putLayout` (`ddl.ts:55-62`, spec `:33,64`) | ✓ |
| `allNodes` = `SELECT * FROM nodes` (`graphStore.ts:479-480`); equals `ORDER BY rowid` on `graphs/big` | ✓ |
| `export-viewer.ts:42-46` standalone; `:35` `<` escape | ✓ |
| `IngestResult` counts-only; content-hash skip (`ingest.ts:17-27,48-50`); `markExtracted` `:108` | ✓ |
| `isSupported` allowlist (`adapters.ts:13-16`) | ✓ |
| No `DELETE FROM nodes` / no HTTP listener in `src/`/`scripts/` | ✓ |
| `graphs/big`: 598/1316, 387 vis / 416 e, 199 chunks, 12 docs, 0 layout, 2354 mut | ✓ |
| vitest-only, no jsdom yet (`package.json`) | ✓ |
| `mutation_log` gap + ACCEPTED-RISK in backlog | ✓ |
| §7.2 header table: cannot re-verify browsers here; prior measurement + Fetch-shaped rules look coherent | accepted as prior art |

Settle timings and 9.9 s/chunk: not re-measured; scaling arithmetic is consistent with round 2.

---

## HYPOTHESES (plausible, not fully verified)

1. **CLI `ingest` concurrent with `serve` ingest** — single-flight is per HTTP server only; two processes can still interleave LLM work against one SQLite writer. Worth a stated rule (serve lock file / busy → fail).
2. **`Host` allowlist vs IPv6 / `localhost` oddities** — measured for `127.0.0.1:7777`; `[::1]` and missing-port forms need an explicit reject/accept list.
3. **Geometry test vs shared wrong port** — if TS port and “browser” reference both seed on the visible list, the preservation test passes while scenes break. Reference must be the real template algorithm (full-graph `i`).
4. **jsdom poisoned-layout test** still needs a defined layout field on the injected graph (depends on finding 4).

---

## Implementability

Could not build correctly from this doc alone. Blocking holes: seed index (1), provenance in `N` (2), export bundle layout (4), mixed-layout policy (5), empty-`nbrs∩A` placement (3), framing equations (7), `content_key` (6).

Sound as written: F-1–F-6, §5/§6 migration politics, §7.2 header rule (given measurement), §7.3 upload bounds, §7.5 queue deferral, §9 table shape, §11 ordering intent, several wiring tests (poisoned layout *idea*, EventSource-connects, no-op `mutation_log`).

---

## Attack extras (beyond above)

- **Security:** §7.2 is the right shape for the stated threat model; forging `Sec-Fetch-Site` from curl is expected; tests must send those headers. Don’t weaken `Host` on `GET /`.
- **Durability:** batch txn + chunk memo story is good; temp `finally` unlink is good; “SSE reconnect self-heals progress” doesn’t restore *which* ingest is running after restart — client reload-on-done assumes the POST still exists.
- **Tests:** additive-settle-through-CLI and poisoned-layout are real wiring tests **if** layout reaches the viewer. Placement test misses the dominant ring path (3). `content_key` needs a distinct-`focus_node` / duplicate-panel-save case. Geometry test must pin full-graph seeding.

---

## Ready to implement?

**No.** Fix findings 1–2 in §3 before any slice 1 code (they re-open the geometry door round 2 closed). Then close 3–6 in the write-up so an implementer isn’t guessing. After that, slice 1 is fundable; §7 is in better shape than §3.

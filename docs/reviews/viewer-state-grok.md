# Round 1 review — durable map state + tessera serve (outline v1)

**Reviewer:** Grok 4.5 (`cursor-grok-4.5-medium`) via Cursor · **Date:** 2026-08-05
**Reviewed:** `docs/viewer-state-and-serve-outline.md` v1 · unsteered (dimensions only, no file paths)

---

## Verdict

The ground-truth inventory in §2 is mostly solid and the one-way-door instinct in D5 is right. The outline is **not ready to implement as written**: the migration story cannot work as sketched, D2 conflicts with the stated build order, and the API surface claims an `ingestFile()` that does not return what `/ingest` needs. Fix those before investing the full write-up.

---

## Part 1 — Verification of §2

### CONFIRMED (matches code / `graphs/big`)

| Claim | Evidence |
|---|---|
| Quine-bundle export inlines graph JSON into template | `scripts/export-viewer.ts:35-38` |
| No `createServer` / `node:http` / `listen(` in `src/` or `scripts/` | Grep empty |
| Three runtime deps | `package.json:15-18` |
| `settle()` = 500× O(n²), seeded at map init, called from `rebuild()`, including `h` toggle | `viewer/template.html:198-199, 208-215, 240-254, 580, 633` |
| `layout` DDL exists, 0 rows, no read/write API | `src/db/ddl.ts:55-62`; no `FROM/INTO layout` in `src/`; `graphs/big` layout count = 0 |
| Scenes in `localStorage` as camera coords + `showProv` + `node` | `viewer/template.html:584-590, 594` |
| `narr` edited in tour UI and persisted | `viewer/template.html:627-628` |
| WAL + `BEGIN IMMEDIATE` via `.immediate()` + `mutation_log` | `graphStore.ts:116, 155-238, 553-559` |
| `graphs/big`: **2354** mutation_log rows, **12** docs, **199** chunks, **387** non-prov / **598** total nodes | Queried read-only |
| ~32 semantic nodes/doc | 387/12 = 32.25 |
| Ingest loop is serial per chunk; default chunk ~1500 chars | `ingest.ts:69-109`; `chunker.ts:12` |
| Nodes are never deleted today | No `DELETE FROM nodes` / delete API in `src/` |
| Gap thesis (deterministic seed + fixed set ⇒ scenes work by accident) | Mechanically correct given seed + full re-settle |

### CONFIRMED wrong / overstated

1. **“No HTTP anywhere in the repo… tessera has never opened a socket.”** (§2 bullet 2)  
   False as stated. Outbound HTTP already exists: `fetch` to Ollama in `src/llm.ts:20` and `src/embedder.ts:85`. What is true: **no inbound server socket**. The headline oversells the novelty of “first network surface” — serve is the first *listener*, not the first HTTP.

2. **Scene shape lists `narr` as if `saveScene` writes it.** (§2, cites `:584-590`)  
   `saveScene` writes `{id, name, ox, oy, scale, showProv, node}` only (`:589`). `narr` appears later via tour textarea (`:627-628`). Shape-in-storage after narration is edited is accurate; the citation implies it is part of the save record.

3. **`narr` citation `:626`.**  
   Line 626 is the stop title; narration is `:627-628`. Stale line ref.

4. **“`narr` is the only human-authored prose.”** (§2)  
   Overstated. Scene **names** are also human-authored (`saveScene` / input at `:588-603`). Migration must preserve names too (test plan mentions `narr` but not names explicitly — names would survive a naive JSON copy, but the “only prose” framing is wrong).

5. **Benchmark “edge:node ratio 2.2 matching `graphs/big`” for the 387-node row.**  
   Total graph: 1316/598 ≈ **2.20**. Default visible settle (what “today” means): **416/387 ≈ 1.07**. The 598 row matches 2.2; the 387 row and the synthetic ladder are denser than the default-view graph. Because cost is dominated by O(n²) repulsion, this probably does **not** overturn the “tens of seconds at 4k” conclusion — but the table’s methodology note is inaccurate.

### Unverified (left as author measurements)

Settle timings (0.26s … 23.8s) — no checked-in benchmark harness; plausible, not re-run here.

---

## Part 2 — Design attack (ranked)

### CONFIRMED findings

**1. Critical — D5’s migration cannot write the `scenes` table from `file://`.**  
D5 correctly identifies origin-scoped localStorage as a one-way door, then requires the import path to “land and be exercised while the viewer is still on `file://`.” The viewer is static HTML with no Node bridge (`export-viewer.ts` / `template.html`). There is **no channel** from `file://` JS to SQLite. Once `serve` is up, you are already on `http://127.0.0.1:PORT` — a different origin — and cannot read the old localStorage.

Failure scenario: ship serve → open `http://127.0.0.1:7777` → scenes/narration appear empty → old `file://…/view.html` still has them but nothing syncs them into `scenes`.

What the outline needs and lacks: an explicit **two-artifact** bridge, e.g. (a) on `file://`, “Download scenes.json” (anchors computed client-side), then (b) on `serve`, import that file into the db — or a CLI `tessera scenes import`. “Migration before origin change” is right; “db write before origin change” is impossible without a new tool.

**2. Critical — §1 order vs D2 are incompatible.**  
§1: layout persistence → scenes → serve.  
D2: “The **server** writes layout; the viewer only reads.”

Today settle lives only in browser JS (`template.html:240`). Under D2 there is no writer until serve exists, so step 1 cannot land. Also `tessera ingest` (`scripts/cli.ts:83-105`) will keep adding nodes with **no layout rows** unless CLI shares the settle writer.

Failure scenario: implement D1/D2 as written → CLI ingest 3 docs → `GET /` injects graph with null layout for new nodes → viewer has nothing to draw or must violate D2 and settle locally without persistence.

**3. High — Surface vs D8 API contradiction.**  
§4: `POST /ingest → … { entities, edges, newNodeIds }`.  
D8: “call `ingestFile()` unchanged.”  
`IngestResult` (`ingest.ts:17-27`) has no `newNodeIds` (nor per-node ids at all). Incremental settle needs exactly that set (or a layout-diff query). Something must change: return value, a post-pass `nodes lacking layout`, or D8 is false.

**4. High — D7’s port-pinning rationale contradicts D4.**  
D4 moves scenes to SQLite. D7: “pin the default port so **scenes don’t vanish** between runs.” After D4, port changes do not drop scenes; only localStorage did. Pinning may still be good UX, but the durability argument is leftover from the pre-D4 world and will mis-prioritize review.

**5. High — D3’s “half-built hook” overclaims `node`.**  
`node` restores panel selection (`restoreScene` `:592-593`), not framing. Camera is pure `ox/oy/scale` (`:594`). Anchors are a **new** semantic, not finishing an existing camera hook. Also unspecified: how many anchors, pick rule (all in view? top-k by degree? selected neighborhood?), empty selection, single-node scenes (today’s “Save as scene” from a node — `:527`).

**6. High — Initial / CLI / missing-layout path absent.**  
`layout` is empty on every existing graph. Outline never says who runs the first full settle (serve startup? first `GET /`? one-shot CLI?). Combined with (2), cold start and non-serve ingest are undefined.

**7. High — Security: Origin check is underspecified for the threat D7 names.**  
Loopback + Origin is the right *class* of mitigation. Gaps vs code you will write:

- **Reject missing `Origin` on mutating routes.** Browsers send Origin on POST; `curl`/local scripts omit it. “Check Origin” that only compares when present = CSRF-proof browsers, open to any local process — maybe acceptable for v1, but say so.
- Apply the same gate to **`PUT /scenes` and `POST /ingest`**, not only ingest; §6 only dramatizes uploads.
- **`GET /events`**: cross-origin `EventSource` can leak chunk progress even if POST is blocked, unless Origin is checked there too.
- CORS headers alone are insufficient (simple form POSTs still hit the server); server-side reject is mandatory — D7 implies this, good; spell it as deny-by-default.

DNS-rebinding: Origin of the attacker site ≠ server origin → reject works **if** missing-Origin is denied for mutations. That caveat belongs in §6.

**8. Medium — Reclaiming `layout` collides with the longer-term Store/Resonator contract.**  
Spec (`docs/specs/graph-store-spec-v2.md:33,64`) and schema docs say `layout` is Resonator/`putLayout` + tile/`zoom_min` for pyramid. D1 stuffs force-directed x/y into that table with no `putLayout`, no `mutation_log` op, no version discipline called out. Fine for tracer pragmatism, but the outline should admit it is **repurposing a reserved seam**, not “turning on a dead table as designed.” Also name collision: `nodes.pinned` already exists (`ddl.ts:25`) vs D1’s “pinned field.”

**9. Medium — `h` toggle + single layout is load-bearing and under-designed for v1.**  
Today `rebuild()` **re-settles the whole visible set** (`:215`), so toggling provenance already moves the map. D1 freezes positions; provenance nodes (199 chunks + 12 docs) have no rows. §7 asks “one layout or two?” — for v1 scope that includes layout persistence + drop target, this is not optional. If one layout: when are chunk positions computed (eager on ingest = large settle; lazy on first `h` = surprise jank + possible drift of semantic nodes if not truly pinned in the algorithm)?

**10. Medium — Incremental settle algorithm unspecified (failure mode under D1).**  
“Held fixed; only new nodes relaxed” needs: do fixed nodes exert repulsion/springs? (They must, or new nodes ignore structure.) Are new nodes seeded near neighbors or on the ring (`:199`)? Ring seeding at large `i` places newcomers far out — pinned field then pulls via springs only along edges; disconnected new entities park on the periphery forever. No acceptance criterion for “good enough” placement.

**11. Medium — Test plan will green-light unwired behavior.** (§8)

| Test | Gap |
|---|---|
| Layout round-trip | Doesn’t prove serve injects layout into `GET /` or that CLI ingest writes it |
| Additive settle | Strong for D1 **if** it runs through the real ingest→layout writer path; weak if it unit-tests a free function |
| Scene anchoring + “force full re-settle” | No product path to full re-settle under D1; need a test-only or admin escape |
| Migration | Doesn’t test the **origin/door** (export on `file://` → import on http); “run twice idempotent” can pass on a helper that never touches localStorage |
| Server Origin / size / extension / hash no-op | Good; missing: **SSE emits during a real ingest**, concurrent double-POST, missing-Origin policy, `PUT /scenes` Origin |

**12. Low — “20-page drop = 40–60 serial LLM calls”** is unanchored; §7 correctly marks latency unknown. Don’t let that estimate drive D9 vs job queue until measured — the outline already says this; keep it gate-shaped.

**13. Low — Scope: v1 is large.** Layout writer + migrate + re-anchor + http server + upload + SSE + Origin hardening is several failure domains. Given (1)–(3), a tighter v1 is: (A) layout+CLI settle writer + re-export still `file://`, (B) scenes download/import bridge, (C) serve+drop. Shipping C before A/B loses narration.

### HYPOTHESES (plausible, not fully verified)

- **H1.** Whole-list `PUT /scenes` + two browser tabs → last writer wins; narration loss. Likely for a local tool; unmentioned.
- **H2.** Concurrent `POST /ingest` interleaves chunk LLM calls while SQLite serializes writes → confusing SSE and partial graphs. Single-flight lock probably required.
- **H3.** Temp-file upload + crash mid-ingest → orphan temps; need `finally` unlink (D8 gestures, no cleanup requirement).
- **H4.** Anchor restore with stored `scale` after spatial expansion of a cluster → nodes “in frame” but tiny/huge; §6.3 flags centroid vs bbox — scale policy still missing.
- **H5.** Content-hash no-op is true for identical bytes (`ingest.ts:48-50`); renamed/moved path with same bytes skips — good. Edited one character re-extracts and may reinforce entities without new node ids → incremental settle no-ops while user expects map change — product surprise.
- **H6.** Settle timings at 4k may be optimistic or pessimistic by machine; argument direction (pre-paint stall is real) still holds.

---

## What is genuinely sound

- **Problem framing:** scenes working by accident under a fixed node set is the right diagnosis.
- **D1 direction:** durable positions + additive settle matches the drop-file use case; killing sync full settle on every load is justified by the 387/598 measurements even if the edge-ratio footnote is sloppy.
- **D4 over `meta.json`:** `graph.ts:30-31` is create-once sidecar; mutable scenes do not belong there.
- **D8 allowlist / size cap / no client path as path:** matches `isSupported()` (`adapters.ts:13-16`) and content-hash skip — right threat model for the upload body.
- **§6 risks 1–3:** asking for attack on trust boundary, pinned-field decay, and anchor semantics is the correct review posture; don’t drop them in the full write-up.
- **Keeping static export** (§7) — don’t delete `tessera view` / quine path.

---

## What to force in the full write-up before code

1. Concrete migration sequence that does **not** require SQLite writes from `file://`.  
2. Who settles (CLI + serve), and retire “server-only writer” or move layout after serve in §1.  
3. How `newNodeIds` / missing-layout set is obtained without pretending `ingestFile` is unchanged.  
4. Anchor selection + restore math; missing-Origin policy; first-layout bootstrap; provenance layout choice for v1.  
5. Tests that fail if serve never calls settle, if SSE is a stub, or if migration never crosses the origin door.

I did not modify any files; graph stats were read-only queries against `graphs/big/graph.db`.

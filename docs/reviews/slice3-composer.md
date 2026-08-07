# Slice-3 review — tessera serve + drop target

**Reviewer:** Composer 2.5 (`composer-2.5`) via Cursor · **Date:** 2026-08-06

---

# Slice 3 review — `tessera serve` + drop target

Independent review against `slice3.diff`, design §7, prior rounds, and the live tree. No files were modified.

---

## Verdict

**Safe to run on a developer machine against the stated threat model (hostile web pages in a modern browser), with important caveats.** Loopback binding, per-route `Host` validation, and measured `Sec-Fetch-Site` / `Origin` rules block the main browser attacks (DNS rebinding, cross-site CSRF). That is real work, not theatre.

It is **not** safe to treat as authenticated or multi-process-safe: local processes can ingest without browser headers (by design), the advisory lock is one-sided, single-flight has a TOCTOU race, and several correctness bugs will corrupt provenance or mislead the user. Do not run `tessera serve` on a graph you are simultaneously ingesting via CLI.

---

## 1. Security (most severe first)

### CONFIRMED — Cross-process SQLite corruption; design §9 unimplemented on CLI side

Design §9 (`docs/durable-map-state-design.md:480`) requires mutual advisory locking between `serve` and CLI `ingest`. Only `scripts/serve.ts:21-29` implements `takeLock`; `scripts/cli.ts` never checks `.ingest.lock`.

**Scenario:** `tessera serve big` is running. User runs `tessera ingest big notes.md` in another terminal. Both open `graphs/big/graph.db` through `Graph.open` (`scripts/serve.ts:45`, `scripts/cli.ts:88`). SQLite serializes writers, but you get interleaved transactions, partial manifests, and confusing failures — not a clean 409.

Worse: the lock is taken at **serve startup** (`scripts/serve.ts:33`) and held until shutdown (`scripts/serve.ts:96`), not only during ingest. CLI ingest is blocked for the entire serve session even when idle — stricter than the design text and still not reciprocal.

### CONFIRMED — Single-flight TOCTOU: concurrent POSTs can both ingest

```180:200:src/serve/server.ts
        if (path === "/ingest" && req.method === "POST") {
          if (ingesting) return send(res, 409, "an ingest is already running");
          // ...
          const body = await readBody(req, MAX_UPLOAD_BYTES).catch(/*...*/);
          // ...
          ingesting = true;
```

`ingesting` is checked at line 181, but set at line 200 **after** `await readBody`. Two same-origin POSTs can both pass the check, both read bodies, both set `ingesting = true`, and both run `deps.ingest`. The test at `test/serve-server.test.ts:153-163` delays *inside* the mock ingest; it never overlaps the gap before `ingesting = true`.

**Scenario:** User drops two files quickly, or a page fires two `fetch('/ingest')` calls. Both can invoke the LLM pipeline against one graph. That violates §7.3 single-flight and can wedge SQLite / progress streams.

### CONFIRMED — `localhost` / IPv6 Host allowed, but `expectedOrigin` is always `127.0.0.1`

```93:93:src/serve/server.ts
  const expectedOrigin = `http://127.0.0.1:${port}`;
```

```35:37:src/serve/guard.ts
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}
```

**Scenario:** User opens `http://localhost:7777/`. Navigation succeeds (`Sec-Fetch-Site: none`, Host OK). Drop handler POSTs with `Origin: http://localhost:7777` → guard rejects as foreign Origin (`src/serve/guard.ts:54-55`). Drop is broken; no test covers this.

Same class for `http://[::1]:PORT/` if the browser sends a mismatched Origin.

### CONFIRMED (by design) — Non-browser clients bypass `Sec-Fetch-*` and can ingest

```70:76:src/serve/guard.ts
  // API routes: ... A non-browser client sends no Sec-Fetch-* at all and is allowed through
  if (input.secFetchSite !== undefined && input.secFetchSite !== "same-origin") {
    return deny(403, ...);
  }
  return OK;
```

Any local process can `curl -X POST http://127.0.0.1:7777/ingest` with valid Host, no Origin, no Sec-Fetch, and trigger LLM extraction + DB writes. Threat model F-4 explicitly accepts this. **Not a bug; do not mistake it for browser-grade protection.**

### CONFIRMED — DNS rebinding against browser pages is blocked

Guard runs on every routed path before handlers (`src/serve/server.ts:123-137`). `Host` must be loopback forms (`src/serve/guard.ts:49-50`). Tests use raw sockets, not `fetch`, for evil Host (`test/serve-server.test.ts:16-29`, `80-90`) — the right fix for the silent Host override problem.

**Scenario:** `evil.com` DNS-rebound to `127.0.0.1`, browser sends `Host: evil.com:7777`, no Origin, `Sec-Fetch-Site: none` on navigation → **403**. This closes the round-2 whole-graph exfiltration path.

### CONFIRMED — Cross-site browser CSRF on mutating routes is blocked (modern browsers)

POST with `Sec-Fetch-Site: cross-site` → 403 (`test/serve-server.test.ts:99-101`). Supplemental rule catches browser-shaped requests with Sec-Fetch but no Origin (`src/serve/server.ts:141-142`). `Origin: null` (sandboxed iframe, some `file://` attempts) → 403 (`src/serve/guard.ts:57-59`).

### CONFIRMED — Path traversal via client filename does not escape temp dir

Server generates `join(temp, 'tessera-upload-${uuid}${ext}')` (`src/serve/server.ts:198-199`). Client filename is extension + display title only (`src/serve/server.ts:187-188`). Test confirms (`test/serve-server.test.ts:125-134`).

### CONFIRMED — Upload size bounded

4 MB cap on declared `Content-Length` and streaming read (`src/serve/server.ts:12`, `182-183`, `73-88`). Test covers oversized body (`test/serve-server.test.ts:115-118`).

### HYPOTHESIS — SSE connection exhaustion

`/events` adds every connection to an unbounded `Set` (`src/serve/server.ts:100`, `175`). No cap, no idle timeout. A same-origin page (or local client forging headers) could open many long-lived SSE connections. Loopback-only limits practical impact; still a local DoS vector.

### HYPOTHESIS — `GET /` hammers `exportViewer` per request

Every navigation calls `deps.renderPage()` → `exportViewer` + full graph read (`scripts/serve.ts:39-40`). Same-origin attacker or runaway tab could CPU/IO spike. Bounded by 4 MB upload cap's cousin — graph size — not request count.

### HYPOTHESIS — Request smuggling / method confusion

Only exact pathnames in `ROUTES` (`src/serve/server.ts:44-49`). `/ingest/` → 404. No `OPTIONS` handler (preflight not needed for same-origin simple POST). Node's `http` parser is the smuggling surface; nothing in this slice makes it worse than a minimal server. Low concern.

### Routes that do **not** escape the guard

All of `/`, `/ingest`, `/events`, `/scenes` go through `guard()` first. Unknown paths 404 before guard (`src/serve/server.ts:124`) — no leak, but also no guard on junk paths (irrelevant for threat model).

---

## 2. Correctness and failure modes

### CONFIRMED — `display.source` not passed; temp path stored as provenance

Design §7.3 requires `display?: {title?, source?}` (`docs/durable-map-state-design.md:430-432`). Server passes only title:

```203:203:src/serve/server.ts
            const summary = await deps.ingest(tmpPath, { title: filename }, broadcast);
```

`ingestFile` falls back to `readDoc(path).source` = resolved temp path (`src/ingest/ingest.ts:47-51`, `src/ingest/adapters.ts:60`). That path is written to `provenance.path`, `recordIngestedSource`, and `meta.cause`. **The bug the `display` option was added to fix is only half-fixed.**

### CONFIRMED — Identical re-drop reports success with "0 entities" and reloads

`ingestFile` returns `skipped: true, entities: 0, edges: 0` for unchanged content (`src/ingest/ingest.ts:63-64`). Server returns 200. Client:

```744:748:viewer/template.html
      const r=JSON.parse(txt);
      dropStatus('added '+r.entities+' entities, '+r.edges+' edges — reloading…', true);
      setTimeout(()=>location.reload(), 900);
```

User sees "added 0 entities, 0 edges — reloading…" — reads as a failed or pointless drop. Design §12 flags this product judgement; the UI does not distinguish skip from add.

### CONFIRMED — Partial ingest on failure is durable; layout may not run

Chunk memo commits per chunk (`src/ingest/ingest.ts:102-123`). If `ingestFile` throws mid-loop, completed chunks remain; `recordIngestedSource` may not run. If `ingestFile` succeeds but `layoutPass` throws (`scripts/serve.ts:53`), new nodes exist without layout rows → viewer §3.4 incomplete fallback → **full in-browser settle**, destroying additive geometry for the session. No test on this path.

### CONFIRMED — `ingesting` flag clears on failure; server is not permanently wedged

`finally` resets `ingesting = false` and deletes temp file (`src/serve/server.ts:210-213`). Failed ingest returns 500; next drop can proceed (modulo TOCTOU race above).

### CONFIRMED — Temp file cleanup on handled paths

`finally` unlink + `sweepTemp` at startup (`src/serve/server.ts:95-96`, `210-212`). Tested for success and throw (`test/serve-server.test.ts:136-149`, `225-242`).

### CONFIRMED — SSE listener lifecycle is mostly sound

`req.on('close')` removes listener (`src/serve/server.ts:176`). `close()` ends all listeners on shutdown (`src/serve/server.ts:227-229`). Client closes EventSource after POST completes (`viewer/template.html:742`). **Gap:** if POST hangs for minutes, SSE stays open — intended for progress. If POST fails before open, `es.close()` in catch (`viewer/template.html:749`).

### CONFIRMED — Double `done` broadcast

Server calls `broadcast` inside `deps.ingest` via `onProgress`, then again:

```203:204:src/serve/server.ts
            const summary = await deps.ingest(tmpPath, { title: filename }, broadcast);
            broadcast({ ...summary, phase: "done" });
```

Harmless duplication; client ignores SSE `done` and uses POST body.

### CONFIRMED — Chunk progress index is start-of-chunk, not end

`onChunk?.(i, chunks.length)` at loop start (`src/ingest/ingest.ts:84`). UI shows `p.i+1` (`viewer/template.html:735`) — "chunk 1 of N" while chunk 0 is processing. Acceptable; not "lying," but not "done with chunk 1."

### CONFIRMED — Served viewer still uses `localStorage` for scenes; `/scenes` API unwired

`loadScenes()` reads `localStorage` only (`viewer/template.html:647`). `exportViewer` does not embed DB scenes (`scripts/export-viewer.ts:49`). `GET/PUT /scenes` exist (`src/serve/server.ts:148-164`, `scripts/serve.ts:60-87`) but the viewer never calls them. Design §6 says DB is source of truth for served mode; **slice 3 does not close that loop.** Imported scenes are invisible on the served page unless the user re-exports from a `file://` bundle.

### HYPOTHESIS — SIGINT mid-ingest

`shutdown` calls `process.exit(0)` (`scripts/serve.ts:96`) without awaiting in-flight ingest. SQLite WAL usually survives; you may get partial ingest + no layout pass. Same class as crash — chunk memo helps resume.

### HYPOTHESIS — Only first dropped file processed

`e.dataTransfer.files[0]` (`viewer/template.html:727`). Multi-file drop silently drops the rest. Not a security issue; UX surprise.

---

## 3. Test quality

### What actually constrains behavior

**Strong:** `test/serve-guard.test.ts` — pure unit tests on measured header rules; would catch the two self-inflicted bugs from round 2.

**Strong:** Raw-socket Host rebinding tests (`test/serve-server.test.ts:80-90`) — real constraint; `fetch` would not have caught this.

**Adequate:** Upload bounds, temp cleanup, single-flight happy path, SSE wiring with injected deps, malformed JSON 400.

### Tests that mostly re-execute or assert strings

| Test | Problem |
|------|---------|
| `test/serve-server.test.ts:245-260` | Reads `template.html` as text; never runs in jsdom with `file://` vs `http:`. Removing `if(SERVED)` would fail; swapping drop logic for a no-op inside the block might not. |
| `test/serve-server.test.ts:207-216` | `writeScenes` is mocked; does not exercise `scripts/serve.ts:64-87` version/conflict logic or `importScenes`. |
| `test/serve-server.test.ts:74-77` | Sets `Host` in `fetch` headers — forbidden in browsers; works in Node only because URL already targets `127.0.0.1`. Accidentally tests the right thing. |
| No serve-level dedup test | Design §10: "repeat drop of identical bytes writes nothing" — covered in `test/corpus-ingest.test.ts` for CLI, **not** for HTTP surface. |

### Mutations likely tried (inferred from tests + session log style)

1. Remove / bypass Host check → raw socket tests fail  
2. Require Origin on `/events` → guard unit + SSE test fail  
3. Require `same-origin` on navigation → guard unit fails  
4. Allow cross-site `Sec-Fetch-Site` on POST → server test fails  
5. Skip temp `rmSync` in `finally` → server test fails  
6. Use client path for write → traversal test fails  
7. Return 200 on evil Host via `fetch` → caught by raw socket rewrite  

### Mutations **not** tried (would likely stay green)

1. **TOCTOU:** move `ingesting = true` after check but don't re-check — concurrent POSTs both ingest  
2. **`display.source` omitted** — current code; no test  
3. **`expectedOrigin` only `127.0.0.1` while allowing `localhost` Host** — drop broken on localhost URL  
4. **Remove supplemental rule** `src/serve/server.ts:141-142` — old browsers / edge clients without Origin but with Sec-Fetch might POST; no test  
5. **CLI lock missing / one-sided** — no test in slice 3  
6. **`writeScenes` real implementation** — version check, `contentKey` recompute, anchor validation — all mocked  
7. **Repeat identical upload via HTTP** — no assertion on `skipped` or zero-write  
8. **`layoutPass` throws after successful ingest** — partial graph state  
9. **Remove `SERVED` guard** — template substring test might still pass if `SERVED` string remains elsewhere  
10. **Broadcast not called on error** — 500 still returned; SSE error path untested end-to-end in browser  
11. **`prominencePass` failure** — no isolation test on serve path  
12. **Foreign Origin on `PUT /scenes`** — not tested (only cross-site POST /ingest)  

---

## 4. Viewer drop target (`file://` vs served)

### CONFIRMED — Inert on `file://`

```701:719:viewer/template.html
const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
// ...
if(SERVED){
  // drag/drop handlers
}
```

On `file://`, no handlers, no failed POST to nowhere. Template substring test documents intent (`test/serve-server.test.ts:253-254`).

### CONFIRMED — Active when served over HTTP

Handlers register; `EventSource('/events')` + `fetch('/ingest')` (`viewer/template.html:732-740`). Same-origin relative URLs work when page is `http://127.0.0.1:PORT/`.

### User confusion / lost work

| Situation | What user sees | Reality |
|-----------|----------------|---------|
| Unsupported extension | Clear message (`viewer/template.html:729`) | Good |
| Ingest in progress, second drop | `409` text in status (`viewer/template.html:743`) | Work not queued — must retry manually |
| Identical file re-dropped | "added 0 entities… reloading" | Dedup worked; feels broken |
| Long ingest, tab closed | Ingest may continue server-side; client loses SSE | Reload may show new nodes; no persistent job UI |
| Success | Reload after 900ms (`viewer/template.html:748`) | Unsaved **localStorage** scenes on served origin are empty (different origin from `file://`); user may not realize exported DB scenes aren't shown |
| `localhost` URL | Page loads, drop fails on Origin | Silent breakage |

Progress is honestly tied to SSE chunk events, not a fake spinner (`viewer/template.html:735`) — good.

---

## 5. Guard rules vs measured behavior

The table in `src/serve/guard.ts:4-7` matches the probe harness (`scripts/bench/header-probe.mjs`) and unit tests. The two "obvious" broken rules are correctly rejected. The supplemental server rule (Origin required when `Sec-Fetch-Site` is present on mutating routes) is an improvement beyond pure `guard()` and is **untested**.

`isMutating` includes `PUT` but not `DELETE`/`PATCH` — only routes defined are GET/POST/PUT; fine for v1.

---

## Summary table

| Severity | Finding | Status |
|----------|---------|--------|
| High | CLI ↔ serve advisory lock one-sided; concurrent DB writers | CONFIRMED |
| High | Single-flight TOCTOU before `ingesting = true` | CONFIRMED |
| Medium | Temp path in provenance (`display.source` missing) | CONFIRMED |
| Medium | `localhost` / `[::1]` Origin mismatch breaks drop | CONFIRMED |
| Medium | DB scenes not shown on served page; API unwired | CONFIRMED |
| Low | Re-drop UX ("0 entities" + reload) | CONFIRMED |
| Low | Identical-bytes dedup untested on HTTP | CONFIRMED gap |
| By design | Local non-browser ingest (curl) | CONFIRMED, accepted |
| By design | DNS rebinding blocked via Host | CONFIRMED |
| Hypothesis | SSE connection exhaustion | HYPOTHESIS |
| Hypothesis | `GET /` export spam | HYPOTHESIS |

---

## Is it safe to run?

**For a developer who types `http://127.0.0.1:7777`, uses a modern browser, and does not run CLI ingest against the same graph while serve is up: yes, with eyes open.** The header guard is the real defense against malicious web pages; it is implemented on all routes and tested with raw sockets where it matters.

**Do not treat it as:** multi-process safe, localhost-URL safe, provenance-clean for drops, or protected against local malware/scripts. Fix the TOCTOU race, pass `display.source`, wire or document the CLI lock, and align `expectedOrigin` with allowed Hosts before calling this production-ready.

I found no prior `docs/reviews/slice3-*` artifact; this is a first slice-3 review pass against the diff and tree.

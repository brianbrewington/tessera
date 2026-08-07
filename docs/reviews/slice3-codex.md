# Slice-3 review — tessera serve + drop target

**Reviewer:** Codex 5.3 (`gpt-5.3-codex`) via Cursor · **Date:** 2026-08-06

---

## Findings (Most Severe First)

### 1) **CONFIRMED — Cross-process write protection is not actually enforced**
The code claims to prevent `tessera ingest` and served drops from writing concurrently, but only `serve` takes the lock; CLI `ingest` never checks it. So two processes can still race on the same DB.

```21:33:scripts/serve.ts
/** Advisory lock so a CLI `ingest` and a served drop cannot write the same graph at once. */
function takeLock(dir: string): () => void {
  const lock = join(dir, ".ingest.lock");
  if (existsSync(lock)) {
    const age = Date.now() - Number(readFileSync(lock, "utf8").trim() || 0);
    if (age < 6 * 60 * 60 * 1000) throw new Error(`another tessera process holds ${lock} — refusing to serve`);
```

```88:96:scripts/cli.ts
const graph = Graph.open(name);
try {
  const extractor = new LlmExtractor(new OllamaChat(extractorModel), { temperature: 0.4 });
  let ingested = 0, skipped = 0, partial = 0, failed = 0, entities = 0, edges = 0;
  for (const f of docs) {
    try {
      const r = await ingestFile(graph, extractor, f, { reextract, extractorModel });
```

Impact:
- Concurrent `serve` drop + CLI ingest can still happen.
- With `busy_timeout=5000`, lock contention can surface as intermittent `database is locked` failures under load.

---

### 2) **CONFIRMED — Lock acquisition is race-prone and stale-lock handling can wedge service startup**
`takeLock()` is check-then-create, not atomic (`existsSync` + `writeFileSync`), so two `serve` processes can both acquire. Also the release is only wired to SIGINT/SIGTERM; startup failures can leave a lock until TTL expiry.

```23:29:scripts/serve.ts
if (existsSync(lock)) {
  const age = Date.now() - Number(readFileSync(lock, "utf8").trim() || 0);
  if (age < 6 * 60 * 60 * 1000) throw new Error(`another tessera process holds ${lock} — refusing to serve`);
  rmSync(lock, { force: true }); // stale
}
writeFileSync(lock, String(Date.now()));
return () => rmSync(lock, { force: true });
```

```92:99:scripts/serve.ts
await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", () => resolve()));
...
const shutdown = async (): Promise<void> => { await close(); release(); process.exit(0); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
```

Impact:
- Two servers may run concurrently despite intended lock.
- Failed startup can block subsequent `serve` for up to 6 hours.

---

### 3) **CONFIRMED — `localhost` is allowed by Host guard, but mutating requests from `localhost` origin are rejected**
Guard allows `Host: localhost:PORT`, but `Origin` must equal `http://127.0.0.1:PORT`. If user opens `http://localhost:7777`, drop uploads and `PUT /scenes` fail with 403.

```35:37:src/serve/guard.ts
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}
```

```93:56:src/serve/server.ts
const expectedOrigin = `http://127.0.0.1:${port}`;
...
if (input.origin !== undefined && input.origin !== "null" && input.origin !== expectedOrigin) {
  return deny(403, `foreign Origin ${input.origin}`);
}
```

Impact:
- Real user-visible failure mode: page loads, drop target appears active, upload fails.

---

### 4) **CONFIRMED — Ingest can be wedged "busy forever" if extractor hangs**
Single-flight flag clears in `finally`, but only if `deps.ingest(...)` returns/throws. If LLM call hangs indefinitely, server returns 409 forever for later uploads.

```180:214:src/serve/server.ts
if (path === "/ingest" && req.method === "POST") {
  if (ingesting) return send(res, 409, "an ingest is already running");
  ...
  ingesting = true;
  try {
    writeFileSync(tmpPath, body);
    const summary = await deps.ingest(tmpPath, { title: filename }, broadcast);
    ...
  } finally {
    rmSync(tmpPath, { force: true });
    ingesting = false;
  }
}
```

Impact:
- One hung ingestion can deny all future ingestion work until process restart.

---

### 5) **CONFIRMED — Drop progress UI has an off-by-one terminal chunk status**
`ingestFile` emits `(chunks, chunks)` after loop, while client displays `p.i + 1`. Users can briefly see "chunk N+1 of N".

```83:87:src/ingest/ingest.ts
for (let i = 0; i < chunks.length; i++) {
  opts.onChunk?.(i, chunks.length);
...
}
opts.onChunk?.(chunks.length, chunks.length);
```

```733:736:viewer/template.html
if(p.phase==='chunk') dropStatus('ingesting '+f.name+' — chunk '+(p.i+1)+' of '+p.of+'…', true);
else if(p.phase==='error') { dropStatus('ingest failed: '+p.message); es.close(); }
```

Impact:
- Misleading UX during long ingest.

---

## Security Assessment (Hostile Web Pages)

### CONFIRMED
- I did **not** find a confirmed hostile-web-page exfiltration path that bypasses the Host check for modern browsers.
- Guard is applied on all sensitive routes (`/`, `/ingest`, `/events`, `/scenes`), and Host validation blocks DNS-rebound hostnames on those routes.

### HYPOTHESIS / Residual Risk
- Security posture relies on modern browser header behavior (`Sec-Fetch-Site`, Origin patterns). Older/atypical clients could behave differently than measured Chrome/Firefox.
- Unknown paths return 404 before guard; low risk now, but if future sensitive routes are added outside `ROUTES`, they could accidentally skip guard.

---

## Test Quality Review

Good:
- Using raw socket for Host tests is correct and catches the forbidden-header pitfall.
- Core route security paths are exercised.

Gaps where mutations could stay green:
- No test that `localhost` origin can mutate successfully (or intentionally cannot).
- No test for cross-process lock contract (`serve` vs CLI ingest).
- No test for lock atomicity or stale-lock-on-startup-failure behavior.
- No test for "hung ingest" liveness recovery/timeout.
- Drop-target test is mostly static template-string matching; it can stay green while behavior regresses (it does not execute drag/drop flow).

---

## Bottom Line

Not ready to call fully safe for daily developer use **as implemented**: hostile-page defenses look reasonably strong in modern browsers, but concurrency/liveness correctness is weak enough to wedge ingestion or create write races.  
If your bar is "safe from random web pages reading/writing the graph," this is close; if your bar includes robust operation under failures/concurrency, this slice is not there yet.

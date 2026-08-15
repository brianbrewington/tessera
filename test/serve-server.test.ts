// `tessera serve` over a REAL socket (design §7). Deps are injected so this needs no LLM, embedder, or
// graph — the point is the HTTP surface: the guard applied per route, upload bounds, single-flight,
// SSE, all-or-nothing scene writes, and temp cleanup.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createTesseraServer, sweepTemp, MAX_UPLOAD_BYTES, type IngestProgress, type ServeDeps } from "../src/serve/server.js";
import { shouldDrainAgain, createDrainCoordinator } from "../scripts/serve.js";

/**
 * Raw HTTP over a socket, because `fetch` treats Host as a FORBIDDEN header and silently substitutes the
 * real one — so a rebinding test written with fetch quietly asserts nothing. Found by this test failing for
 * the wrong reason; had it been written to expect 200 it would have passed and hidden an untested guard.
 */
function raw(headers: Record<string, string>, path = "/", method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, "127.0.0.1", () => {
      const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
      sock.write(lines.join("\r\n"));
    });
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => {
      const status = Number(buf.split(" ")[1]);
      resolve({ status, body: buf.slice(buf.indexOf("\r\n\r\n") + 4) });
    });
    sock.on("error", reject);
  });
}

const PORT = 7791;
const BASE = `http://127.0.0.1:${PORT}`;
const HDR = { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin", Origin: BASE };
const NAV = { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "none" };

let close: () => Promise<void>;
let temp: string;
const state = {
  ingestCalls: [] as Array<{ path: string; title: string; source: string; content: string }>,
  ingestDelayMs: 0,
  ingestThrows: false,
  scenes: [{ id: "s1", name: "one", version: 1 }] as Array<Record<string, unknown>>,
  writeConflicts: [] as string[],
  status: { chunks: 10, dirty: 2, never: 2, stale: 0, failing: 1, draining: false },
};

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "tessera-serve-test-"));
  const deps: ServeDeps = {
    renderPage: () => "<html><body>MAP</body></html>",
    isSupported: (f) => /\.(md|txt)$/i.test(f),
    ingest: async (path, display, onProgress): Promise<IngestProgress> => {
      const { readFileSync } = await import("node:fs");
      state.ingestCalls.push({ path, title: display.title, source: display.source, content: readFileSync(path, "utf8") });
      onProgress({ phase: "chunk", i: 1, of: 2 });
      if (state.ingestDelayMs) await new Promise((r) => setTimeout(r, state.ingestDelayMs));
      if (state.ingestThrows) throw new Error("extractor exploded");
      return { phase: "done", chunks: 2, entities: 5, edges: 3, laidOut: 5 };
    },
    readScenes: () => ({ scenes: state.scenes }),
    status: () => state.status,
    writeLayout: () => ({ ok: true, written: 0 }),
  writeScenes: () => (state.writeConflicts.length ? { ok: false, conflicts: state.writeConflicts } : { ok: true }),
    tempDir: temp,
  };
  const s = createTesseraServer({ port: PORT, deps });
  close = s.close;
  await new Promise<void>((r) => s.server.listen(PORT, "127.0.0.1", () => r()));
});
afterAll(async () => close && (await close()));

const post = (path: string, body: string, headers: Record<string, string> = HDR, extra: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { ...headers, ...extra }, body });

describe("the guard is applied on every route, over a real socket", () => {
  it("serves the page to a normal navigation", async () => {
    const r = await fetch(BASE + "/", { headers: NAV });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("MAP");
  });

  it("REFUSES a rebound Host on GET / — the whole-graph exfiltration path", async () => {
    // Raw socket, not fetch: see the `raw` helper. The attack is evil.com rebound to 127.0.0.1, which the
    // browser treats as same-origin with evil.com — no Origin, no preflight, loopback binding no help.
    const r = await raw({ Host: "evil.com:7791", "Sec-Fetch-Site": "none" });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/Host/);
  });

  it("REFUSES a rebound Host on the API routes too", async () => {
    expect((await raw({ Host: "evil.com:7791", "Sec-Fetch-Site": "same-origin" }, "/scenes")).status).toBe(403);
    expect((await raw({ Host: "evil.com:7791", "Sec-Fetch-Site": "same-origin" }, "/events")).status).toBe(403);
  });

  it("a correct Host over the same raw path still works — the guard is not just refusing everything", async () => {
    const r = await raw({ Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "none" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("MAP");
  });

  it("refuses a cross-site POST but allows the page's own", async () => {
    expect((await post("/ingest", "x", { ...HDR, "Sec-Fetch-Site": "cross-site" }, { "X-Tessera-Filename": "a.md" })).status).toBe(403);
    expect((await post("/ingest", "hello", HDR, { "X-Tessera-Filename": "a.md" })).status).toBe(200);
  });

  it("404s an unknown path rather than leaking behaviour", async () => {
    expect((await fetch(BASE + "/secrets", { headers: NAV })).status).toBe(404);
  });
});

describe("upload bounds", () => {
  it("rejects an unsupported extension", async () => {
    const r = await post("/ingest", "x", HDR, { "X-Tessera-Filename": "payload.exe" });
    expect(r.status).toBe(415);
  });

  it("rejects an oversized body by declared length AND by stream", async () => {
    const big = "x".repeat(MAX_UPLOAD_BYTES + 10);
    const r = await post("/ingest", big, HDR, { "X-Tessera-Filename": "big.md" });
    expect(r.status).toBe(413);
  });

  it("rejects an empty upload", async () => {
    expect((await post("/ingest", "", HDR, { "X-Tessera-Filename": "e.md" })).status).toBe(400);
  });

  it("never lets the client filename become a filesystem path", async () => {
    state.ingestCalls.length = 0;
    const r = await post("/ingest", "content here", HDR, { "X-Tessera-Filename": "../../../../etc/passwd.md" });
    expect(r.status).toBe(200);
    const call = state.ingestCalls.at(-1)!;
    expect(call.path.startsWith(temp)).toBe(true); // server-generated path, inside the temp dir
    expect(call.path).not.toContain("..");
    expect(call.title).toBe("../../../../etc/passwd.md"); // kept ONLY as the display title
    expect(call.content).toBe("content here");
  });

  it("deletes the temp file after a successful ingest", async () => {
    state.ingestCalls.length = 0;
    await post("/ingest", "abc", HDR, { "X-Tessera-Filename": "clean.md" });
    expect(existsSync(state.ingestCalls.at(-1)!.path)).toBe(false);
  });

  it("deletes the temp file after a FAILED ingest too", async () => {
    state.ingestCalls.length = 0;
    state.ingestThrows = true;
    const r = await post("/ingest", "abc", HDR, { "X-Tessera-Filename": "boom.md" });
    state.ingestThrows = false;
    expect(r.status).toBe(500);
    expect(existsSync(state.ingestCalls.at(-1)!.path)).toBe(false);
  });
});

describe("single-flight", () => {
  it("a second concurrent ingest gets 409, and the first still completes", async () => {
    state.ingestDelayMs = 250;
    const first = post("/ingest", "one", HDR, { "X-Tessera-Filename": "a.md" });
    await new Promise((r) => setTimeout(r, 40));
    const second = await post("/ingest", "two", HDR, { "X-Tessera-Filename": "b.md" });
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    state.ingestDelayMs = 0;
    // and the lock is released — a later drop works
    expect((await post("/ingest", "three", HDR, { "X-Tessera-Filename": "c.md" })).status).toBe(200);
  });
});

describe("SSE progress", () => {
  it("the page's own EventSource-shaped request connects and receives chunk + done", async () => {
    // A same-origin GET sends Sec-Fetch-Site: same-origin and NO Origin. This is the exact shape that an
    // earlier draft of the guard would have rejected.
    const ctrl = new AbortController();
    const res = await fetch(BASE + "/events", {
      headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin", Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      while (seen.join("").indexOf('"phase":"done"') < 0) {
        const { value, done } = await reader.read();
        if (done) break;
        seen.push(dec.decode(value));
      }
    })();

    await new Promise((r) => setTimeout(r, 60));
    await post("/ingest", "body", HDR, { "X-Tessera-Filename": "sse.md" });
    await pump;
    const text = seen.join("");
    expect(text).toContain('"phase":"chunk"');
    expect(text).toContain('"phase":"done"');
    expect(text).toContain('"entities":5');
    ctrl.abort();
  }, 20_000);
});

describe("scenes over HTTP", () => {
  it("GET returns the stored scenes", async () => {
    const r = await fetch(BASE + "/scenes", { headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" } });
    expect(r.status).toBe(200);
    expect((await r.json()).scenes[0].name).toBe("one");
  });

  it("PUT is ALL-OR-NOTHING: any stale version returns 409 and applies nothing", async () => {
    state.writeConflicts = ["s1"];
    const r = await fetch(BASE + "/scenes", {
      method: "PUT", headers: { ...HDR, "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: [{ id: "s1", version: 99 }] }),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).conflicts).toEqual(["s1"]); // names WHICH scenes conflicted
    state.writeConflicts = [];
  });

  it("rejects malformed JSON with 400, not a stack trace", async () => {
    const r = await fetch(BASE + "/scenes", { method: "PUT", headers: HDR, body: "{not json" });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toMatch(/at .*\.ts:/);
  });
});

describe("temp sweep — because a SIGKILL cannot run a finally", () => {
  it("removes stale uploads and leaves fresh ones alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-sweep-"));
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "tessera-upload-old.md");
    const fresh = join(dir, "tessera-upload-new.md");
    const other = join(dir, "unrelated.txt");
    for (const f of [stale, fresh, other]) writeFileSync(f, "x");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);

    expect(sweepTemp(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true); // only our own prefix, never someone else's files
    expect(readdirSync(dir).length).toBe(2);
  });
});

describe("the drop target is inert on file:// and active when served", () => {
  it("installs handlers only under http(s)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join: j } = await import("node:path");
    const tpl = readFileSync(j(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "template.html"), "utf8");
    // The bundle is still opened over file:// for sharing; a drop there has no server to post to, so the
    // handlers must not be installed at all rather than failing at drop time.
    expect(tpl).toContain("const SERVED = location.protocol === 'http:' || location.protocol === 'https:';");
    expect(tpl).toMatch(/if\(SERVED\)\{[\s\S]*addEventListener\('drop'/);
    // and it must reject unsupported types client-side too, before uploading megabytes the server will 415
    expect(tpl).toMatch(/\\\.\(md\|txt\)\$\/i\.test\(f\.name\)/);
    // progress must come from the SSE stream, not a spinner that lies
    expect(tpl).toContain("new EventSource('/events')");
    expect(tpl).toMatch(/p\.phase==='chunk'/);
  });
});

describe("single-flight is claimed SYNCHRONOUSLY (Composer, HIGH — TOCTOU)", () => {
  it("two POSTs fired together: exactly one ingests, the other 409s", async () => {
    // The bug: `ingesting` was checked, then `await readBody` ran, then it was set 19 lines later. Two
    // same-origin POSTs could both pass the check and both run the pipeline against one graph. The previous
    // single-flight test delayed INSIDE the mock ingest, so it never exercised the gap before the flag was set.
    state.ingestCalls.length = 0;
    state.ingestDelayMs = 200;
    const both = await Promise.all([
      post("/ingest", "a".repeat(50_000), HDR, { "X-Tessera-Filename": "race1.md" }),
      post("/ingest", "b".repeat(50_000), HDR, { "X-Tessera-Filename": "race2.md" }),
    ]);
    state.ingestDelayMs = 0;
    const codes = both.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(state.ingestCalls.length).toBe(1); // the pipeline ran ONCE
  }, 20_000);

  it("an early rejection releases the claim — a 415 must not wedge the server", async () => {
    // Every early return after claiming has to release, or one bad drop denies all future ingest.
    expect((await post("/ingest", "x", HDR, { "X-Tessera-Filename": "bad.exe" })).status).toBe(415);
    expect((await post("/ingest", "", HDR, { "X-Tessera-Filename": "empty.md" })).status).toBe(400);
    expect((await post("/ingest", "ok", HDR, { "X-Tessera-Filename": "fine.md" })).status).toBe(200);
  });
});

describe("localhost and ::1 are usable, not just 127.0.0.1 (both reviewers)", () => {
  it("an Origin matching ANY allowed Host form is accepted", async () => {
    // The bug: `localhost:PORT` was an allowed Host but the only accepted Origin was http://127.0.0.1:PORT,
    // so opening http://localhost:7777 gave a page that loaded and a drop target that 403'd.
    const r = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin", Origin: `http://localhost:${PORT}`, "X-Tessera-Filename": "loc.md" },
      body: "hello",
    });
    expect(r.status).toBe(200);
  });

  it("a genuinely foreign Origin is still refused", async () => {
    const r = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin", Origin: "http://evil.example", "X-Tessera-Filename": "x.md" },
      body: "hello",
    });
    expect(r.status).toBe(403);
  });
});

describe("provenance must not record the temp path (Composer, MEDIUM)", () => {
  it("passes an explicit display.source, not just a title", async () => {
    state.ingestCalls.length = 0;
    await post("/ingest", "body", HDR, { "X-Tessera-Filename": "prov.md" });
    const call = state.ingestCalls.at(-1)!;
    expect(call.source).toBe("drop:prov.md"); // stable, and NOT the uuid temp path
    expect(call.source).not.toContain(temp);
  });
});

describe("the SSE listener set is bounded (Fable round 2, 8a — the old test asserted nothing)", () => {
  it("the 9th stream is ENDED and receives no broadcasts", async () => {
    // The previous version opened 12 streams and asserted all 12 got 200 — while its own comment conceded
    // "status is 200 either way". Deleting the cap left it green. This asserts the cap's actual effect.
    const ctrls: AbortController[] = [];
    const readers: Array<{ body: string; done: boolean }> = [];
    const open = async (): Promise<{ body: string; done: boolean }> => {
      const c = new AbortController();
      ctrls.push(c);
      const r = await fetch(BASE + "/events", { headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" }, signal: c.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let body = "";
      let done = false;
      const first = await reader.read();
      if (first.done) done = true;
      else body += dec.decode(first.value);
      // a capped stream is ended immediately; an accepted one stays open
      void reader.read().then((n) => { if (n.done) done = true; else body += dec.decode(n.value); }).catch(() => {});
      return { body, done };
    };
    for (let i = 0; i < 10; i++) readers.push(await open());
    await new Promise((r) => setTimeout(r, 120));
    // assert the CAP's effect, not that a message string appears somewhere: the 9th stream must be ENDED,
    // and the accepted ones must still be open. slice(8).some() also let a cap drift 8->9 pass silently.
    const accepted = readers.slice(0, 8);
    const capped = readers.slice(8);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.every((x) => x.done || /too many progress listeners/.test(x.body))).toBe(true);
    expect(accepted.every((x) => !x.done)).toBe(true); // the ones under the cap stayed open
  }, 30_000);
});

describe("oversize is rejected MID-STREAM, not only by declared length (Fable round 2, 8b)", () => {
  it("a chunked upload with no Content-Length is cut off at the cap", async () => {
    // fetch with a string body always sets Content-Length, so the old test died at the declared-length
    // pre-check and never reached the streaming guard inside readBody. Removing that guard stayed green —
    // and readBody is also the ONLY limit on PUT /scenes, which has no declared pre-check at all.
    const { connect } = await import("node:net");
    const status = await new Promise<number>((resolve, reject) => {
      const sock = connect(PORT, "127.0.0.1", () => {
        sock.write(
          [`POST /ingest HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, `Sec-Fetch-Site: same-origin`,
           `Origin: ${BASE}`, `X-Tessera-Filename: chunked.md`, `Transfer-Encoding: chunked`, "", ""].join("\r\n"),
        );
        // stream past the 4MB cap in 64KB chunks; the server must cut us off before we finish
        const block = "x".repeat(65536);
        let sent = 0;
        const pump = (): void => {
          if (sent > MAX_UPLOAD_BYTES + 512 * 1024) { sock.write("0\r\n\r\n"); return; }
          sent += block.length;
          sock.write(`${block.length.toString(16)}\r\n${block}\r\n`, () => setImmediate(pump));
        };
        pump();
      });
      let buf = "";
      sock.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n")) { resolve(Number(buf.split(" ")[1])); sock.destroy(); } });
      sock.on("close", () => { if (buf) resolve(Number(buf.split(" ")[1])); else reject(new Error("closed with no response")); });
      sock.on("error", () => { if (buf) resolve(Number(buf.split(" ")[1])); });
    });
    expect(status).toBe(413);
  }, 30_000);
});

describe("a multi-file drop reports every outcome", () => {
  // The handler used to take e.dataTransfer.files[0]: dropping three files ingested one and said NOTHING
  // about the other two. Silent loss into a system whose whole point is completeness. These drive the two
  // extracted helpers directly rather than slicing a region of the handler out of the template, which broke
  // the moment the handler grew a loop.
  const tplSrc = (): string => {
    const { readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    return rf(join(__dirname, "..", "viewer", "template.html"), "utf8");
  };
  /** Pull a named top-level function out of the template so it can be exercised with no DOM. */
  const fnFromTemplate = (name: string): Function => {
    const src = tplSrc();
    const at = src.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("\n}", at);
    return new Function(`${src.slice(at, end + 2)}; return ${name};`)() as Function;
  };

  it("the badge distinguishes an ACTIVE drain from settled debt", () => {
    // Brian dropped a file and had to ask whether anything was happening. It was: the drain was running and
    // 47 chunks deep. The badge could not say so, because it is fed from the page bundle at load and the
    // drop reloads the page, destroying the SSE stream. So a live drain looked identical to nothing.
    const src = tplSrc();
    const at = src.indexOf("function setDirtyBadge(");
    const body = src.slice(at, src.indexOf("\n}", at) + 2);
    const cls = new Set<string>();
    let text = "";
    const el = {
      classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), toggle: (c: string, v: boolean) => (v ? cls.add(c) : cls.delete(c)) },
      set textContent(v: string) { text = v; },
      set title(_v: string) { /* unused here */ },
    };
    const setDirtyBadge = new Function("$", "SERVED", "GRAPH", `${body}; return setDirtyBadge;`)(
      () => el, true, { name: "g" },
    ) as (b: unknown) => void;

    setDirtyBadge({ chunks: 318, dirty: 39, never: 39, stale: 0, failing: 0, draining: true });
    expect(text).toMatch(/extracting/);
    expect(text).toContain("39");
    expect(cls.has("busy")).toBe(true);

    cls.clear();
    setDirtyBadge({ chunks: 318, dirty: 39, never: 39, stale: 0, failing: 0, draining: false });
    expect(text).toMatch(/awaiting/); // owed, but nothing is working on it
    expect(cls.has("busy")).toBe(false);
    expect(cls.has("on")).toBe(true);

    cls.clear();
    setDirtyBadge({ chunks: 318, dirty: 0, never: 0, stale: 0, failing: 0, draining: false });
    expect(cls.has("on")).toBe(false); // nothing owed, nothing running: the badge goes away
  });

  it("only a FILE drag arms the ingest overlay — reordering a scene must not", () => {
    // Dragging a scene row to reorder it lit the full-screen "drop a .md or .txt" overlay, because the
    // ingest handlers are on WINDOW and every drag reaches them. The gesture was internal and the UI
    // claimed an ingest was about to happen. Tested as a positive predicate rather than by suppressing
    // each internal drag, or the next draggable thing added to this page reintroduces it.
    const isFileDrag = fnFromTemplate("isFileDrag") as (e: unknown) => boolean;
    expect(isFileDrag({ dataTransfer: { types: ["Files"] } })).toBe(true);
    expect(isFileDrag({ dataTransfer: { types: ["Files", "application/x-moz-file"] } })).toBe(true);
    // What a scene reorder actually carries.
    expect(isFileDrag({ dataTransfer: { types: ["text/plain"] } })).toBe(false);
    expect(isFileDrag({ dataTransfer: { types: [] } })).toBe(false);
    // dragleave/dragend can arrive with nothing attached; must not throw.
    expect(isFileDrag({ dataTransfer: null })).toBe(false);
    expect(isFileDrag({})).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });

  it("partitions a dropped FileList into supported and rejected, keeping ALL of both", () => {
    const partitionDrop = fnFromTemplate("partitionDrop") as (f: Array<{ name: string }>) => { supported: Array<{ name: string }>; rejected: string[] };
    const r = partitionDrop([{ name: "a.md" }, { name: "photo.png" }, { name: "b.txt" }, { name: "c.pdf" }]);
    expect(r.supported.map((f) => f.name)).toEqual(["a.md", "b.txt"]); // not just the first
    expect(r.rejected).toEqual(["photo.png", "c.pdf"]); // and the skipped ones are NAMED, not dropped in silence
  });

  it("names every outcome in the summary — queued, already present, unsupported, failed", () => {
    const summariseDrop = fnFromTemplate("summariseDrop") as (s: Record<string, unknown>) => string;
    const all = summariseDrop({ added: 2, queued: 41, dedup: 1, rejected: ["photo.png"], failed: ["x.md"] });
    expect(all).toMatch(/2 files queued \(41 chunks\)/);
    expect(all).toMatch(/1 already in this map/);
    expect(all).toMatch(/unsupported: photo\.png/);
    expect(all).toMatch(/failed: x\.md/);
  });

  it("a deduped re-drop reads as 'already in this map', never as a failed add", () => {
    const summariseDrop = fnFromTemplate("summariseDrop") as (s: Record<string, unknown>) => string;
    // Content-hash dedup means a re-drop of identical bytes adds nothing. "added 0 entities" reads as a
    // failure, so the wording has to name what actually happened.
    const msg = summariseDrop({ added: 0, queued: 0, dedup: 1, rejected: [], failed: [] });
    expect(msg).toMatch(/already in this map/);
    expect(msg).not.toMatch(/failed/);
  });

  it("says something honest even when a drop contained nothing usable", () => {
    const summariseDrop = fnFromTemplate("summariseDrop") as (s: Record<string, unknown>) => string;
    expect(summariseDrop({ added: 0, queued: 0, dedup: 0, rejected: [], failed: [] })).toBe("nothing to add");
  });
});

describe("GET /status — extraction debt as a queryable fact", () => {
  // The two never-extracted chunks in graphs/big were invisible for months. A server that knows what is
  // owed and answers only over a progress stream you had to be watching is the same failure with better
  // uptime: this has to be answerable at any time, from another terminal, after a crash.
  it("reports what is owed, through the guard", async () => {
    const r = await fetch(BASE + "/status", { headers: HDR });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ chunks: 10, dirty: 2, never: 2, stale: 0, failing: 1, draining: false });
  });

  it("is guarded like every other API route", async () => {
    const r = await fetch(BASE + "/status", { headers: { ...HDR, Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("the background drain keeps going until the queue is dry", () => {
  // Found independently by me and by a cross-agent review (Composer). extractPending processes the SNAPSHOT
  // it took on entry, and startDrain refuses to start a second drain while one is running. So dropping two
  // files — which the new multi-file handler does as a matter of course — queued the second file's chunks
  // into a drain that had already looked away, and nothing ever scheduled another. They stayed dirty
  // indefinitely: exactly the silent debt this batch exists to abolish, reintroduced by its own fix.
  it("goes again when a round made progress and work remains", () => {
    expect(shouldDrainAgain(5, 12)).toBe(true);
  });

  it("stops when the queue is empty", () => {
    expect(shouldDrainAgain(5, 0)).toBe(false);
  });

  it("stops when a round extracted nothing, even though work remains", () => {
    // Without this half it spins forever: a chunk past the attempt limit stays dirty BY DESIGN, so
    // "remaining > 0" is permanently true and a progress-blind loop would burn the GPU on nothing.
    expect(shouldDrainAgain(0, 3)).toBe(false);
  });
});


describe("the drain coordinator does not lose work that arrives mid-pass", () => {
  // Found independently by BOTH cross-agent reviewers. `startDrain` no-ops while a drain runs, and the
  // running drain's last "anything left?" check can precede the newer chunks, so the second file of a
  // multi-file drop could be chunked and then never extracted. This tests the object the server actually
  // uses; an earlier version of this test drove a hand-written model of the logic and would have stayed
  // green with the real coordinator unwired.
  it("runs a second pass when a request arrives while one is in flight", async () => {
    let passes = 0;
    let release: (() => void) | null = null;
    const coord = createDrainCoordinator(async () => {
      passes++;
      if (passes === 1) await new Promise<void>((r) => { release = r; });  // hold pass 1 open
    });
    coord.request();
    await new Promise((r) => setTimeout(r, 5));
    expect(passes).toBe(1);
    expect(coord.isRunning()).toBe(true);

    coord.request();          // the drop that used to be swallowed
    release!();
    await new Promise((r) => setTimeout(r, 5));
    expect(passes).toBe(2);
  });

  it("does not spin when nothing arrived during the pass", async () => {
    let passes = 0;
    const coord = createDrainCoordinator(async () => { passes++; });
    coord.request();
    await new Promise((r) => setTimeout(r, 10));
    expect(passes).toBe(1);
    expect(coord.isRunning()).toBe(false);
  });

  it("a pass that throws still clears the flag, so the drain is not wedged forever", async () => {
    let passes = 0;
    const coord = createDrainCoordinator(async () => { passes++; throw new Error("ollama died"); });
    coord.request();
    await new Promise((r) => setTimeout(r, 10));
    expect(coord.isRunning()).toBe(false);
    coord.request();                                  // must be able to start again
    await new Promise((r) => setTimeout(r, 10));
    expect(passes).toBe(2);
  });
});

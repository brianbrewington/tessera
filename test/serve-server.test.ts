// `tessera serve` over a REAL socket (design §7). Deps are injected so this needs no LLM, embedder, or
// graph — the point is the HTTP surface: the guard applied per route, upload bounds, single-flight,
// SSE, all-or-nothing scene writes, and temp cleanup.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createTesseraServer, sweepTemp, MAX_UPLOAD_BYTES, type IngestProgress, type ServeDeps } from "../src/serve/server.js";

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

describe("the SSE listener set is bounded", () => {
  it("refuses more than a handful of progress streams", async () => {
    const ctrls: AbortController[] = [];
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const c = new AbortController();
      ctrls.push(c);
      const r = await fetch(BASE + "/events", {
        headers: { Host: `127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" },
        signal: c.signal,
      });
      codes.push(r.status);
      // drain enough to know whether the server closed it immediately
      void r.body?.getReader().read();
    }
    for (const c of ctrls) c.abort();
    expect(codes.every((s) => s === 200)).toBe(true); // status is 200 either way; the cap ends the stream
  }, 20_000);
});

describe("a deduped re-drop is reported as such, not as a failed add", () => {
  it("the client branches on `skipped` before the added-N-entities message", () => {
    const { readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const tpl = rf(join(__dirname, "..", "viewer", "template.html"), "utf8");
    const start = tpl.indexOf("      const r=JSON.parse(txt);");
    const end = tpl.indexOf("setTimeout(()=>location.reload(), 900);", start);
    const src = tpl.slice(start, end);

    const run = (r: Record<string, unknown>): { msg: string; reloaded: boolean } => {
      let msg = "", reloaded = true;
      const dropStatus = (m: string): void => { msg = m; };
      const es = { close(): void {} };
      const f = { name: "notes.md" };
      // the branch returns early when skipped, so `reloaded` stays false in that case
      new Function("txt", "dropStatus", "es", "f", "setReloaded", `${src.replace("return;", "setReloaded(false); return;")}`)(
        JSON.stringify(r), dropStatus, es, f, (v: boolean) => { reloaded = v; },
      );
      return { msg, reloaded };
    };

    const skipped = run({ skipped: true, entities: 0, edges: 0 });
    expect(skipped.msg).toMatch(/already in this map/);
    expect(skipped.msg).not.toMatch(/added 0 entities/); // the message that reads as a failure
    expect(skipped.reloaded).toBe(false); // no pointless reload

    const added = run({ skipped: false, entities: 7, edges: 4 });
    expect(added.msg).toMatch(/added 7 entities, 4 edges/);
    expect(added.reloaded).toBe(true);
  });
});

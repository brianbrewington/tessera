// `tessera serve` (design §7) — the drop target, and tessera's first inbound socket.
//
// node:http only; no new runtime dependencies. Binds 127.0.0.1 explicitly, never 0.0.0.0. Every route runs
// through the measured header guard (src/serve/guard.ts) — see that file before changing anything here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { allowedHosts, guard, isMutating, type RouteKind } from "./guard.js";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface IngestProgress {
  /** chunk = writing chunks (fast) · extract = the background LLM drain · done · error */
  phase: "chunk" | "extract" | "done" | "error";
  i?: number;
  of?: number;
  chunks?: number;
  /** Chunks written and now owed to the extractor. What "42 chunks queued" actually means. */
  queued?: number;
  /** Chunks owed across the WHOLE graph, so the viewer can be honest about an incomplete map. */
  dirty?: number;
  entities?: number;
  edges?: number;
  laidOut?: number;
  /** True when content-hash dedup recognised the document — a no-op, not a failure. */
  skipped?: boolean;
  message?: string;
}

/** What `GET /status` answers. Progress as a queryable FACT, not something inferred from a spinner. */
export interface ServeStatus {
  chunks: number;
  dirty: number;
  never: number;
  stale: number;
  failing: number;
  /** True while a background extraction drain is running in this process. */
  draining: boolean;
}

/** Everything the server needs, injected so tests never need a real graph, LLM, or embedder. */
/**
 * Validate a layout payload. EXPORTED so tests can drive the shipped function rather than a copy of it — the
 * first version of these tests reimplemented this logic inline, which is the decoration the review called out:
 * it would have kept passing while the real handler drifted.
 */
export function validateLayoutPayload(
  payload: unknown,
  knownIds?: ReadonlySet<string>,
): { ok: true; entries: { nodeId: string; x: number; y: number }[] } | { ok: false; error: string } {
  const p = payload as { positions?: Record<string, [number, number]> } | null;
  if (!p || typeof p !== "object" || !p.positions || typeof p.positions !== "object" || Array.isArray(p.positions)) {
    return { ok: false, error: "expected { positions: { id: [x, y] } }" };
  }
  const entries = Object.entries(p.positions).map(([nodeId, xy]) => ({
    nodeId,
    x: Number((xy as number[] | undefined)?.[0]),
    y: Number((xy as number[] | undefined)?.[1]),
  }));
  if (!entries.length) return { ok: false, error: "no positions" };
  const bad = entries.find((e) => !Number.isFinite(e.x) || !Number.isFinite(e.y));
  if (bad) return { ok: false, error: `non-finite position for ${bad.nodeId}` };
  // Coordinates outside any plausible world are refused too. Finite is not the same as sane: 1e308 passes
  // Number.isFinite, writes cleanly to SQLite, and renders as a map with one node and 2054 invisible ones.
  const wild = entries.find((e) => Math.abs(e.x) > 1e7 || Math.abs(e.y) > 1e7);
  if (wild) return { ok: false, error: `position out of range for ${wild.nodeId}` };
  if (knownIds) {
    const unknown = entries.find((e) => !knownIds.has(e.nodeId));
    if (unknown) return { ok: false, error: `no such node ${unknown.nodeId}` };
  }
  return { ok: true, entries };
}

export interface ServeDeps {
  /** Persist a layout the user explored and accepted. Explicit act; never a side effect of a control. */
  writeLayout: (payload: unknown) => { ok: boolean; written?: number; error?: string };
  /** The full exported page, regenerated per request so a drop is visible after reload. */
  renderPage: () => string;
  /** Ingest one file already on disk. Reports progress; resolves with the summary. */
  ingest: (path: string, display: { title: string; source: string }, onProgress: (p: IngestProgress) => void) => Promise<IngestProgress>;
  /** Reject a file the pipeline cannot read (extension allowlist). */
  isSupported: (filename: string) => boolean;
  readScenes: () => unknown;
  writeScenes: (payload: unknown) => { ok: true } | { ok: false; conflicts: string[] };
  /** Extraction debt, answerable at any time by any client — after a crash, from another terminal. */
  status?: () => ServeStatus;
  tempDir?: string;
}

export interface ServeOptions {
  port: number;
  deps: ServeDeps;
}

const ROUTES: Record<string, RouteKind> = {
  "/": "navigation",
  "/ingest": "api",
  "/events": "api",
  "/scenes": "api",
  "/layout": "api",
  "/status": "api",
};

/** Sweep stale uploads at startup: a SIGKILL cannot run a `finally`, so `finally` alone is not a guarantee. */
export function sweepTemp(dir: string, now = Date.now(), maxAge = TEMP_MAX_AGE_MS): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("tessera-upload-")) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > maxAge) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        /* raced with another sweep */
      }
    }
  } catch {
    /* dir absent */
  }
  return removed;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        // PAUSE, do not destroy. Destroying kills the socket before the 413 can be written, so a client
        // that streams past the cap gets a dropped connection instead of an error — found by a test that
        // sends a chunked upload with no Content-Length, which is the only path that reaches this guard.
        req.pause();
        reject(Object.assign(new Error(`upload exceeds ${limit} bytes`), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createTesseraServer(opts: ServeOptions): { server: Server; close: () => Promise<void> } {
  const { port, deps } = opts;
  // Every Host form the guard accepts must also be an acceptable Origin. Allowing `localhost:PORT` as a
  // Host while demanding Origin `http://127.0.0.1:PORT` meant opening http://localhost:7777 gave a page that
  // looked fine and a drop target that 403'd.
  const expectedOrigins = allowedHosts(port).map((h) => `http://${h}`);
  const expectedOrigin = expectedOrigins[0]!;
  const temp = deps.tempDir ?? join(tmpdir(), "tessera-serve");
  mkdirSync(temp, { recursive: true });
  sweepTemp(temp);

  // Single-flight: one ingest at a time. Concurrent ingests would interleave LLM calls against a serialised
  // SQLite writer and produce a confusing progress stream for both.
  let ingesting = false;
  const listeners = new Set<ServerResponse>();
  const MAX_LISTENERS = 8; // a page needs one; a runaway tab or local script should not open thousands

  const send = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  };

  const broadcast = (p: IngestProgress): void => {
    const line = `data: ${JSON.stringify(p)}\n\n`;
    for (const res of listeners) {
      try {
        res.write(line);
      } catch {
        listeners.delete(res);
      }
    }
  };

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", expectedOrigin);
      const path = url.pathname;
      const kind = ROUTES[path];
      if (kind === undefined) return send(res, 404, "not found");

      const verdict = guard(
        {
          method: req.method ?? "GET",
          host: req.headers.host,
          origin: Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin,
          secFetchSite: req.headers["sec-fetch-site"] as string | undefined,
          kind,
        },
        port,
        expectedOrigins,
      );
      if (!verdict.ok) return send(res, verdict.status ?? 403, `refused: ${verdict.reason}`);

      // A browser always sends Origin on a mutating request; its absence means a non-browser client, which
      // the threat model permits. Stated so the gap is deliberate rather than forgotten.
      if (isMutating(req.method ?? "GET") && req.headers.origin === undefined && req.headers["sec-fetch-site"] !== undefined) {
        return send(res, 403, "refused: browser request with no Origin on a mutating route");
      }

      try {
        if (path === "/" && req.method === "GET") return send(res, 200, deps.renderPage(), "text/html; charset=utf-8");

        if (path === "/scenes" && req.method === "GET") {
          return send(res, 200, JSON.stringify(deps.readScenes()), "application/json");
        }

        if (path === "/status" && req.method === "GET") {
          if (!deps.status) return send(res, 404, "status not available");
          return send(res, 200, JSON.stringify(deps.status()), "application/json");
        }

        if (path === "/layout" && req.method === "PUT") {
          // Persisting a layout the user explored and liked. Deliberately a SEPARATE, EXPLICIT act from
          // computing or applying one: a slider must never overwrite stored geometry as a side effect.
          const body = await readBody(req, MAX_UPLOAD_BYTES).catch((e: Error & { status?: number }) => {
            send(res, e.status ?? 400, e.message);
            return null;
          });
          if (body === null) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            return send(res, 400, "layout body is not valid JSON");
          }
          const r = deps.writeLayout(parsed);
          return send(res, r.ok ? 200 : 400, JSON.stringify(r), "application/json");
        }
        if (path === "/scenes" && req.method === "PUT") {
          // .catch here, not just on /ingest: readBody's rejection carries status 413, and without this it
          // fell through to the generic 500 handler. Same guard, both routes — fix the class, not the
          // instance, which is the recurrence this repo keeps naming.
          const body = await readBody(req, MAX_UPLOAD_BYTES).catch((e: Error & { status?: number }) => {
            send(res, e.status ?? 400, e.message);
            return null;
          });
          if (body === null) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            return send(res, 400, "scenes body is not valid JSON");
          }
          const r = deps.writeScenes(parsed);
          // ALL-OR-NOTHING: any stale version and nothing is applied, so the client and the db can never
          // diverge with no way to tell which half landed.
          if (!r.ok) return send(res, 409, JSON.stringify({ conflicts: r.conflicts }), "application/json");
          return send(res, 200, JSON.stringify({ ok: true }), "application/json");
        }

        if (path === "/events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          if (listeners.size >= MAX_LISTENERS) {
            res.end(": too many progress listeners\n\n");
            return;
          }
          res.write(": connected\n\n");
          listeners.add(res);
          req.on("close", () => listeners.delete(res));
          return;
        }

        if (path === "/ingest" && req.method === "POST") {
          // Claim SYNCHRONOUSLY. The check and the set used to straddle `await readBody`, so two same-origin
          // POSTs could both pass the check, both read their bodies, and both run the pipeline against one
          // graph. Every early return below must release, hence the try/finally around the whole handler.
          if (ingesting) return send(res, 409, "an ingest is already running");
          ingesting = true;
          let claimed = true;
          const release = (): void => { if (claimed) { claimed = false; ingesting = false; } };
          try {
          const declared = Number(req.headers["content-length"] ?? 0);
          if (declared > MAX_UPLOAD_BYTES) return send(res, 413, `upload exceeds ${MAX_UPLOAD_BYTES} bytes`);

          // The client filename is used ONLY for the extension check and the display title. It never
          // contributes to a filesystem path — the path is generated here.
          const rawName = String(req.headers["x-tessera-filename"] ?? "dropped.md");
          const filename = rawName.replace(/[\r\n]/g, "").slice(0, 200);
          if (!deps.isSupported(filename)) return send(res, 415, `unsupported file type: ${filename}`);

          const body = await readBody(req, MAX_UPLOAD_BYTES).catch((e: Error & { status?: number }) => {
            send(res, e.status ?? 400, e.message);
            return null;
          });
          if (body === null) return;
          if (body.length === 0) return send(res, 400, "empty upload");

          const ext = filename.toLowerCase().endsWith(".txt") ? ".txt" : ".md";
          const tmpPath = join(temp, `tessera-upload-${randomUUID()}${ext}`);
          try {
            writeFileSync(tmpPath, body);
            // `source` matters as much as `title`: without it readDoc() falls back to the resolved TEMP path,
            // which is then written into provenance.path and the ingest manifest permanently. A stable
            // synthetic source also means the same file dropped twice is recognised as the same document.
            const summary = await deps.ingest(tmpPath, { title: filename, source: `drop:${filename}` }, broadcast);
            broadcast({ ...summary, phase: "done" });
            return send(res, 200, JSON.stringify(summary), "application/json");
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            broadcast({ phase: "error", message });
            return send(res, 500, message);
          } finally {
            // every HANDLED exit path; a SIGKILL cannot run this, which is why sweepTemp exists
            rmSync(tmpPath, { force: true });
          }
          } finally {
            release();
          }
        }

        return send(res, 405, "method not allowed");
      } catch (e) {
        return send(res, 500, e instanceof Error ? e.message : String(e));
      }
    })();
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of listeners) {
          try { res.end(); } catch { /* already gone */ }
        }
        listeners.clear();
        // server.close() only stops NEW connections and waits for existing ones to end. With SSE streams and
        // keep-alive sockets that never happens, so ctrl-c on a live server would hang — the test suite hit
        // it as a 10s afterAll timeout, but a user would just see a terminal that will not come back.
        server.close(() => resolve());
        server.closeAllConnections?.();
        // last-resort: never let shutdown block indefinitely on a socket the runtime will not surrender
        const t = setTimeout(() => resolve(), 2000);
        t.unref?.();
      }),
  };
}

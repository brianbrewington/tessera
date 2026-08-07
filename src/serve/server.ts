// `tessera serve` (design §7) — the drop target, and tessera's first inbound socket.
//
// node:http only; no new runtime dependencies. Binds 127.0.0.1 explicitly, never 0.0.0.0. Every route runs
// through the measured header guard (src/serve/guard.ts) — see that file before changing anything here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { guard, isMutating, type RouteKind } from "./guard.js";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface IngestProgress {
  phase: "chunk" | "done" | "error";
  i?: number;
  of?: number;
  chunks?: number;
  entities?: number;
  edges?: number;
  laidOut?: number;
  message?: string;
}

/** Everything the server needs, injected so tests never need a real graph, LLM, or embedder. */
export interface ServeDeps {
  /** The full exported page, regenerated per request so a drop is visible after reload. */
  renderPage: () => string;
  /** Ingest one file already on disk. Reports progress; resolves with the summary. */
  ingest: (path: string, display: { title: string }, onProgress: (p: IngestProgress) => void) => Promise<IngestProgress>;
  /** Reject a file the pipeline cannot read (extension allowlist). */
  isSupported: (filename: string) => boolean;
  readScenes: () => unknown;
  writeScenes: (payload: unknown) => { ok: true } | { ok: false; conflicts: string[] };
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
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`upload exceeds ${limit} bytes`), { status: 413 }));
        req.destroy();
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
  const expectedOrigin = `http://127.0.0.1:${port}`;
  const temp = deps.tempDir ?? join(tmpdir(), "tessera-serve");
  mkdirSync(temp, { recursive: true });
  sweepTemp(temp);

  // Single-flight: one ingest at a time. Concurrent ingests would interleave LLM calls against a serialised
  // SQLite writer and produce a confusing progress stream for both.
  let ingesting = false;
  const listeners = new Set<ServerResponse>();

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
        expectedOrigin,
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

        if (path === "/scenes" && req.method === "PUT") {
          const body = await readBody(req, MAX_UPLOAD_BYTES);
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
          res.write(": connected\n\n");
          listeners.add(res);
          req.on("close", () => listeners.delete(res));
          return;
        }

        if (path === "/ingest" && req.method === "POST") {
          if (ingesting) return send(res, 409, "an ingest is already running");
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
          ingesting = true;
          try {
            writeFileSync(tmpPath, body);
            const summary = await deps.ingest(tmpPath, { title: filename }, broadcast);
            broadcast({ ...summary, phase: "done" });
            return send(res, 200, JSON.stringify(summary), "application/json");
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            broadcast({ phase: "error", message });
            return send(res, 500, message);
          } finally {
            // every HANDLED exit path; a SIGKILL cannot run this, which is why sweepTemp exists
            rmSync(tmpPath, { force: true });
            ingesting = false;
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
        for (const res of listeners) res.end();
        listeners.clear();
        server.close(() => resolve());
      }),
  };
}

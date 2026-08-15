// CLI half of `tessera serve` — wires the server to a real graph. Kept out of cli.ts so the server can be
// tested with injected deps and no LLM.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTesseraServer, type IngestProgress, type ServeStatus } from "../src/serve/server.js";
import { Graph } from "../src/graph.js";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { OllamaChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestChunks } from "../src/ingest/ingest.js";
import { extractPending, FAILING_ATTEMPTS } from "../src/ingest/extract-pending.js";
import { PROMPT_VERSION } from "../src/extract/extractor.js";
import { isSupported } from "../src/ingest/adapters.js";
import { layoutPass } from "../src/layout/pass.js";
import { validateLayoutPayload } from "../src/serve/server.js";
import { prominencePass } from "../src/graph/prominence-pass.js";
import { exportViewer } from "./export-viewer.js";
import { contentKey } from "../src/scenes/scene.js";
import { acquireIngestLock, LockHeld } from "../src/serve/lock.js";

export interface ServeCliOptions { name: string; port: number; graphDir: string; db: string }

/**
 * Owns the drain's single-flight state, so that "a drop landed while a drain was running" is a fact the
 * coordinator holds rather than a race between two booleans in a closure.
 *
 * Both cross-agent reviewers found the same hole independently: `startDrain` no-ops when a drain is already
 * running, and the running drain's last "is anything left?" check can precede the newer chunks. The second
 * file of a multi-file drop — the ordinary path, since the viewer posts sequentially — could be chunked,
 * counted, and then never extracted. The inner loop does not help: it re-asks the database, but the zero it
 * sees predates the arrival.
 *
 * Exported and used by exactly one caller, so a test of this object IS a test of the call site. A previous
 * attempt tested a hand-written model of this logic instead, which would have stayed green with the real
 * coordinator unwired.
 */
export function createDrainCoordinator(runPass: () => Promise<void>): {
  request: () => void;
  isRunning: () => boolean;
} {
  let running = false;
  let pending = false;
  const request = (): void => {
    if (running) { pending = true; return; }   // remember it; do not drop it
    running = true;
    void (async (): Promise<void> => {
      try {
        do {
          pending = false;                     // clear BEFORE the pass, so arrivals during it are kept
          await runPass();
        } while (pending);
      } finally { running = false; }
    })();
  };
  return { request, isRunning: () => running };
}

/**
 * Should the background drain take another pass?
 *
 * Yes only if the last round made progress AND work remains. Both halves are load-bearing:
 *  - "work remains" alone would spin forever on chunks the drain is not allowed to touch (a poison chunk
 *    past FAILING_ATTEMPTS stays dirty by design, so `remaining > 0` is permanently true).
 *  - "made progress" alone would stop while chunks queued mid-drain sat untouched.
 */
export function shouldDrainAgain(extractedThisRound: number, remaining: number): boolean {
  return extractedThisRound > 0 && remaining > 0;
}

/**
 * The dependency bundle, extracted so the SERVE call site of the advisory lock is reachable from a test.
 * It was not, and unwiring it left the whole suite green — half of the one-sided-lock defect could revert.
 */
export function serveDeps(opts: ServeCliOptions): Parameters<typeof createTesseraServer>[0]["deps"] {
  const out = join(opts.graphDir, "view.html");
  // Whether a drain is running IN THIS PROCESS. Not the queue — the queue is `chunk NOT IN extracted_chunks`,
  // a durable SQLite predicate that survives a crash and is answerable by any process. This flag exists only
  // so `GET /status` can distinguish "owed and being worked on" from "owed and nobody is on it", and so two
  // drops in quick succession do not start two drains.
  const drainState = { running: false };
  // Set by the coordinator below; `startDrain` becomes a thin request into it.
  let drainCoordinator: { request: () => void; isRunning: () => boolean } | null = null;

  /**
   * Work the dirty queue in the background after a drop.
   *
   * This is not the job queue the design deferred (§7.5). There is no queue object to lose: the drain is a
   * loop that repeatedly asks the database what is owed, which is exactly what `tessera extract` does. The
   * only difference is who starts the loop.
   */
  const startDrain = (onProgress: (p: IngestProgress) => void): void => {
    // One coordinator per deps bundle. A request that lands mid-pass is REMEMBERED, not dropped, which is
    // the defect both reviewers found: the second file of a multi-file drop could be chunked and never
    // extracted, because the running drain's last "anything left?" check predated its chunks.
    drainCoordinator ??= createDrainCoordinator(async () => { await onePass(onProgress); });
    drainCoordinator.request();
    drainState.running = drainCoordinator.isRunning();
  };

  const onePass = (onProgress: (p: IngestProgress) => void): Promise<void> => {
    drainState.running = true;
    return (async (): Promise<void> => {
      let graph: ReturnType<typeof Graph.open> | undefined;
      const total = { extracted: 0, entities: 0, edges: 0, parseFailures: 0, errors: 0 };
      try {
        graph = Graph.open(opts.name);
        const extractorModel = process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b";
        const extractor = new LlmExtractor(new OllamaChat(extractorModel), { temperature: 0.4 });
        // LOOP until dry. extractPending processes the snapshot it took when it started, so a second drop
        // arriving mid-drain would queue chunks this drain never looks at — and startDrain's own
        // already-running guard means no new drain starts for them either. They would sit dirty until the
        // next drop or an explicit `tessera extract`, which is precisely the silent debt this batch exists
        // to abolish.
        for (;;) {
          const r = await extractPending(graph, extractor, {
            // Never-extracted chunks only. Re-extracting a whole corpus because PROMPT_VERSION changed is a
            // decision worth 33 minutes of someone's GPU — it should not be triggered by dropping a file.
            includeStale: false,
            // The poison guard: a chunk the model cannot parse must not be retried on every drop forever.
            // `tessera extract --retry-failed` is how a human reaches it.
            maxAttempts: FAILING_ATTEMPTS,
            onChunk: (done, n) => onProgress({ phase: "extract", i: done, of: n }),
          });
          total.extracted += r.extracted; total.entities += r.entities; total.edges += r.edges;
          total.parseFailures += r.parseFailures; total.errors += r.errors;
          const remaining = graph.store.dirtyCounts(PROMPT_VERSION).never;
          if (!shouldDrainAgain(r.extracted, remaining)) break;
        }
        if (total.extracted > 0) {
          // The passes ARE lock-worthy: they read the whole graph and write a batch. If a CLI ingest holds
          // the lock, skip them rather than queueing — both passes are idempotent and the next `tessera view`
          // or extract run does the work.
          //
          // Their own try/catch: a pass failing AFTER a successful extraction is not an extraction failure,
          // and reporting it as one tells the user their chunks were lost when they are safely in the graph.
          try {
            const release = acquireIngestLock(opts.graphDir, `serve drain ${opts.name}`);
            try {
              await layoutPass(graph.store, { actor: "serve", cause: `drain ${opts.name}` });
              prominencePass(graph.store, { actor: "serve", cause: `drain ${opts.name}` });
            } finally { release(); }
          } catch (e) {
            if (!(e instanceof LockHeld)) {
              console.error(`drain: extraction succeeded but the layout/prominence pass failed — ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        onProgress({
          phase: "done", entities: total.entities, edges: total.edges,
          dirty: graph.store.dirtyCounts(PROMPT_VERSION).dirty,
          message: total.parseFailures || total.errors
            ? `${total.extracted} extracted, ${total.parseFailures + total.errors} could not be extracted — see: tessera report ${opts.name}`
            : undefined,
        });
      } catch (e) {
        onProgress({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        drainState.running = false;
        try { graph?.close(); } catch { /* already closing */ }
      }
    })();
  };

  return {
      /**
       * Persist a layout. Validated hard because this is the ONE path where a browser control can overwrite
       * geometry the CLI computed: every id must exist and every coordinate must be finite, and putLayoutBatch
       * enforces both again inside one transaction so a partial apply is impossible.
       */
      writeLayout: (payload: unknown): { ok: boolean; written?: number; error?: string } => {
        try {
          const g = Graph.open(opts.name);
          try {
            // Ids are validated against the graph HERE rather than left to putLayoutBatch, so an unknown id is
            // a clean 400 naming the offender instead of an opaque throw after the user already applied.
            const known = new Set(g.store.allNodes().map((n) => n.id));
            const v = validateLayoutPayload(payload, known);
            if (!v.ok) return { ok: false, error: v.error };
            const r = g.store.putLayoutBatch(v.entries, { actor: "serve", cause: `layout accepted from viewer (${opts.name})` });
            return { ok: true, written: typeof r === "number" ? r : v.entries.length };
          } finally { g.close(); }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      renderPage: () => {
        exportViewer(opts.db, out, opts.name);
        return readFileSync(out, "utf8");
      },
      isSupported,
      /**
       * QUEUE ONLY. Reads, chunks, writes, returns. No LLM call, so the response is fast and honest: it says
       * how many chunks are owed rather than holding an HTTP request and an SSE stream open for six minutes
       * while pretending that is progress.
       *
       * The advisory lock is therefore held for milliseconds plus embedding, not for the whole extraction.
       * That is what makes the accepted 6-hour staleness risk (B25) unreachable rather than merely unlikely.
       */
      ingest: async (path, display, onProgress): Promise<IngestProgress> => {
        // Take the lock only WHILE chunking, not for the whole serve session — otherwise a running server
        // blocks every CLI ingest even when idle, which is stricter than the design and still not mutual.
        let release: () => void;
        try {
          release = acquireIngestLock(opts.graphDir, `serve drop ${display.title}`);
        } catch (e) {
          if (e instanceof LockHeld) throw new Error(`${e.message} — try again once it finishes`);
          throw e;
        }
        // Graph.open MUST be inside the try: it used to sit between acquire and the finally, so a throw
        // there (db deleted mid-session, SQLITE_BUSY at open) leaked the lock for six hours — held by the
        // LIVE serve pid, so dead-holder reclaim could never rescue it, and the error blamed a process that
        // was not ingesting anything.
        let graph: ReturnType<typeof Graph.open> | undefined;
        let queued = 0;
        try {
          graph = Graph.open(opts.name);
          const extractorModel = process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b";
          const r = await ingestChunks(graph, path, {
            extractorModel, display,
            onChunk: (done, total) => onProgress({ phase: "chunk", i: done, of: total }),
          });
          const lay = await layoutPass(graph.store, { actor: "serve", cause: `drop ${display.title}` });
          const dirty = graph.store.dirtyCounts(PROMPT_VERSION).dirty;
          queued = r.queued;
          return { phase: "done", chunks: r.chunks, queued: r.queued, dirty, laidOut: lay.laidOut, skipped: r.skipped };
        } finally {
          // release FIRST: a throwing close must not skip it
          release();
          try { graph?.close(); } catch { /* already closing */ }
          // Start the drain AFTER the lock is released and the response is on its way, so the drop stays
          // fast and the extraction cost is paid out of band.
          if (queued > 0) startDrain(onProgress);
        }
      },
      status: (): ServeStatus => {
        const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
        try {
          return { ...s.dirtyCounts(PROMPT_VERSION, FAILING_ATTEMPTS), draining: drainState.running };
        } finally { s.close(); }
      },
      readScenes: () => {
        const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
        try { return { scenes: s.allScenes() }; } finally { s.close(); }
      },
      /**
       * A real sync, not an import: creates new scenes, reorders existing ones, and deletes what the client
       * explicitly asked to delete. importScenes alone is insert-only, so a served viewer could previously
       * never delete or reorder anything — the × on each scene chip would have looked like it worked and the
       * scene would return on reload.
       *
       * Deletions come from an explicit `deletes` list rather than from absence in `scenes`. Absence is a
       * dangerous signal: a truncated or half-built payload would silently wipe every saved view, including
       * the tour narration, which is the only human-authored prose in the system.
       */
      writeScenes: (payload) => {
        const body = payload as { scenes?: Array<Record<string, unknown>>; deletes?: unknown };
        if (!Array.isArray(body.scenes)) return { ok: false, conflicts: ["malformed payload"] };
        const deletes = Array.isArray(body.deletes) ? body.deletes.map(String) : [];
        const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
        try {
          const existing = new Map(s.allScenes().map((x) => [x.id, x.version]));
          const conflicts = body.scenes
            .filter((sc) => sc.id !== undefined && existing.has(String(sc.id)) && Number(sc.version) !== existing.get(String(sc.id)))
            .map((sc) => String(sc.id));
          if (conflicts.length) return { ok: false, conflicts };

          const meta = { actor: "serve", cause: "PUT /scenes" };

          // Resolve everything FIRST, then apply as one transaction. The order resolution needs post-insert
          // ids for brand-new scenes, so it runs inside syncScenes' transaction via a two-step: create, then
          // read back by content key, then order. Doing it as three separate store calls meant a throw after
          // the deletes left scenes permanently gone, under a comment promising all-or-nothing.
          const fresh = body.scenes.filter((sc) => sc.id === undefined || !existing.has(String(sc.id)));
          const parsed = fresh.map((sc, i) => {
            const e = {
              name: String(sc.name ?? `scene ${i + 1}`), narr: (sc.narr as string | null) ?? null,
              scale: Number(sc.scale ?? 1), showProv: !!sc.showProv,
              focusNode: (sc.focusNode as string | null) ?? null,
              anchors: Array.isArray(sc.anchors) ? (sc.anchors as string[]) : [],
              legacyId: (sc.legacyId as string | null) ?? null,
              ordinal: Number.isFinite(sc.ordinal) ? Number(sc.ordinal) : i,
            };
            return { ...e, contentKey: contentKey(e) };
          });
          const wantKeys = body.scenes.map((sc, i) => ({
            id: sc.id !== undefined && existing.has(String(sc.id)) ? String(sc.id) : null,
            key: contentKey({
              name: String(sc.name ?? `scene ${i + 1}`), narr: (sc.narr as string | null) ?? null,
              scale: Number(sc.scale ?? 1), showProv: !!sc.showProv,
              focusNode: (sc.focusNode as string | null) ?? null,
              anchors: Array.isArray(sc.anchors) ? (sc.anchors as string[]) : [],
            }),
          }));
          s.syncScenesResolved(deletes, parsed, wantKeys, meta);
          return { ok: true };
        } finally { s.close(); }
      },
  };
}

export async function serveCli(opts: ServeCliOptions): Promise<void> {
  const { server, close } = createTesseraServer({ port: opts.port, deps: serveDeps(opts) });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", () => resolve()));
  console.log(`tessera serve — http://127.0.0.1:${opts.port}  (graph '${opts.name}')`);
  console.log(`  drop a .md or .txt onto the map to ingest it.  ctrl-c to stop.`);
  // Say what is owed at startup. Extraction debt was invisible for months on graphs/big; a server that knows
  // and stays quiet about it is the same failure with better uptime.
  {
    const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
    try {
      // An EMPTY graph served in silence is the worst version of this: the page renders, the pill says
      // "0 nodes", and nothing distinguishes "your ingest failed" from "you are looking at the wrong graph".
      // Brian hit exactly that, having ingested into one graph and served another.
      const nodeCount = s.countNodes();
      if (nodeCount === 0) {
        console.log(`  NOTE: '${opts.name}' is EMPTY — 0 nodes. This page will render a blank map.`);
        const others = Graph.list().filter((x) => x.name !== opts.name && x.nodes > 0);
        if (others.length) {
          console.log(`        graphs with content: ${others.map((x) => `${x.name} (${x.nodes} nodes)`).join(", ")}`);
          console.log(`        ctrl-c and:  tessera serve <one of those>`);
        }
      }
      const d = s.dirtyCounts(PROMPT_VERSION, FAILING_ATTEMPTS);
      if (d.dirty > 0) {
        console.log(`  note: ${d.dirty} of ${d.chunks} chunk(s) are not yet extracted — this map is incomplete.`);
        console.log(`        a drop extracts new chunks in the background; for the rest:  tessera extract ${opts.name}`);
        if (d.failing > 0) console.log(`        ${d.failing} chunk(s) failing after ${FAILING_ATTEMPTS}+ attempts — tessera extract ${opts.name} --retry-failed`);
      }
    } finally { s.close(); }
  }

  const shutdown = async (): Promise<void> => { await close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

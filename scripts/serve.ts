// CLI half of `tessera serve` — wires the server to a real graph. Kept out of cli.ts so the server can be
// tested with injected deps and no LLM.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTesseraServer, type IngestProgress } from "../src/serve/server.js";
import { Graph } from "../src/graph.js";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { OllamaChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { isSupported } from "../src/ingest/adapters.js";
import { layoutPass } from "../src/layout/pass.js";
import { prominencePass } from "../src/graph/prominence-pass.js";
import { exportViewer } from "./export-viewer.js";
import { contentKey } from "../src/scenes/scene.js";

export interface ServeCliOptions { name: string; port: number; graphDir: string; db: string }

/** Advisory lock so a CLI `ingest` and a served drop cannot write the same graph at once. */
function takeLock(dir: string): () => void {
  const lock = join(dir, ".ingest.lock");
  if (existsSync(lock)) {
    const age = Date.now() - Number(readFileSync(lock, "utf8").trim() || 0);
    if (age < 6 * 60 * 60 * 1000) throw new Error(`another tessera process holds ${lock} — refusing to serve`);
    rmSync(lock, { force: true }); // stale
  }
  writeFileSync(lock, String(Date.now()));
  return () => rmSync(lock, { force: true });
}

export async function serveCli(opts: ServeCliOptions): Promise<void> {
  const release = takeLock(opts.graphDir);
  const out = join(opts.graphDir, "view.html");

  const { server, close } = createTesseraServer({
    port: opts.port,
    deps: {
      renderPage: () => {
        exportViewer(opts.db, out, opts.name);
        return readFileSync(out, "utf8");
      },
      isSupported,
      ingest: async (path, display, onProgress): Promise<IngestProgress> => {
        const graph = Graph.open(opts.name);
        try {
          const extractorModel = process.env.TESSERA_EXTRACT_MODEL || "qwen2.5:14b";
          const extractor = new LlmExtractor(new OllamaChat(extractorModel), { temperature: 0.4 });
          const r = await ingestFile(graph, extractor, path, {
            extractorModel, display,
            onChunk: (done, total) => onProgress({ phase: "chunk", i: done, of: total }),
          });
          const lay = await layoutPass(graph.store, { actor: "serve", cause: `drop ${display.title}` });
          prominencePass(graph.store, { actor: "serve", cause: `drop ${display.title}` });
          return { phase: "done", chunks: r.chunks, entities: r.entities, edges: r.edges, laidOut: lay.laidOut };
        } finally {
          graph.close();
        }
      },
      readScenes: () => {
        const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
        try { return { scenes: s.allScenes() }; } finally { s.close(); }
      },
      writeScenes: (payload) => {
        const body = payload as { scenes?: Array<Record<string, unknown>> };
        if (!Array.isArray(body.scenes)) return { ok: false, conflicts: ["malformed payload"] };
        const s = new GraphStore({ path: opts.db, embedder: new StubEmbedder(768) });
        try {
          const existing = new Map(s.allScenes().map((x) => [x.id, x.version]));
          const conflicts = body.scenes
            .filter((sc) => sc.id !== undefined && existing.has(String(sc.id)) && Number(sc.version) !== existing.get(String(sc.id)))
            .map((sc) => String(sc.id));
          if (conflicts.length) return { ok: false, conflicts };
          const parsed = body.scenes.map((sc, i) => {
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
          s.importScenes(parsed, { actor: "serve", cause: "PUT /scenes" });
          return { ok: true };
        } finally { s.close(); }
      },
    },
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", () => resolve()));
  console.log(`tessera serve — http://127.0.0.1:${opts.port}  (graph '${opts.name}')`);
  console.log(`  drop a .md or .txt onto the map to ingest it.  ctrl-c to stop.`);

  const shutdown = async (): Promise<void> => { await close(); release(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

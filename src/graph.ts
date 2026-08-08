// Named, persistent graph — the unit Brian addresses ("one graph for personas, another for book ideas").
// A name resolves to a persistent SQLite db at graphs/<name>/graph.db, with a self-describing meta.json
// sidecar. Wraps GraphStore and exposes reads as object-model value objects. Minimal: create/open/list only
// (rename/merge/delete → backlog).
import Database from "better-sqlite3";
import { GraphStore } from "./store/graphStore.js";
import { PROMPT_VERSION } from "./extract/extractor.js";
import { OllamaEmbedder, type Embedder } from "./embedder.js";
import { hydrateNode, Node, Edge, Assertion } from "./model.js";
import { mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GRAPHS_DIR = join(HERE, "..", "graphs");

const dbPath = (name: string): string => join(GRAPHS_DIR, name, "graph.db");
const metaPath = (name: string): string => join(GRAPHS_DIR, name, "meta.json");

function defaultEmbedder(): Embedder {
  // installs vary (nomic-embed-text vs embeddinggemma); both are 768-dim so the vec tables match either.
  return new OllamaEmbedder(768, process.env.TESSERA_EMBED_MODEL || "nomic-embed-text");
}

export class Graph {
  private constructor(readonly name: string, readonly store: GraphStore, readonly embedder: Embedder) {}

  /** Open (creating if absent) a named graph. Pass an embedder for tests (defaults to Ollama). */
  static open(name: string, embedder?: Embedder): Graph {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid graph name: ${name}`);
    mkdirSync(dirname(dbPath(name)), { recursive: true });
    if (!existsSync(metaPath(name))) {
      writeFileSync(metaPath(name), JSON.stringify({ name, created: new Date().toISOString() }, null, 1));
    }
    const emb = embedder ?? defaultEmbedder();
    return new Graph(name, new GraphStore({ path: dbPath(name), embedder: emb }), emb);
  }

  /** Wrap an existing store + embedder as a Graph (tests use an in-memory store). */
  static attach(store: GraphStore, embedder: Embedder, name = "test"): Graph {
    return new Graph(name, store, embedder);
  }

  /**
   * Every graph with its size. The `nodes` field was declared here and never populated, so `graph list`
   * printed bare names — which is how you ingest into one graph, serve another, and conclude the ingest
   * failed. A listing that cannot answer "which one has my work in it" is not a listing.
   *
   * Read-only and deliberately NOT through GraphStore: opening a store runs migrations, and listing must
   * never write. Counts are version-agnostic for the same reason (an old db may predate a column).
   */
  static list(): { name: string; nodes: number; edges: number; owed: number; versionAware: boolean }[] {
    if (!existsSync(GRAPHS_DIR)) return [];
    return readdirSync(GRAPHS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(dbPath(d.name)))
      .map((d) => {
        const out = { name: d.name, nodes: 0, edges: 0, owed: 0, versionAware: false };
        try {
          const db = new Database(dbPath(d.name), { readonly: true, fileMustExist: true });
          try {
            const one = (sql: string): number => ((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
            out.nodes = one("SELECT count(*) AS n FROM nodes");
            out.edges = one("SELECT count(*) AS n FROM edges");
            // Version-aware where the column exists. It was deliberately version-agnostic so an old db
            // predating `prompt_version` would still list, but that made the column silently undercount:
            // after a PROMPT_VERSION bump the listing said "-" while `tessera extract` still had a corpus
            // of stale work, and an operator would reasonably read that as current. Fall back only when the
            // column is genuinely absent, and say which reading you got.
            const hasVersion = (db.prepare("PRAGMA table_info(extracted_chunks)").all() as Array<{ name: string }>)
              .some((c) => c.name === "prompt_version");
            out.versionAware = hasVersion;
            out.owed = hasVersion
              ? one(
                  `SELECT count(*) AS n FROM nodes n
                   LEFT JOIN extracted_chunks e ON e.chunk_id = n.id
                   WHERE n.subtype IN ('chunk','turn')
                     AND (e.chunk_id IS NULL OR e.prompt_version IS NOT '${PROMPT_VERSION}')`,
                )
              : one(
                  `SELECT count(*) AS n FROM nodes n
                   LEFT JOIN extracted_chunks e ON e.chunk_id = n.id
                   WHERE n.subtype IN ('chunk','turn') AND e.chunk_id IS NULL`,
                );
          } finally { db.close(); }
        } catch { /* unreadable or mid-write: report zeros rather than failing the whole listing */ }
        return out;
      });
  }

  meta(): { name: string; created?: string } {
    try { return JSON.parse(readFileSync(metaPath(this.name), "utf8")); } catch { return { name: this.name }; }
  }

  nodes(): Node[] {
    return this.store.allNodes().map(hydrateNode);
  }

  /** Edges hydrated with their explanation assertion(s) — the Edge-owns-Assertions object relationship. */
  edges(): Edge[] {
    return this.store.allEdges().map((e) => new Edge(e, [new Assertion(this.store.edgeReason(e.id) ?? "", "ingest")]));
  }

  close(): void {
    this.store.close();
  }
}

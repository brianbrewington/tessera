// Named, persistent graph — the unit Brian addresses ("one graph for personas, another for book ideas").
// A name resolves to a persistent SQLite db at graphs/<name>/graph.db, with a self-describing meta.json
// sidecar. Wraps GraphStore and exposes reads as object-model value objects. Minimal: create/open/list only
// (rename/merge/delete → backlog).
import { GraphStore } from "./store/graphStore.js";
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

  static list(): { name: string; nodes?: number }[] {
    if (!existsSync(GRAPHS_DIR)) return [];
    return readdirSync(GRAPHS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(dbPath(d.name)))
      .map((d) => ({ name: d.name }));
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

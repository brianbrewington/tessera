// Build a real graph from the notes corpus: ingest -> analytic connect -> a .db file.
// Usage: npx tsx scripts/build-graph.ts [notesDir] [dbPath]
import { rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { OllamaEmbedder } from "../src/embedder.js";
import { readNotes, ingestNotes } from "../src/ingest/markdown.js";
import { connect } from "../src/connect/connector.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES = process.argv[2] ?? "/Users/brew/Documents/obsidian_attention/Attention";
const DB = process.argv[3] ?? `${here}/../data/tessera.db`;

mkdirSync(dirname(DB), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });

const t0 = Date.now();
const store = new GraphStore({ path: DB, embedder: new OllamaEmbedder(768, "embeddinggemma") });

const notes = readNotes(NOTES);
console.log(`read ${notes.length} notes from ${NOTES}`);
await ingestNotes(store, notes, { actor: "ingest", cause: "build-graph" });
console.log(`ingested ${store.countNodes()} nodes  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const created = await connect(store, { k: 6, threshold: 0.55 });
console.log(`connected: ${store.countEdges()} edges (created ${created})  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

store.close();
console.log(`db written -> ${DB}`);

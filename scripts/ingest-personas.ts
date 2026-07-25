// Ingest a directory of persona docs (.md/.txt) into a fresh graph, then run the
// RESONATES_WITH pass, and write a .db the viewer can export.
//
// Usage: npx tsx scripts/ingest-personas.ts <personasDir> [dbPath] [--embedder stub|ollama]
//   --embedder ollama  (default) real embeddinggemma vectors — needs Ollama running.
//   --embedder stub    offline, deterministic StubEmbedder(768) — runs anywhere (airgap).
//
// After this, browse with:
//   npx tsx scripts/export-viewer.ts <dbPath> viewer/personas.html
import { readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder, OllamaEmbedder, type Embedder } from "../src/embedder.js";
import { parsePersona, ingestPersona, connectResonance } from "../src/ingest/persona.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = process.argv.slice(2);
// Pull `--embedder <value>` / `--embedder=<value>` / bare `--stub` out of argv first.
let embFlag: string | undefined;
const positional: string[] = [];
for (let i = 0; i < raw.length; i++) {
  const a = raw[i]!;
  if (a === "--stub") embFlag = "stub";
  else if (a.startsWith("--embedder=")) embFlag = a.split("=")[1];
  else if (a === "--embedder") embFlag = raw[++i];
  else positional.push(a);
}
const DIR = positional[0] ?? `${here}/../test/fixtures/personas`;
const DB = positional[1] ?? `${here}/../data/personas.db`;

const useStub = embFlag === "stub" || process.env.TESSERA_EMBEDDER === "stub";
// The Ollama embed model is configurable (TESSERA_EMBED_MODEL) — installs vary (embeddinggemma vs
// nomic-embed-text); both are 768-dim so the vec tables match either way.
const embModel = process.env.TESSERA_EMBED_MODEL || "embeddinggemma"; // || not ??: also fall back on empty string
const embedder: Embedder = useStub ? new StubEmbedder(768) : new OllamaEmbedder(768, embModel);
console.log(`embedder: ${useStub ? "StubEmbedder(768) [offline]" : `OllamaEmbedder(${embModel})`}`);

mkdirSync(dirname(DB), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });

const store = new GraphStore({ path: DB, embedder });
const files = readdirSync(DIR).filter((f) => f.endsWith(".txt") || f.endsWith(".md"));
const t0 = Date.now();

let ingested = 0;
for (const f of files) {
  try {
    const doc = parsePersona(readFileSync(join(DIR, f), "utf8"));
    await ingestPersona(store, embedder, doc, basename(f), { actor: "ingest", cause: "ingest-personas" });
    ingested++;
  } catch (e) {
    console.warn(`skip ${f}: ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log(`ingested ${ingested}/${files.length} personas -> ${store.countNodes()} nodes  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const resonance = await connectResonance(store, { actor: "resonance", cause: "ingest-personas" });
console.log(`edges: ${store.countEdges()} total (${resonance} RESONATES_WITH)  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

store.close();
console.log(`db written -> ${DB}`);

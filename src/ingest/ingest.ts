// Ingest orchestrator — the tracer's spine: open graph -> read adapter -> chunk -> extract -> map. One doc
// becomes a SOURCE node + its typed entity/relation graph, with node-reuse across the doc's chunks.
import type { Graph } from "../graph.js";
import type { Extractor } from "../extract/extractor.js";
import type { Meta } from "../schema.js";
import { readDoc, isSupported } from "./adapters.js";
import { chunk } from "./chunker.js";
import { mapExtraction } from "./mapper.js";

export interface IngestResult {
  source: string;
  title: string;
  chunks: number;
  entities: number;
  edges: number;
}

export async function ingestFile(graph: Graph, extractor: Extractor, path: string): Promise<IngestResult> {
  if (!isSupported(path)) throw new Error(`unsupported format: ${path} — tracer ingests .txt/.md only`);
  const doc = readDoc(path);
  const meta: Meta = { actor: "ingest", cause: `ingest ${doc.source}` };

  // one SOURCE node per document (provenance anchor).
  const src = await graph.store.putNode(
    { type: "SOURCE", subtype: "document", origin: "ingest", text: doc.title, provenance: { path: doc.source }, metadata: { name: doc.title, path: doc.source } },
    meta,
  );

  const chunks = chunk(doc.text);
  const known = new Map<string, string>();
  let entities = 0;
  let edges = 0;
  for (const c of chunks) {
    const ex = await extractor.extract(c.text);
    const r = await mapExtraction(graph.store, meta, ex, known, { id: src.id, title: doc.title });
    entities += r.entityCount;
    edges += r.edgeCount;
  }
  return { source: doc.source, title: doc.title, chunks: chunks.length, entities, edges };
}

// Ingest orchestrator (per docs/ingest-model.md): open graph -> read adapter -> chunk -> per chunk
// {CHUNK node (raw text, embedded = the RAG unit) -> ORIGINATED_FROM the SOURCE; extract -> map entities,
// each APPEARED_IN this chunk}. SOURCE is keyed by PATH; SOURCE/CHUNK use nearDupMerge:false so similar
// content never collapses distinct identities. Reports parse failures vs empty chunks (fail-loud).
import type { Graph } from "../graph.js";
import type { Extractor } from "../extract/extractor.js";
import type { Meta } from "../schema.js";
import { readDoc, isSupported } from "./adapters.js";
import { chunk as splitChunks } from "./chunker.js";
import { mapExtraction } from "./mapper.js";
import { sourceIdentity, chunkIdentity } from "../extract/identity.js";

const IDENTITY = { nearDupMerge: false } as const; // ingest owns identity via content_hash; no cosine merge

export interface IngestResult {
  source: string;
  title: string;
  chunks: number;
  entities: number;
  edges: number;
  parseFailures: number; // chunks whose model reply couldn't be parsed
  emptyChunks: number; // chunks that parsed but extracted nothing
}

export async function ingestFile(graph: Graph, extractor: Extractor, path: string): Promise<IngestResult> {
  if (!isSupported(path)) throw new Error(`unsupported format: ${path} — tracer ingests .txt/.md only`);
  const doc = readDoc(path);
  const meta: Meta = { actor: "ingest", cause: `ingest ${doc.source}` };

  // SOURCE node — identity is the PATH (title is display); a re-ingest reinforces the same source.
  const srcVec = await graph.embedder.embed(doc.title);
  const src = await graph.store.putNode(
    {
      type: "SOURCE", subtype: "document", origin: "ingest",
      text: sourceIdentity(doc.source), name: doc.title, description: `Document: ${doc.title}`,
      provenance: { path: doc.source },
    },
    meta, srcVec, IDENTITY,
  );

  const chunks = splitChunks(doc.text);
  const known = new Map<string, string>();
  let entities = 0, edges = 0, parseFailures = 0, emptyChunks = 0;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const label = `chunk ${i + 1} of ${doc.title}`;
    // CHUNK node — raw text is the retrievable body, embedded ON the raw text (the RAG unit).
    const cvec = await graph.embedder.embed(c.text.slice(0, 6000));
    const chunkNode = await graph.store.putNode(
      {
        type: "SOURCE", subtype: "chunk", origin: "ingest",
        text: chunkIdentity(doc.source, c.text), name: label, description: c.text,
        provenance: { path: doc.source, index: i },
      },
      meta, cvec, IDENTITY,
    );
    await graph.store.putEdge(
      { from: chunkNode.id, to: src.id, kind: "ORIGINATED_FROM", reason: `${label} is from ${doc.title}`, origin: "ingest" },
      meta,
    );

    const { extraction, parsed } = await extractor.extract(c.text);
    if (!parsed) parseFailures++;
    else if (extraction.entities.length === 0 && extraction.relations.length === 0) emptyChunks++;
    const r = await mapExtraction(graph.store, graph.embedder, meta, extraction, doc.source, known, { id: chunkNode.id, label });
    entities += r.entityCount;
    edges += r.edgeCount;
  }

  return { source: doc.source, title: doc.title, chunks: chunks.length, entities, edges, parseFailures, emptyChunks };
}

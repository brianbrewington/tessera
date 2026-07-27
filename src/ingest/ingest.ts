// Ingest orchestrator (per docs/ingest-model.md): open graph -> read adapter -> chunk -> per chunk
// {CHUNK node (raw text, embedded = the RAG unit) -> ORIGINATED_FROM the SOURCE; extract -> map entities,
// each APPEARED_IN this chunk}. SOURCE is keyed by PATH; identity is content_hash only (no cosine collapse).
// A chunk already extracted is skipped (deterministic chunk identity) so re-ingest is idempotent and cheap.
// Reports parse failures vs empty chunks vs reused chunks (fail-loud).
import type { Graph } from "../graph.js";
import type { Extractor } from "../extract/extractor.js";
import type { Meta } from "../schema.js";
import { readDoc, isSupported } from "./adapters.js";
import { chunk as splitChunks } from "./chunker.js";
import { mapExtraction } from "./mapper.js";
import { sourceIdentity, chunkIdentity, docContentHash } from "../extract/identity.js";

// Ingest owns identity via content_hash of the mapper's identity string; the store's default (no cosine
// near-dup merge) means similar CONTENT never collapses distinct identities — so putNode needs no opts here.

export interface IngestResult {
  source: string;
  title: string;
  chunks: number;
  entities: number;
  edges: number;
  parseFailures: number; // chunks whose model reply couldn't be parsed
  emptyChunks: number; // chunks that parsed but extracted nothing
  reused: number; // chunks skipped because they were already extracted (deterministic chunk identity)
}

// reextract: bypass the chunk memo (re-run extraction even for unchanged chunks) — use when the extraction
// model or prompt changed, since the memo keys only on chunk content, not on how it was extracted.
export async function ingestFile(
  graph: Graph,
  extractor: Extractor,
  path: string,
  opts: { reextract?: boolean } = {},
): Promise<IngestResult> {
  if (!isSupported(path)) throw new Error(`unsupported format: ${path} — tracer ingests .txt/.md only`);
  const doc = readDoc(path);
  const meta: Meta = { actor: "ingest", cause: `ingest ${doc.source}` };
  // Content-addressed identity: the document IS its content. Two byte-identical files (rolled up, on another
  // machine, behind a networked mount) dedup to one SOURCE; path is provenance only, never identity.
  const srcHash = docContentHash(doc.text);

  // SOURCE node — identity is the doc CONTENT hash (title/path are display/provenance); re-ingesting the same
  // content reinforces the same source.
  const srcVec = await graph.embedder.embed(doc.title);
  const src = await graph.store.putNode(
    {
      type: "SOURCE", subtype: "document", origin: "ingest",
      text: sourceIdentity(srcHash), name: doc.title, description: `Document: ${doc.title}`,
      provenance: { path: doc.source },
    },
    meta, srcVec,
  );

  const chunks = splitChunks(doc.text);
  const known = new Map<string, string>();
  let entities = 0, edges = 0, parseFailures = 0, emptyChunks = 0, reused = 0;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const label = `chunk ${i + 1} of ${doc.title}`;
    // CHUNK node — raw text is the retrievable body, embedded ON the raw text (the RAG unit).
    const cvec = await graph.embedder.embed(c.text.slice(0, 6000));
    const chunkNode = await graph.store.putNode(
      {
        type: "SOURCE", subtype: "chunk", origin: "ingest",
        text: chunkIdentity(srcHash, c.text), name: label, description: c.text,
        provenance: { path: doc.source, index: i },
      },
      meta, cvec,
    );
    await graph.store.putEdge(
      { from: chunkNode.id, to: src.id, kind: "ORIGINATED_FROM", reason: `${label} is from ${doc.title}`, origin: "ingest" },
      meta,
    );

    // Chunk memo: a chunk whose extraction previously COMPLETED (marked in extracted_chunks) is skipped — chunk
    // identity is deterministic, so re-running the temp-0.4 extractor would only churn the graph AND repay the
    // dominant LLM cost. Completion is marked AFTER the map below, so a crash mid-map leaves it unmarked and it
    // retries (not silently frozen half-written). `reextract` forces a re-run (model/prompt bump).
    if (!opts.reextract && graph.store.isExtracted(chunkNode.id)) {
      reused++;
      // NOTE: a skipped chunk does not repopulate the mapper's cross-chunk `known` map this run. Safe today —
      // the LlmExtractor drops any relation whose endpoints aren't in the SAME chunk (extractor.ts), so `known`
      // is effectively same-chunk. An extractor that emits cross-chunk relations would need `known` seeded from
      // the store on skip (see docs/backlog.md "known-map on memo-skip").
      continue;
    }

    const { extraction, parsed } = await extractor.extract(c.text, { subject: doc.subject });
    if (!parsed) parseFailures++;
    else if (extraction.entities.length === 0 && extraction.relations.length === 0) emptyChunks++;
    const r = await mapExtraction(graph.store, graph.embedder, meta, extraction, known, { id: chunkNode.id, label });
    entities += r.entityCount;
    edges += r.edgeCount;
    // Mark complete only on a successful PARSE (empty-but-parsed counts as done → don't re-pay the LLM for a
    // genuinely empty chunk; a parse FAILURE stays unmarked → retried next time).
    if (parsed) graph.store.markExtracted(chunkNode.id);
  }

  return { source: doc.source, title: doc.title, chunks: chunks.length, entities, edges, parseFailures, emptyChunks, reused };
}

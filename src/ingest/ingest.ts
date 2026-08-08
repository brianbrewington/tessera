// Ingest orchestrator (per docs/ingest-model.md), SPLIT IN TWO:
//
//   ingestChunks()  read adapter -> chunk -> per chunk {CHUNK node (raw text, embedded = the RAG unit)
//                   -> ORIGINATED_FROM the SOURCE}. No LLM extraction. Milliseconds plus embedding.
//   extractPending() (./extract-pending.ts) claims dirty chunks and does the expensive part.
//
// Why split: extraction is ~97% of ingest wall-clock (199 chunks x ~10s = over half an hour on graphs/big),
// and holding one advisory lock across that whole loop is what created the accepted lock risk (backlog B25).
// Chunking briefly, then extracting under per-chunk claims, makes the six-hour staleness threshold
// unreachable rather than merely unlikely. It also means a chunk's raw text is durable BEFORE any model runs,
// which is the only reason a chunk whose source file has since been deleted can still be extracted.
//
// SOURCE is content-addressed (path is provenance, never identity). A chunk already extracted under the
// current PROMPT_VERSION is skipped, so re-ingest is idempotent and cheap.
import type { Graph } from "../graph.js";
import type { Extractor } from "../extract/extractor.js";
import { PROMPT_VERSION } from "../extract/extractor.js";
import type { Meta } from "../schema.js";
import { readDoc, isSupported } from "./adapters.js";
import { chunk as splitChunks } from "./chunker.js";
import { sourceIdentity, chunkIdentity, docContentHash } from "../extract/identity.js";
import { extractPending } from "./extract-pending.js";

// Ingest owns identity via content_hash of the mapper's identity string; the store's default (no cosine
// near-dup merge) means similar CONTENT never collapses distinct identities — so putNode needs no opts here.

export interface ChunkIngestResult {
  source: string;
  title: string;
  chunks: number;
  /** Chunks now owing extraction. This is the honest number for a drop response: "N chunks queued". */
  queued: number;
  /** Chunks already extracted under the current prompt — no LLM cost owed. */
  reused: number;
  chunkIds: string[];
  skipped: boolean; // the whole file was skipped (already chunked — zero writes)
}

export interface IngestResult {
  source: string;
  title: string;
  chunks: number;
  entities: number;
  edges: number;
  parseFailures: number; // chunks whose model reply couldn't be parsed
  emptyChunks: number; // chunks that parsed but extracted nothing
  reused: number; // chunks skipped because they were already extracted (deterministic chunk identity)
  skipped: boolean; // the whole file was skipped (already ingested complete — zero writes)
}

export interface IngestChunksOptions {
  /** Re-chunk even if this document's content hash is already recorded as chunked. */
  rechunk?: boolean;
  extractorModel?: string;
  // `display` lets a caller override the title/provenance path WITHOUT touching identity, which is the
  // content hash and never the path. `tessera serve` needs this: an upload lands at a server-generated temp
  // path, and readDoc would otherwise persist that temp filename as the document's title forever.
  display?: { title?: string; source?: string };
  /** Per-chunk progress. Chunking is fast, but each chunk is still embedded, so this is not instant. */
  onChunk?: (done: number, total: number) => void;
  promptVersion?: string;
}

/**
 * The FAST half of ingest: read, chunk, write the SOURCE and CHUNK nodes, record the manifest. No LLM
 * extraction, so no unbounded loop and no long lock hold. After this returns, every chunk's raw text is
 * durable and `extractPending` can finish the job later, from another process, after a crash, or after the
 * source file has been deleted.
 */
export async function ingestChunks(
  graph: Graph,
  path: string,
  opts: IngestChunksOptions = {},
): Promise<ChunkIngestResult> {
  if (!isSupported(path)) throw new Error(`unsupported format: ${path} — tracer ingests .txt/.md only`);
  const promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  const read = readDoc(path);
  const doc = {
    ...read.doc,
    title: opts.display?.title ?? read.doc.title,
    source: opts.display?.source ?? read.doc.source,
  };
  const meta: Meta = { actor: "ingest", cause: `ingest ${doc.source}` };
  // Content-addressed identity: the document IS its content. Two byte-identical files (rolled up, on another
  // machine, behind a networked mount) dedup to one SOURCE; path is provenance only, never identity.
  const srcHash = docContentHash(doc.text);

  // File-level skip: a document whose chunks are already written is a true no-op — no re-embed / re-putNode
  // churn. `status` now means "chunks durably written", not "extraction finished": extraction state is
  // per-chunk, so a document with a failed chunk is no longer re-read from disk to retry it. That change is
  // exactly what makes a chunk whose source file is gone reachable at all.
  const prior = graph.store.getIngestedSource(srcHash);
  if (!opts.rechunk && prior?.status === "complete") {
    // sourceIdentity(), not the bare hash: `nodes.text` holds the identity STRING. Passing the hash returns
    // no chunks, which silently turns "re-enter and retry the failed chunks" into a no-op.
    const ids = graph.store.chunkIdsForSource(sourceIdentity(srcHash));
    const queued = graph.store.dirtyChunks(promptVersion, { ids }).length;
    return {
      source: doc.source, title: doc.title, chunks: prior.chunkCount,
      queued, reused: prior.chunkCount - queued, chunkIds: ids, skipped: true,
    };
  }

  // SOURCE node — identity is the doc CONTENT hash (title/path are display/provenance); re-ingesting the same
  // content reinforces the same source. `subject` is persisted so extraction can stay subject-aware later
  // without the file: without it, healing an old chunk would silently lose the KI-1 fix.
  const srcVec = await graph.embedder.embed(doc.title);
  const src = await graph.store.putNode(
    {
      type: "SOURCE", subtype: "document", origin: "ingest",
      text: sourceIdentity(srcHash), name: doc.title, description: `Document: ${doc.title}`,
      provenance: doc.subject ? { path: doc.source, subject: doc.subject } : { path: doc.source },
    },
    meta, srcVec,
  );

  const chunks = splitChunks(doc.text);
  const chunkIds: string[] = [];
  let reused = 0;

  for (let i = 0; i < chunks.length; i++) {
    opts.onChunk?.(i, chunks.length);
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
    chunkIds.push(chunkNode.id);
    if (graph.store.isExtracted(chunkNode.id, promptVersion)) reused++;
  }

  opts.onChunk?.(chunks.length, chunks.length);
  // The manifest now records only that chunking finished. parse_failures stays at 0 here and lives per-chunk
  // in chunk_extraction_state, where it can be surfaced and retried instead of freezing a whole file.
  graph.store.recordIngestedSource({
    contentHash: srcHash, path: doc.source, title: doc.title,
    status: "complete",
    chunkCount: chunks.length, parseFailures: 0, extractorModel: opts.extractorModel ?? null, at: Date.now(),
  }, meta);

  return {
    source: doc.source, title: doc.title, chunks: chunks.length,
    queued: chunks.length - reused, reused, chunkIds, skipped: false,
  };
}

/**
 * Chunk a file and extract it in one call — the synchronous convenience path.
 *
 * `tessera ingest` no longer uses this: the CLI chunks, and `tessera extract` extracts. It remains the
 * honest composition of the two halves for callers that want the whole thing done before they return.
 *
 * `reextract` forces re-extraction of chunks already marked at the current prompt version.
 */
export async function ingestFile(
  graph: Graph,
  extractor: Extractor,
  path: string,
  opts: IngestChunksOptions & { reextract?: boolean } = {},
): Promise<IngestResult> {
  const promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  const chunked = await ingestChunks(graph, path, { ...opts, rechunk: opts.rechunk ?? opts.reextract });
  if (chunked.skipped && chunked.queued === 0 && !opts.reextract) {
    return {
      source: chunked.source, title: chunked.title, chunks: chunked.chunks,
      entities: 0, edges: 0, parseFailures: 0, emptyChunks: 0, reused: chunked.reused, skipped: true,
    };
  }
  const drained = await extractPending(graph, extractor, {
    promptVersion,
    ids: chunked.chunkIds,
    force: opts.reextract,
    onChunk: opts.onChunk,
  });
  return {
    source: chunked.source, title: chunked.title, chunks: chunked.chunks,
    entities: drained.entities, edges: drained.edges,
    parseFailures: drained.parseFailures, emptyChunks: drained.emptyChunks,
    // `reused` means "already extracted, no LLM owed". Chunks another worker holds a claim on were merely
    // POSTPONED, so counting them as reused would report work as done that nobody has done.
    reused: chunked.chunks - drained.attempted - drained.skippedClaimed, skipped: false,
  };
}

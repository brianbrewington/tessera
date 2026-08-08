// The SLOW half of ingest: claim dirty chunks, extract, map, mark clean.
//
// Reads chunk text out of the STORE, never off disk. That is not a convenience — it is the only reason a
// chunk whose source file has since been deleted can ever be finished. On graphs/big two chunks failed to
// parse during a rebuild whose source directory was a scratchpad that no longer exists; the documented cure
// (re-run `tessera ingest`, which re-enters on a 'partial' manifest row) reads the file, so for those two it
// was a dead letter. Their raw text survived only inside the chunk nodes.
//
// Exclusivity is a ROW-LEVEL CLAIM inside one transaction, not a filesystem protocol. The advisory lock's
// four review rounds established that hand-rolled exclusivity built from unlink/rename plus a staleness
// heuristic regenerates its own race at every layer. SQLite serializes an UPDATE ... WHERE for free.
import type { Graph } from "../graph.js";
import type { Extractor } from "../extract/extractor.js";
import { PROMPT_VERSION } from "../extract/extractor.js";
import type { Meta } from "../schema.js";
import type { DirtyChunk } from "../store/graphStore.js";
import { mapExtraction } from "./mapper.js";
import { subjectFromText } from "./adapters.js";

/**
 * Attempts before a background drain gives up on a chunk. A serve drop must not silently re-pay for a chunk
 * the model cannot parse, on every drop, forever. Explicit `tessera extract --retry-failed` clears the count,
 * so nothing is ever abandoned without a human able to reach it — "silently dirty forever" must not become
 * "silently abandoned forever", which is the same lie with a bound.
 */
export const FAILING_ATTEMPTS = 3;

/** Long enough that a slow-but-alive extraction is never stolen: src/llm.ts aborts one call after 600s. */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

export interface ExtractPendingOptions {
  promptVersion?: string;
  /** Restrict to specific chunks (ingestFile extracts only the file it just chunked). */
  ids?: string[];
  /** Include chunks extracted under an OLDER prompt. Default true; a serve drain sets false. */
  includeStale?: boolean;
  /** Skip chunks with at least this many failed attempts. A serve drain sets FAILING_ATTEMPTS. */
  maxAttempts?: number;
  limit?: number;
  /** Re-extract even chunks already clean at this version (the `--reextract` path). */
  force?: boolean;
  claimant?: string;
  claimTtlMs?: number;
  /** Chunks per lock acquisition. Small, so a lock is never held across a long run. */
  batchSize?: number;
  /**
   * Wraps each batch — where a caller puts the advisory lock. Default is no wrapping, because the lock
   * belongs to whoever owns the process boundary (the CLI command, the serve drain), not to this function.
   */
  withBatch?: <T>(fn: () => Promise<T>) => Promise<T>;
  onChunk?: (done: number, total: number) => void;
  /** Injectable clock so claim expiry is testable without waiting fifteen minutes. */
  now?: () => number;
}

export interface ExtractPendingResult {
  /** Chunks the query returned as owing work. */
  considered: number;
  /** Chunks actually claimed and run. */
  attempted: number;
  extracted: number;
  parseFailures: number;
  emptyChunks: number;
  /** Transport or mapper throws — distinct from a parse failure, which is the model's answer being unusable. */
  errors: number;
  /** Chunks another extractor held a live claim on. */
  skippedClaimed: number;
  entities: number;
  edges: number;
}

/** The subject of a chunk's document, for subject-aware extraction, without touching the filesystem. */
function recoverSubject(graph: Graph, chunk: DirtyChunk, cache: Map<string, string | undefined>): string | undefined {
  const persisted = chunk.sourceProvenance?.subject;
  if (typeof persisted === "string" && persisted.trim()) return persisted.trim();
  if (!chunk.sourceId) return undefined;
  if (cache.has(chunk.sourceId)) return cache.get(chunk.sourceId);
  // Fallback for graphs ingested before the subject was persisted: the PROFILE: header is in chunk zero,
  // exactly where readDoc found it. Without this, healing an old chunk loses subject-aware extraction and
  // silently reintroduces KI-1 for precisely the chunks that most need healing.
  const first = graph.store.firstChunkText(chunk.sourceId);
  const subject = first ? subjectFromText(first) : undefined;
  cache.set(chunk.sourceId, subject);
  return subject;
}

export async function extractPending(
  graph: Graph,
  extractor: Extractor,
  opts: ExtractPendingOptions = {},
): Promise<ExtractPendingResult> {
  const promptVersion = opts.promptVersion ?? PROMPT_VERSION;
  const now = opts.now ?? (() => Date.now());
  const claimant = opts.claimant ?? `pid:${process.pid}`;
  const ttl = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const batchSize = Math.max(1, opts.batchSize ?? 5);
  const withBatch = opts.withBatch ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());

  const pending = graph.store.dirtyChunks(promptVersion, {
    ids: opts.ids,
    includeStale: opts.includeStale,
    maxAttempts: opts.maxAttempts,
    limit: opts.limit,
    includeClean: opts.force,
  });

  const out: ExtractPendingResult = {
    considered: pending.length, attempted: 0, extracted: 0, parseFailures: 0,
    emptyChunks: 0, errors: 0, skippedClaimed: 0, entities: 0, edges: 0,
  };
  if (!pending.length) return out;

  // `known` is per SOURCE, matching what a single-file ingest used to do. It carries node reuse across a
  // document's chunks AND the ambiguity suppression that drops a name which split into two typed nodes, so
  // no later chunk miswires it. Per-chunk maps would silently discard the second of those.
  const knownBySource = new Map<string, Map<string, string>>();
  const subjectCache = new Map<string, string | undefined>();

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    await withBatch(async () => {
      for (const chunk of batch) {
        const label = chunk.name ?? `chunk ${chunk.id}`;
        const text = chunk.text ?? "";
        if (!text.trim()) {
          // A chunk node with no stored body cannot be extracted by any means. Record it rather than
          // looping on it forever.
          graph.store.recordExtractionFailure(chunk.id, "chunk has no stored text", now());
          out.attempted++; out.errors++;
          opts.onChunk?.(out.attempted, pending.length);
          continue;
        }
        // force bypasses the claim: --reextract is an explicit, user-metered, single-operator action.
        if (!opts.force && !graph.store.claimChunk(chunk.id, claimant, now(), ttl)) {
          out.skippedClaimed++;
          continue;
        }
        const meta: Meta = { actor: "extract", cause: `extract ${label}` };
        const sourceKey = chunk.sourceId ?? chunk.id;
        const known = knownBySource.get(sourceKey) ?? new Map<string, string>();
        knownBySource.set(sourceKey, known);
        try {
          const subject = recoverSubject(graph, chunk, subjectCache);
          const { extraction, parsed } = await extractor.extract(text, { subject });
          if (!parsed) {
            // The model answered with something unparseable. Not an error in our machinery — a real outcome
            // that stays dirty and retries, now with a visible attempt count instead of silence.
            graph.store.recordExtractionFailure(chunk.id, "model reply was not parseable JSON", now());
            out.parseFailures++;
          } else {
            if (extraction.entities.length === 0 && extraction.relations.length === 0) out.emptyChunks++;
            const r = await mapExtraction(graph.store, graph.embedder, meta, extraction, known, {
              id: chunk.id, label,
            });
            out.entities += r.entityCount;
            out.edges += r.edgeCount;
            // Marked only after the mapper finished, so a crash mid-map leaves the chunk dirty and it
            // retries rather than being silently frozen half-written.
            graph.store.markExtracted(chunk.id, promptVersion, meta);
            out.extracted++;
          }
        } catch (e) {
          // Per-chunk, deliberately: one flaky transport call late in a run must not discard every chunk
          // already paid for. The claim is released so another run can pick it up.
          graph.store.recordExtractionFailure(chunk.id, e instanceof Error ? e.message : String(e), now());
          out.errors++;
        }
        out.attempted++;
        opts.onChunk?.(out.attempted, pending.length);
      }
    });
  }
  return out;
}

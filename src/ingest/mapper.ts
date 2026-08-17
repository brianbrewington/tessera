// Graph-mapper — one chunk's Extraction -> graph writes, per docs/corpus-ingest-design.md. Entities become
// typed nodes with a content-addressed identity string (hubs merge by type+name — PERSON too, no source/path
// qualifier), first-class name+description, embedded on their CONTENT (not the identity string), each linked
// APPEARED_IN its chunk. Relations become canonicalized RELATED edges whose reason is the assertion; the chunk
// is passed as grounding so provenance is recorded. `known` gives node-reuse across a doc's chunks. All writes
// go through GraphStore.
import type { GraphStore } from "../store/graphStore.js";
import type { Embedder } from "../embedder.js";
import type { Meta, Origin } from "../schema.js";
import type { Extraction } from "../extract/extractor.js";
import { toStoreType } from "../extract/typemap.js";
import { entityIdentity, canonical } from "../extract/identity.js";
import { foldEntityType } from "./typenorm.js";

const norm = (s: string): string => s.trim().toLowerCase();

export async function mapExtraction(
  store: GraphStore,
  embedder: Embedder,
  meta: Meta,
  ex: Extraction,
  known: Map<string, string>, // entity name (normalized) -> node id, across a doc's chunks
  chunk: { id: string; label: string },
  // WHERE these products came from. Defaults to "ingest" so the ordinary path is unchanged, but it must be
  // settable: a self-directed run (a dream, a walk) writing products marked "ingest" would be permanently
  // indistinguishable from extracted fact, and this store has no delete for nodes or edges. Marking is the
  // only isolation available, so it cannot be hardcoded.
  origin: Origin = "ingest",
): Promise<{ entityCount: number; edgeCount: number }> {
  let entityCount = 0;
  let edgeCount = 0;
  const here = new Map<string, string[]>(); // this chunk's name -> node id(s); >1 = a type-split homograph

  for (const e of ex.entities) {
    const key = norm(e.name);
    if (!key) continue;
    // D4 stage 1b: a weak-typed mention (OTHER/CODE/PROJECT) of a name the graph already knows under
    // a strict-majority established type folds to that type BEFORE identity is computed — otherwise
    // type jitter mints a twin node per type. PERSON<->TECHNOLOGY never auto-folds (see typenorm.ts).
    const foldedType = foldEntityType(store, e.type, e.name);
    const { type, subtype } = toStoreType(foldedType);
    const vec = await embedder.embed(`${e.name.trim()}. ${e.description}`.slice(0, 2000)); // embed CONTENT, not identity
    // Always putNode: the store dedups by identity (content_hash of the identity string) and reinforce-merges
    // the richer description each mention. The store's default is identity-only (no cosine near-dup), so similar
    // content never collapses distinct ids (place\tjava vs concept\tjava; source-qualified people). A name that
    // yields two TYPED nodes in one chunk is a homograph — tracked as multiple ids so relations don't miswire.
    const put = await store.putNode(
      { type, subtype, origin, text: entityIdentity(foldedType, e.name), name: e.name.trim(), description: e.description },
      meta, vec,
    );
    if (!put.reinforced) entityCount++;
    const ids = here.get(key) ?? [];
    if (!ids.includes(put.id)) ids.push(put.id); // a re-mention of the SAME node isn't a new candidate
    here.set(key, ids);
    await store.putEdge(
      { from: put.id, to: chunk.id, kind: "APPEARED_IN", reason: `${e.name.trim()} appears in ${chunk.label}`, origin },
      meta, undefined, chunk.id,
    );
  }

  // Fold this chunk's entities into the doc-level `known` map, but ONLY names with a single referent. A name
  // that split into two typed nodes (PLACE Java / CONCEPT Java) is ambiguous — relations carry names, not
  // types, so they can't be bound to one node; drop it from `known` so no later chunk miswires it either.
  for (const [key, ids] of here) {
    if (ids.length === 1) known.set(key, ids[0]!);
    else known.delete(key);
  }
  // Resolve a relation endpoint to a single node id, or null if unknown/ambiguous (skip rather than miswire).
  const resolve = (name: string): string | null => {
    const local = here.get(norm(name));
    if (local) return local.length === 1 ? local[0]! : null; // ambiguous within this chunk -> unresolvable
    return known.get(norm(name)) ?? null;
  };

  for (const r of ex.relations) {
    const a = resolve(r.source);
    const b = resolve(r.target);
    if (!a || !b || a === b) continue; // dangling or ambiguous endpoint -> drop the edge, don't guess
    const [from, to] = canonical(a, b); // undirected RELATED — canonical endpoint order
    const pe = await store.putEdge({ from, to, kind: "RELATED", reason: r.reason.trim(), origin }, meta, undefined, chunk.id);
    if (pe.created) edgeCount++; // count real new edges, not reinforcements (honest re-ingest reporting)
  }

  return { entityCount, edgeCount };
}

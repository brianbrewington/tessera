// Graph-mapper — one chunk's Extraction -> graph writes, per docs/ingest-model.md. Entities become typed
// nodes with an identity string (hubs merge by type+name; PERSON source-qualified), first-class
// name+description, embedded on their CONTENT (not the identity string), each linked APPEARED_IN its chunk.
// Relations become canonicalized RELATED edges whose reason is the assertion. `known` gives node-reuse
// across a doc's chunks. All writes go through GraphStore.
import type { GraphStore } from "../store/graphStore.js";
import type { Embedder } from "../embedder.js";
import type { Meta } from "../schema.js";
import type { Extraction } from "../extract/extractor.js";
import { toStoreType } from "../extract/typemap.js";
import { entityIdentity, canonical } from "../extract/identity.js";

const norm = (s: string): string => s.trim().toLowerCase();

export async function mapExtraction(
  store: GraphStore,
  embedder: Embedder,
  meta: Meta,
  ex: Extraction,
  source: string, // doc path — for PERSON source-qualification
  known: Map<string, string>, // entity name (normalized) -> node id, across a doc's chunks
  chunk: { id: string; label: string },
): Promise<{ entityCount: number; edgeCount: number }> {
  let entityCount = 0;
  let edgeCount = 0;
  const here = new Map<string, string>(); // this chunk's name -> id, for relation wiring

  for (const e of ex.entities) {
    const key = norm(e.name);
    if (!key) continue;
    const { type, subtype } = toStoreType(e.type);
    const vec = await embedder.embed(`${e.name.trim()}. ${e.description}`.slice(0, 2000)); // embed CONTENT, not identity
    // Always putNode: the store dedups by identity (content_hash of the identity string) and reinforce-merges
    // the richer description each mention. nearDupMerge:false so similar content never collapses distinct ids
    // (place\tjava vs concept\tjava; source-qualified people). Homographs of different TYPES become distinct
    // nodes here; relation wiring below is name-based (an inherent ambiguity for same-name/different-type).
    const put = await store.putNode(
      { type, subtype, origin: "ingest", text: entityIdentity(e.type, e.name, source), name: e.name.trim(), description: e.description },
      meta, vec, { nearDupMerge: false },
    );
    if (!put.reinforced) entityCount++;
    here.set(key, put.id);
    known.set(key, put.id);
    await store.putEdge(
      { from: put.id, to: chunk.id, kind: "APPEARED_IN", reason: `${e.name.trim()} appears in ${chunk.label}`, origin: "ingest" },
      meta,
    );
  }

  for (const r of ex.relations) {
    const a = here.get(norm(r.source)) ?? known.get(norm(r.source));
    const b = here.get(norm(r.target)) ?? known.get(norm(r.target));
    if (!a || !b || a === b) continue;
    const [from, to] = canonical(a, b); // undirected RELATED — canonical endpoint order
    await store.putEdge({ from, to, kind: "RELATED", reason: r.reason.trim(), origin: "ingest" }, meta);
    edgeCount++;
  }

  return { entityCount, edgeCount };
}

// Graph-mapper — turn one chunk's Extraction into graph writes, through GraphStore (never bypassing it).
// Entities -> typed nodes (text = the entity NAME, so same-named entities dedup into ONE shared hub across
// chunks/docs — the trope signal; description in metadata). Relations -> RELATED edges whose reason (which
// names both endpoints) becomes the edge_assertion. New entities also get an ORIGINATED_FROM provenance edge
// to the source node. Node-reuse is via the `known` map (accumulated across a doc's chunks).
import type { GraphStore } from "../store/graphStore.js";
import type { Meta } from "../schema.js";
import type { Extraction } from "../extract/extractor.js";
import { toStoreType } from "../extract/typemap.js";

const norm = (s: string): string => s.trim().toLowerCase();

export async function mapExtraction(
  store: GraphStore,
  meta: Meta,
  ex: Extraction,
  known: Map<string, string>, // entity name (normalized) -> node id, accumulated across a doc's chunks
  source?: { id: string; title: string },
): Promise<{ entityCount: number; edgeCount: number }> {
  let entityCount = 0;
  let edgeCount = 0;
  const here = new Map<string, string>(); // this chunk's name -> id, for relation wiring

  for (const e of ex.entities) {
    const key = norm(e.name);
    if (!key) continue;
    let id = known.get(key);
    if (!id) {
      const { type, subtype } = toStoreType(e.type);
      const put = await store.putNode(
        { type, subtype, origin: "ingest", text: e.name.trim(), metadata: { name: e.name.trim(), description: e.description } },
        meta,
      );
      id = put.id;
      known.set(key, id);
      entityCount++;
      if (source && id !== source.id) {
        await store.putEdge(
          { from: id, to: source.id, kind: "ORIGINATED_FROM", reason: `${e.name.trim()} appears in ${source.title}`, origin: "ingest" },
          meta,
        );
      }
    }
    here.set(key, id);
  }

  for (const r of ex.relations) {
    const from = here.get(norm(r.source)) ?? known.get(norm(r.source));
    const to = here.get(norm(r.target)) ?? known.get(norm(r.target));
    if (!from || !to || from === to) continue;
    await store.putEdge({ from, to, kind: "RELATED", reason: r.reason.trim(), origin: "ingest" }, meta);
    edgeCount++;
  }

  return { entityCount, edgeCount };
}

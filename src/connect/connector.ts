// Connector (analytic) — the quiet indexer that finds edges that ALREADY exist (spec §5):
// embedding-proximity kNN over quarantine vectors -> proposed RELATED edges. Pairs are
// canonicalized (from < to) so A~B and B~A are one undirected edge. The generative dream
// (a later slice) is the *other* connector — the one that makes edges that didn't exist.
import type { GraphStore } from "../store/graphStore.js";

export interface ConnectOptions {
  k?: number; // neighbors considered per node
  threshold?: number; // minimum cosine to link
}

export async function connect(store: GraphStore, opts: ConnectOptions = {}): Promise<number> {
  const k = opts.k ?? 6;
  const threshold = opts.threshold ?? 0.55;
  const ids = store.allNodes().map((n) => n.id);
  const seen = new Set<string>();
  let created = 0;

  for (const id of ids) {
    const vec = store.vectorOf(id, "quarantine");
    if (!vec) continue;
    const hits = await store.querySimilar(vec, k + 1, { index: "quarantine" });
    for (const h of hits) {
      if (h.node.id === id || h.cosine < threshold) continue;
      const [from, to] = id < h.node.id ? [id, h.node.id] : [h.node.id, id];
      const key = `${from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await store.putEdge(
        { from: from!, to: to!, kind: "RELATED", reason: `semantic proximity (cos=${h.cosine.toFixed(2)})`, origin: "connector" },
        { actor: "connector", cause: "analytic-pass" },
      );
      if (r.created) created++;
    }
  }
  return created;
}

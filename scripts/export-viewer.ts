// Export a graph db to a single self-contained HTML viewer (the quine-bundle pattern — portable, offline,
// no server). Reusable as exportViewer(db, out); also runnable directly: npx tsx scripts/export-viewer.ts [db] [out]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveEntities, type ResolveMember } from "../src/resolve/view.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { PROMPT_VERSION } from "../src/extract/extractor.js";
import { FAILING_ATTEMPTS } from "../src/ingest/extract-pending.js";

const here = dirname(fileURLToPath(import.meta.url));
const TPL = `${here}/../viewer/template.html`;

/** Reduced vectors, memoised on the node-id set. See the note at its use site. */
const EMBED_CACHE = new Map<string, Record<string, number[]>>();

export function exportViewer(db: string, out: string, name = "graph"): number {
  // Read-only export; the embedder only satisfies the ctor (dim must match the db's vec tables → 768).
  const store = new GraphStore({ path: db, embedder: new StubEmbedder(768) });
  const nodes = store.allNodes().map((n) => ({
    id: n.id,
    label: n.name ?? (n.metadata?.name as string | undefined) ?? (n.metadata?.title as string | undefined) ?? n.text.slice(0, 40),
    type: n.type,
    group: n.subtype ?? (n.metadata?.noteType as string | undefined) ?? n.type,
    text: n.text,
    strength: n.strength,
    // fold the first-class name/description columns into the viewer's meta bag (panel reads md.name/description)
    meta: { ...(n.metadata ?? {}), name: n.name, description: n.description },
  }));
  const storedLayout = store.getLayout();
  // Edge prominence, one map per measure — the viewer's edge filter switches between them (design: the
  // attention budget). hebbian_weight is NOT usable for this: it is 1 on ~94% of real edges.
  const prominence: Record<string, Record<string, number>> = {};
  for (const measure of store.prominenceMeasures()) {
    prominence[measure] = Object.fromEntries(store.edgeProminence(measure));
  }
  const edges = store.allEdges().map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind,
    w: e.hebbianWeight,
    reason: store.edgeReason(e.id) ?? "", // latest — for the hover tooltip
    reasons: store.edgeReasons(e.id), // ALL assertions — for the right-click deep-inspect
  }));
  // Scenes travel with the bundle. Design §6 makes the db the source of truth in served mode, but the served
  // page still read localStorage — so a user who correctly followed the slice-2 migration opened the served
  // viewer, saw NO scenes, and had every reason to conclude the migration had failed. The data was safe the
  // whole time; nothing displayed it.
  const scenes = store.allScenes();
  // Extraction debt, so the map can say it is incomplete rather than just looking thin. The BREAKDOWN, not
  // just a total: a background drain skips stale-prompt and repeatedly-failing chunks, so a badge built on
  // the total alone would promise something no drop is going to do.
  const dirty = store.dirtyCounts(PROMPT_VERSION, FAILING_ATTEMPTS);
  const dirtyChunks = dirty.dirty;
  // Capture the vector reader before the store closes — the reduction below needs it.
  const vecOf = (id: string): Float32Array | null => store.vectorOf(id, "quarantine");
  const vecCache = new Map<string, Float32Array | null>();
  for (const n of nodes) vecCache.set(n.id, vecOf(n.id));
  store.close();

  // Stored layout travels with the bundle (design §3.5). Without this the CLI would write positions to
  // SQLite that the default file:// path could never read — the geometry-preservation guarantee would hold
  // in the database and be invisible in the product. Absent keys are what §3.4 reads as "incomplete".
  const layout: Record<string, [number, number]> = {};
  for (const [id, p] of storedLayout) layout[id] = [p.x, p.y];

  // A reduced copy of each node's vector, so the viewer can COMPUTE layouts rather than only display one.
  // RANDOM PROJECTION, not PCA, and the reason is a hard constraint rather than a preference: serve calls
  // exportViewer on EVERY page request, and a power-iteration PCA over 1714x768 takes minutes. A random
  // projection is one pass, deterministic under a fixed seed, and preserves pairwise distances well enough
  // for a neighbour-embedding to run on (Johnson-Lindenstrauss) — which is exactly and only what t-SNE needs
  // from its input. The viewer computes its own PCA for INITIALISATION from these 48 dims, which is cheap.
  // MEMOISED across calls. serve re-exports on EVERY page request, so without this a reload pays ~63M
  // multiply-adds (1714 x 768 x 48) plus the vector reads, before anyone touches the layout controls. Both
  // reviewers flagged it. Keyed on the node-id set, so an ingest that adds nodes correctly invalidates it.
  const EDIM = 48;
  const proj: Float32Array[] = [];
  {
    let seed = 0x9e3779b9;
    const rnd = (): number => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296 - 0.5; };
    for (let k = 0; k < EDIM; k++) { const v = new Float32Array(768); for (let i = 0; i < 768; i++) v[i] = rnd(); proj.push(v); }
  }
  const embedKey = createHash("sha256").update(nodes.map((n) => n.id).sort().join("")).digest("hex").slice(0, 16);
  let embed = EMBED_CACHE.get(embedKey);
  if (!embed) {
    embed = {};
    for (const n of nodes) {
      const v = vecCache.get(n.id);
      if (!v) continue;
      const out = new Array<number>(EDIM);
      for (let k = 0; k < EDIM; k++) { let s2 = 0; const pk = proj[k]!; for (let i = 0; i < v.length; i++) s2 += v[i]! * pk[i]!; out[k] = Number(s2.toFixed(3)); }
      embed[n.id] = out;
    }
    EMBED_CACHE.clear();          // one graph per process; keep exactly the current one
    EMBED_CACHE.set(embedKey, embed);
  }

  // Layer 1 resolution travels with the bundle so the viewer can COLLAPSE duplicates at read time and, just
  // as importantly, un-collapse them. Computed here rather than in the page because it is the store's policy,
  // not a rendering preference — the viewer decides whether to apply it, never what it means.
  const entities: ResolveMember[] = nodes
    .filter((n) => n.group !== "chunk" && n.group !== "document")
    .map((n) => ({ id: n.id, name: n.label, subtype: n.group, strength: n.strength }));
  const res = resolveEntities(entities);
  const resolution = {
    stats: res.stats,
    canonicalOf: Object.fromEntries(res.canonicalOf),
    groups: res.groups.map((g) => ({
      key: g.key, canonical: g.canonical.id, heldOut: g.heldOut, reason: g.reason ?? null,
      members: g.members.map((m) => ({ id: m.id, name: m.name, subtype: m.subtype })),
    })),
  };

  const dataJson = JSON.stringify({ nodes, edges, name, layout, prominence, scenes, dirtyChunks, dirty, embed, resolution }).replace(/</g, "\\u003c"); // so any '</script>' can't break out
  const html = readFileSync(TPL, "utf8").replace("/*__GRAPH_DATA__*/ {nodes:[],edges:[]}", dataJson);
  if (!html.includes(dataJson)) throw new Error("template placeholder not found — did template.html change?");
  writeFileSync(out, html);
  return nodes.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = process.argv[2] ?? `${here}/../data/tessera.db`;
  const out = process.argv[3] ?? `${here}/../viewer/tessera.html`;
  console.log(`wrote ${out}  (${exportViewer(db, out)} nodes)`);
}

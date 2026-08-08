// Export a graph db to a single self-contained HTML viewer (the quine-bundle pattern — portable, offline,
// no server). Reusable as exportViewer(db, out); also runnable directly: npx tsx scripts/export-viewer.ts [db] [out]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { PROMPT_VERSION } from "../src/extract/extractor.js";

const here = dirname(fileURLToPath(import.meta.url));
const TPL = `${here}/../viewer/template.html`;

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
  // Extraction debt, so the map can say it is incomplete rather than just looking thin.
  const dirtyChunks = store.dirtyCounts(PROMPT_VERSION).dirty;
  store.close();

  // Stored layout travels with the bundle (design §3.5). Without this the CLI would write positions to
  // SQLite that the default file:// path could never read — the geometry-preservation guarantee would hold
  // in the database and be invisible in the product. Absent keys are what §3.4 reads as "incomplete".
  const layout: Record<string, [number, number]> = {};
  for (const [id, p] of storedLayout) layout[id] = [p.x, p.y];

  const dataJson = JSON.stringify({ nodes, edges, name, layout, prominence, scenes, dirtyChunks }).replace(/</g, "\\u003c"); // so any '</script>' can't break out
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

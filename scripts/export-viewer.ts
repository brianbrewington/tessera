// Export a graph db to a single self-contained HTML viewer (the quine-bundle pattern — portable, offline,
// no server). Reusable as exportViewer(db, out); also runnable directly: npx tsx scripts/export-viewer.ts [db] [out]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const here = dirname(fileURLToPath(import.meta.url));
const TPL = `${here}/../viewer/template.html`;

export function exportViewer(db: string, out: string): number {
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
  const edges = store.allEdges().map((e) => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    w: e.hebbianWeight,
    reason: store.edgeReason(e.id) ?? "",
  }));
  store.close();

  const dataJson = JSON.stringify({ nodes, edges }).replace(/</g, "\\u003c"); // so any '</script>' can't break out
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

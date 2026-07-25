// Export the graph to a single self-contained HTML viewer (the quine-bundle pattern from
// MindMapper — portable, offline, no server). Usage: npx tsx scripts/export-viewer.ts [db] [out]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const here = dirname(fileURLToPath(import.meta.url));
const DB = process.argv[2] ?? `${here}/../data/tessera.db`;
const OUT = process.argv[3] ?? `${here}/../viewer/tessera.html`;
const TPL = `${here}/../viewer/template.html`;

// Read-only export; the embedder is only needed to satisfy the ctor. Its dim must match
// the DB's vec tables (768 for embeddinggemma) so ddl()'s IF-NOT-EXISTS is a no-op.
const store = new GraphStore({ path: DB, embedder: new StubEmbedder(768) });

const nodes = store.allNodes().map((n) => ({
  id: n.id,
  // persona display name (metadata.name) > note title > text snippet.
  label: (n.metadata?.name as string | undefined) ?? (n.metadata?.title as string | undefined) ?? n.text.slice(0, 40),
  type: n.type,
  // group drives colour: persona subtype (country / persona_type / motif) > noteType > type.
  group: n.subtype ?? (n.metadata?.noteType as string | undefined) ?? n.type,
  text: n.text,
  strength: n.strength,
  meta: n.metadata ?? null, // {name,type,age,country,gender} for PERSON; {field} for CONCEPT
}));
const edges = store.allEdges().map((e) => ({
  from: e.from,
  to: e.to,
  kind: e.kind, // RESONATES_WITH rendered distinctly (near-duplicate personas)
  w: e.hebbianWeight,
  reason: store.edgeReason(e.id) ?? "",
}));
store.close();

// Escape '<' so any '</script>' inside note text can't break the inline script.
const dataJson = JSON.stringify({ nodes, edges }).replace(/</g, "\\u003c");
const tpl = readFileSync(TPL, "utf8");
const html = tpl.replace("/*__GRAPH_DATA__*/ {nodes:[],edges:[]}", dataJson);
if (!html.includes(dataJson)) throw new Error("template placeholder not found — did template.html change?");
writeFileSync(OUT, html);
console.log(`wrote ${OUT}  (${nodes.length} nodes, ${edges.length} edges)`);

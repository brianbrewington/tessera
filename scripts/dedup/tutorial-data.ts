/**
 * Build the data for the dimensionality-reduction tutorial, from the REAL graph rather than toy points.
 * The whole pedagogical bet is that a projection of nodes Brian recognises teaches more than a projection
 * of Gaussian blobs, because he can check the answer against what he knows.
 *
 * Read-only. Emits one JSON the page embeds inline.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { writeFileSync } from "node:fs";

const N = 260;                 // enough to see structure, small enough to t-SNE in a browser tab
const PCA_DIMS = 30;           // the standard pre-reduction before t-SNE; also what the page runs t-SNE on
const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
sqliteVec.load(db);

type Row = { id: string; name: string; subtype: string };
const ents = db.prepare("SELECT id, name, subtype FROM nodes WHERE subtype NOT IN ('chunk','document') ORDER BY rowid").all() as Row[];

const deg = new Map<string, number>();
for (const e of db.prepare("SELECT from_id a, to_id b FROM edges WHERE kind='RELATED'").all() as { a: string; b: string }[]) {
  deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
  deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
}
const layout = new Map<string, { x: number; y: number }>(
  (db.prepare("SELECT node_id, x, y FROM layout").all() as { node_id: string; x: number; y: number }[]).map((r) => [r.node_id, { x: r.x, y: r.y }]),
);

// Stratified by degree: take every hub, then fill with a stride through the rest. A uniform random sample
// would be ~72% degree-<=1 nodes and would show the reader a cloud with no structure in it — which is true
// of the corpus but useless for teaching what a projection does.
const withDeg = ents.map((e) => ({ ...e, deg: deg.get(e.id) ?? 0 })).filter((e) => layout.has(e.id));
const hubs = withDeg.filter((e) => e.deg >= 4);
const rest = withDeg.filter((e) => e.deg < 4);
const stride = Math.max(1, Math.floor(rest.length / Math.max(1, N - hubs.length)));
const sample = [...hubs, ...rest.filter((_, i) => i % stride === 0)].slice(0, N);

const vecs: number[][] = [];
const kept: typeof sample = [];
for (const s of sample) {
  const r = db.prepare("SELECT embedding FROM vec_node_quarantine WHERE node_id = ?").get(s.id) as { embedding: Buffer } | undefined;
  if (!r) continue;
  const f = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
  vecs.push(Array.from(f));
  kept.push(s);
}
const D = vecs[0]!.length;
console.log(`${kept.length} nodes, ${D}-d vectors`);

// --- PCA by power iteration with deflation. Exact enough for teaching, and short enough to read. ---------
const mean = new Array<number>(D).fill(0);
for (const v of vecs) for (let j = 0; j < D; j++) mean[j]! += v[j]! / vecs.length;
const X = vecs.map((v) => v.map((x, j) => x - mean[j]!));   // centre: PCA is about variance ABOUT THE MEAN

function topComponent(M: number[][]): number[] {
  let w = new Array<number>(D).fill(0).map((_, i) => Math.sin(i * 1.7) + 0.1); // fixed, not random: reproducible
  for (let it = 0; it < 120; it++) {
    const next = new Array<number>(D).fill(0);
    for (const row of M) {                       // next += row * (row . w)   — i.e. next = X^T X w, without forming X^T X
      let d = 0;
      for (let j = 0; j < D; j++) d += row[j]! * w[j]!;
      for (let j = 0; j < D; j++) next[j]! += row[j]! * d;
    }
    let n = Math.hypot(...next) || 1;
    w = next.map((x) => x / n);
  }
  return w;
}
function project(M: number[][], w: number[]): number[] {
  return M.map((row) => { let d = 0; for (let j = 0; j < D; j++) d += row[j]! * w[j]!; return d; });
}
function deflate(M: number[][], w: number[], scores: number[]): number[][] {
  return M.map((row, i) => row.map((x, j) => x - scores[i]! * w[j]!));
}

const comps: number[][] = [];
const scores: number[][] = [];
let work = X.map((r) => [...r]);
for (let k = 0; k < PCA_DIMS; k++) {
  const w = topComponent(work);
  const s = project(work, w);
  comps.push(w); scores.push(s);
  work = deflate(work, w, s);
}
// variance explained, so the page can state honestly how much of the 768-d structure two dimensions keep
const totVar = X.reduce((acc, r) => acc + r.reduce((a, x) => a + x * x, 0), 0);
const varOf = (s: number[]): number => s.reduce((a, x) => a + x * x, 0);
const explained = scores.map((s) => varOf(s) / totVar);

const round = (x: number, p = 4): number => Number(x.toFixed(p));
const out = {
  generated_from: "graphs/testgraph/graph.db",
  n: kept.length,
  original_dims: D,
  pca_dims: PCA_DIMS,
  explained_variance: explained.map((x) => round(x, 5)),
  explained_2d: round(explained[0]! + explained[1]!, 5),
  nodes: kept.map((s, i) => ({
    label: s.name,
    type: s.subtype,
    deg: s.deg,
    pca: [round(scores[0]![i]!, 3), round(scores[1]![i]!, 3)],
    hi: scores.map((sc) => round(sc[i]!, 3)),          // the PCA_DIMS-d input the page runs t-SNE on
    force: [round(layout.get(s.id)!.x, 1), round(layout.get(s.id)!.y, 1)],
  })),
};
writeFileSync("/tmp/tutorial-data.json", JSON.stringify(out));
console.log(`variance explained by PC1+PC2: ${(100 * out.explained_2d).toFixed(1)}%`);
console.log(`by the first ${PCA_DIMS}: ${(100 * explained.reduce((a, b) => a + b, 0)).toFixed(1)}%`);
console.log(`wrote /tmp/tutorial-data.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
db.close();

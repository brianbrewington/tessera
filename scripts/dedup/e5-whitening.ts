/**
 * Does "All-but-the-Top" recover E1's missing recall?
 *
 * E1 measured that name+description embeddings recover 0.169 of known duplicates at a zero-false-positive
 * floor while name-only recovers 0.846, and diagnosed register homogeneity: one model, one voice, one
 * system, so a large shared component rides on every description.
 *
 * Mu & Viswanath (ICLR 2018, "All-but-the-Top") give the named, cheap fix for exactly that shape of problem:
 * subtract the common mean and the top few dominating directions. Ethayarajh (EMNLP 2019) established that
 * embedding spaces are anisotropic in this way; Su et al. (arXiv:2103.15316) show whitening helps retrieval.
 *
 * This tests it directly on the STORED vectors — the ones the graph actually holds — against E0's frozen
 * label sets. Read-only. If the register hypothesis is right, recall should climb sharply as the top
 * directions come out. If it does not move, the diagnosis was wrong and should be retracted.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "node:fs";

const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
sqliteVec.load(db);
type Pair = { a: string; b: string };
const L = JSON.parse(readFileSync("graphs/testgraph/dedup/labels.json", "utf8")) as { sets: Record<string, { pairs: Pair[] }> };

const rows = db.prepare("SELECT id FROM nodes WHERE subtype NOT IN ('chunk','document')").all() as { id: string }[];
const vec = new Map<string, number[]>();
for (const r of rows) {
  const b = db.prepare("SELECT embedding FROM vec_node_quarantine WHERE node_id = ?").get(r.id) as { embedding: Buffer } | undefined;
  if (b) vec.set(r.id, Array.from(new Float32Array(b.embedding.buffer, b.embedding.byteOffset, b.embedding.byteLength / 4)));
}
const ids = [...vec.keys()];
const D = vec.get(ids[0]!)!.length;
console.log(`${ids.length} stored vectors, ${D}-d (these are name + ". " + description — the INCUMBENT)`);

// centre
const mean = new Array<number>(D).fill(0);
for (const id of ids) { const v = vec.get(id)!; for (let j = 0; j < D; j++) mean[j]! += v[j]! / ids.length; }
let X = ids.map((id) => vec.get(id)!.map((x, j) => x - mean[j]!));

function topDir(M: number[][]): number[] {
  let w = new Array<number>(D).fill(0).map((_, i) => Math.sin(i * 1.7) + 0.1);
  for (let it = 0; it < 100; it++) {
    const nx = new Array<number>(D).fill(0);
    for (const row of M) { let d = 0; for (let j = 0; j < D; j++) d += row[j]! * w[j]!; for (let j = 0; j < D; j++) nx[j]! += row[j]! * d; }
    const n = Math.hypot(...nx) || 1; w = nx.map((x) => x / n);
  }
  return w;
}
const unit = (v: number[]): number[] => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const cos = (a: number[], b: number[]): number => { let s = 0; for (let i = 0; i < D; i++) s += a[i]! * b[i]!; return s; };

const pv = L.sets["P-variant"]!.pairs, nh = L.sets["N-hard"]!.pairs;
function score(vecs: Map<string, number[]>): { recall: number; floor: number } {
  const c = (p: Pair): number | null => {
    const a = vecs.get(p.a), b = vecs.get(p.b);
    return a && b ? cos(a, b) : null;
  };
  const N = nh.map(c).filter((x): x is number => x !== null);
  const P = pv.map(c).filter((x): x is number => x !== null);
  const floor = Math.max(...N);
  return { recall: P.filter((x) => x > floor).length / P.length, floor };
}

console.log("\ndirections removed | zero-FP floor | P-variant recall@FP=0");
const results: { k: number; recall: number; floor: number }[] = [];
for (let k = 0; k <= 12; k++) {
  if (k > 0) {                                   // remove one more dominating direction
    const w = topDir(X);
    X = X.map((row) => { let d = 0; for (let j = 0; j < D; j++) d += row[j]! * w[j]!; return row.map((x, j) => x - d * w[j]!); });
  }
  const m = new Map(ids.map((id, i) => [id, unit(X[i]!)]));
  const s = score(m);
  results.push({ k, ...s });
  if ([0, 1, 2, 3, 5, 8, 12].includes(k))
    console.log(String(k).padEnd(19) + s.floor.toFixed(4).padEnd(16) + s.recall.toFixed(3) + (k === 0 ? "   <- as stored (E1 measured 0.169)" : ""));
}
const best = results.reduce((a, b) => (b.recall > a.recall ? b : a));
console.log(`\nbest: ${best.recall.toFixed(3)} after removing ${best.k} direction(s)`);
console.log(`name-only, for comparison (E1): 0.846`);
db.close();

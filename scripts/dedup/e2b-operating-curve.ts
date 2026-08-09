/**
 * E2b — the operating curve. Brian, 2026-08-09:
 *
 *   "I am betting we have a joint function of cosine-sim acceptance threshold and bits. Simple, really. A
 *    very specific name that near-matches another very-specific name is a no brainer. There's probably a
 *    whole operating curve of such things, not just a couple of thresholds at 60 and 100 bits."
 *
 * He is right that AND/OR are two axis-aligned rectangles cut out of a 2-D surface. This measures the
 * surface, and tests one extra idea the failure cases suggested: the discriminating quantity may not be how
 * much the two names SHARE, but how much they DON'T. Two doc paths sharing "durable-map-state" carry 196
 * bits of agreement and a large, meaningful residue; contentHash vs content_hash has a residue of nearly
 * zero. So AGREEMENT RATIO = shared / (shared + residual) is the candidate feature.
 *
 * Zero new compute, zero LLM calls; everything comes from E1's sidecar and the fixture, read-only.
 * Every number is 5-fold cross-validated where a fit is involved, because 130 positives and 300 negatives is
 * not enough to trust an in-sample boundary, and an uncrossvalidated fit is how a "curve" becomes a story.
 */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "graphs/testgraph/dedup";
const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
type Pair = { a: string; b: string; why: string };
const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8")) as { sets: Record<string, { pairs: Pair[] }> };
const e1 = JSON.parse(readFileSync(join(dir, "e1-representations.json"), "utf8")) as {
  raw_scores: Record<string, Record<string, number[]>>; report: Record<string, { floors: { zero_fp: number } }>;
};

const rows = db.prepare("SELECT id, subtype, name FROM nodes WHERE subtype NOT IN ('chunk','document')").all() as { id: string; subtype: string; name: string }[];
const byId = new Map(rows.map((r) => [r.id, r]));
const nm = (i: string): string => byId.get(i)?.name ?? "?";
const sub = (i: string): string => byId.get(i)?.subtype ?? "?";

// character-trigram model over the corpus's own prose (same as E2)
const bg = db.prepare("SELECT description FROM nodes WHERE subtype='chunk'").all() as { description: string }[];
const tri = new Map<string, number>(); let tot = 0;
for (const r of bg) { const s = ` ${r.description.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `; for (let i = 0; i + 3 <= s.length; i++) { const g = s.slice(i, i + 3); tri.set(g, (tri.get(g) ?? 0) + 1); tot++; } }
const V = tri.size;
const bits = (s: string): number => {
  if (!s) return 0;
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `; let b = 0;
  for (let i = 0; i + 3 <= t.length; i++) b += -Math.log2(((tri.get(t.slice(i, i + 3)) ?? 0) + 1) / (tot + V));
  return b;
};
function lcs(a: string, b: string): string {
  let best = ""; const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) { let d = 0; for (let j = 1; j <= b.length; j++) { const t = prev[j]!; if (a[i - 1] === b[j - 1]) { prev[j] = d + 1; if (prev[j]! > best.length) best = a.slice(i - prev[j]!, i); } else prev[j] = 0; d = t; } }
  return best;
}
const strip = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Feat = { cos: number; shared: number; residual: number; ratio: number; y: number; p: Pair };
function featurize(p: Pair, cos: number, y: number): Feat {
  const A = strip(nm(p.a)), B = strip(nm(p.b));
  const sh = lcs(A, B);
  const shared = bits(sh);
  // The residue: what is left of each name once the agreed part is removed. This is the "how much do they
  // DISAGREE" term the three false admits all had in common.
  const residual = bits(A.replace(sh, "")) + bits(B.replace(sh, ""));
  return { cos, shared, residual, ratio: shared / (shared + residual + 1e-9), y, p };
}
const REP = "name";
const data: Feat[] = [
  ...labels.sets["P-variant"]!.pairs.map((p, i) => featurize(p, e1.raw_scores[REP]!["P-variant"]![i]!, 1)),
  ...labels.sets["N-hard"]!.pairs.map((p, i) => featurize(p, e1.raw_scores[REP]!["N-hard"]![i]!, 0)),
];
const P = data.filter((d) => d.y === 1), Nn = data.filter((d) => d.y === 0);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

console.log("=== is the RESIDUE the missing feature? ===");
console.log(`  positives (P-variant)  shared ${mean(P.map((d) => d.shared)).toFixed(0)} bits · residual ${mean(P.map((d) => d.residual)).toFixed(0)} bits · ratio ${mean(P.map((d) => d.ratio)).toFixed(3)}`);
console.log(`  negatives (N-hard)     shared ${mean(Nn.map((d) => d.shared)).toFixed(0)} bits · residual ${mean(Nn.map((d) => d.residual)).toFixed(0)} bits · ratio ${mean(Nn.map((d) => d.ratio)).toFixed(3)}`);

/** Recall at the strictest threshold on `score` that admits at most `budget` negatives. */
function frontier(score: (d: Feat) => number, budget: number): { recall: number; thr: number; admitted: number } {
  const negs = Nn.map(score).sort((a, b) => b - a);
  const thr = budget < negs.length ? negs[budget]! : -Infinity;   // strictly above the (budget+1)-th negative
  const recall = P.filter((d) => score(d) > thr).length / P.length;
  return { recall, thr, admitted: Nn.filter((d) => score(d) > thr).length };
}

console.log("\n=== single features, as operating curves (recall at N tolerated false admits) ===");
const singles: [string, (d: Feat) => number][] = [
  ["cosine", (d) => d.cos], ["shared bits", (d) => d.shared],
  ["1 / residual", (d) => -d.residual], ["agreement ratio", (d) => d.ratio],
];
console.log("  feature".padEnd(20), [0, 1, 3, 6, 15].map((b) => `FP<=${b}`.padEnd(8)).join(""));
for (const [k, f] of singles) console.log(`  ${k.padEnd(18)}`, [0, 1, 3, 6, 15].map((b) => frontier(f, b).recall.toFixed(3).padEnd(8)).join(""));

// --- the joint boundary, fit rather than guessed ---------------------------------------------------------
// Logistic regression on standardized features. Log-odds is the principled way to ADD two independent kinds
// of evidence ("the embedder thinks so" + "the string agreement is improbable"), which is exactly the joint
// function Brian described. 5-fold CV so the reported curve is out-of-sample.
function fit(train: Feat[], cols: ((d: Feat) => number)[]): (d: Feat) => number {
  const X = train.map((d) => [1, ...cols.map((c) => c(d))]);
  const mu = X[0]!.map((_, j) => (j === 0 ? 0 : mean(X.map((r) => r[j]!))));
  const sd = X[0]!.map((_, j) => (j === 0 ? 1 : Math.sqrt(mean(X.map((r) => (r[j]! - mu[j]!) ** 2))) || 1));
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]!) / sd[j]!));
  const y = train.map((d) => d.y);
  const w = new Array<number>(Z[0]!.length).fill(0);
  for (let it = 0; it < 4000; it++) {
    const g = new Array<number>(w.length).fill(0);
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]!.reduce((a, v, j) => a + v * w[j]!, 0);
      const e = 1 / (1 + Math.exp(-z)) - y[i]!;
      for (let j = 0; j < w.length; j++) g[j]! += e * Z[i]![j]!;
    }
    for (let j = 0; j < w.length; j++) w[j]! -= (0.05 / Z.length) * g[j]! * Z.length * 0.02 + 0.0002 * w[j]!;
  }
  return (d: Feat): number => {
    const r = [1, ...cols.map((c) => c(d))].map((v, j) => (v - mu[j]!) / sd[j]!);
    return r.reduce((a, v, j) => a + v * w[j]!, 0);
  };
}
const COMBOS: [string, ((d: Feat) => number)[]][] = [
  ["cosine + shared", [(d) => d.cos, (d) => d.shared]],
  ["cosine + ratio", [(d) => d.cos, (d) => d.ratio]],
  ["cosine + shared + residual", [(d) => d.cos, (d) => d.shared, (d) => d.residual]],
];
console.log("\n=== joint boundaries, 5-fold CROSS-VALIDATED (out-of-sample recall) ===");
console.log("  model".padEnd(32), [0, 1, 3, 6, 15].map((b) => `FP<=${b}`.padEnd(8)).join(""));
const idx = data.map((_, i) => i);
const cvOut: Record<string, number[]> = {};
for (const [name, cols] of COMBOS) {
  const oof = new Map<number, number>();
  for (let k = 0; k < 5; k++) {
    const tr = idx.filter((i) => i % 5 !== k).map((i) => data[i]!);
    const f = fit(tr, cols);
    for (const i of idx.filter((i) => i % 5 === k)) oof.set(i, f(data[i]!));
  }
  const sc = (d: Feat): number => oof.get(data.indexOf(d))!;
  const line = [0, 1, 3, 6, 15].map((b) => frontier(sc, b).recall.toFixed(3).padEnd(8)).join("");
  cvOut[name] = [0, 1, 3, 6, 15].map((b) => frontier(sc, b).recall);
  console.log(`  ${name.padEnd(30)}`, line);
}

console.log("\n=== what the joint rule does to the three known false admits ===");
const f = fit(data, [(d) => d.cos, (d) => d.shared, (d) => d.residual]);
const worst = Nn.map((d) => ({ d, s: f(d) })).sort((a, b) => b.s - a.s).slice(0, 5);
for (const { d, s } of worst)
  console.log(`  score ${s.toFixed(2)}  shared ${d.shared.toFixed(0)} / residual ${d.residual.toFixed(0)} (ratio ${d.ratio.toFixed(2)}) cos ${d.cos.toFixed(3)}  "${nm(d.p.a)}" (${sub(d.p.a)}) vs "${nm(d.p.b)}" (${sub(d.p.b)})`);

writeFileSync(join(dir, "e2b-operating-curve.json"), JSON.stringify({
  analysis: "E2b operating curve (Brian's joint-function bet, 2026-08-09)",
  note: "joint models are 5-fold cross-validated; single features need no fit",
  singles: Object.fromEntries(singles.map(([k, fn]) => [k, [0, 1, 3, 6, 15].map((b) => frontier(fn, b).recall)])),
  joint_cv: cvOut,
  budgets: [0, 1, 3, 6, 15],
  feature_means: { positives: { shared: mean(P.map((d) => d.shared)), residual: mean(P.map((d) => d.residual)), ratio: mean(P.map((d) => d.ratio)) },
                   negatives: { shared: mean(Nn.map((d) => d.shared)), residual: mean(Nn.map((d) => d.residual)), ratio: mean(Nn.map((d) => d.ratio)) } },
}, null, 1));
db.close();

/**
 * Data for the sequel tutorial: attention as a graph, and Shannon's guessing game over Brian's own corpus.
 *
 * The pedagogical bet: Shannon (1951) measured the entropy of ENGLISH. The interesting question here is the
 * entropy of THIS corpus to the person who wrote most of it — where a reader is surprised and a model is not,
 * and the reverse. So the game's target text and its comparison model both come from the real chunks.
 * Read-only.
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";

const db = new Database("graphs/testgraph/graph.db", { readonly: true, fileMustExist: true });
const chunks = (db.prepare("SELECT description FROM nodes WHERE subtype='chunk'").all() as { description: string }[]).map((r) => r.description);

// word-level tokenisation, punctuation kept as its own token so the model can predict sentence ends
const tok = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9_'-]+|[.,;:()]/g) ?? []);
const corpus = chunks.map(tok);
const total = corpus.reduce((a, c) => a + c.length, 0);

// trigram counts with bigram and unigram backoff — small, honest, and computable in a browser
const uni = new Map<string, number>(), bi = new Map<string, Map<string, number>>(), tri = new Map<string, Map<string, number>>();
const bump = (m: Map<string, Map<string, number>>, k: string, w: string): void => {
  if (!m.has(k)) m.set(k, new Map());
  const inner = m.get(k)!;
  inner.set(w, (inner.get(w) ?? 0) + 1);
};
for (const s of corpus) {
  for (let i = 0; i < s.length; i++) {
    uni.set(s[i]!, (uni.get(s[i]!) ?? 0) + 1);
    if (i >= 1) bump(bi, s[i - 1]!, s[i]!);
    if (i >= 2) bump(tri, s[i - 2]! + " " + s[i - 1]!, s[i]!);
  }
}
console.log(`${chunks.length} chunks · ${total} tokens · ${uni.size} distinct`);

// Pick passages that are (a) about this project, so Brian has real priors, and (b) long enough to play.
const SEEDS = ["the store", "a chunk", "the extractor", "identity is", "the layout", "each node"];
type Passage = { text: string[]; from: string };
const passages: Passage[] = [];
for (const seed of SEEDS) {
  const st = tok(seed);
  for (const s of corpus) {
    for (let i = 0; i + st.length + 14 < s.length; i++) {
      if (st.every((t, j) => s[i + j] === t)) {
        passages.push({ text: s.slice(i, i + 18), from: seed });
        break;
      }
    }
    if (passages.length && passages[passages.length - 1]!.from === seed) break;
  }
}
console.log(`${passages.length} playable passages`);

// For each position in each passage, ship the model's top-12 continuations with probabilities, so the page
// can score a human guess without shipping the whole model.
const topK = (ctx2: string, ctx1: string, k = 12): { w: string; p: number }[] => {
  let m = tri.get(ctx2 + " " + ctx1);
  let src = "tri";
  if (!m || [...m.values()].reduce((a, b) => a + b, 0) < 3) { m = bi.get(ctx1); src = "bi"; }
  if (!m || [...m.values()].reduce((a, b) => a + b, 0) < 2) {
    const arr = [...uni.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    const tot = total;
    return arr.map(([w, c]) => ({ w, p: Number((c / tot).toFixed(5)) }));
  }
  const tot = [...m.values()].reduce((a, b) => a + b, 0);
  void src;
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([w, c]) => ({ w, p: Number((c / tot).toFixed(5)) }));
};

const out = passages.map((p) => ({
  from: p.from,
  tokens: p.text,
  // predictions start once there are two tokens of context
  preds: p.text.map((_, i) => (i < 2 ? null : topK(p.text[i - 2]!, p.text[i - 1]!))),
}));

writeFileSync("/tmp/tutorial2-data.json", JSON.stringify({
  corpus: { chunks: chunks.length, tokens: total, distinct: uni.size },
  passages: out,
}));
console.log(`wrote /tmp/tutorial2-data.json (${(JSON.stringify({ passages: out }).length / 1024).toFixed(0)} KB)`);
db.close();

// --- token embeddings from corpus co-occurrence, so the attention demo attends to something REAL ----------
// PPMI over a +/-4 window, then power-iteration SVD to 16 dims. Small, but genuinely derived from the text,
// which matters: attention computed over random vectors demonstrates the arithmetic and teaches nothing
// about what attention is FOR.
const DEMO = "the store dedups on content hash so the mapper owns identity policy".split(" ");
const vocabSet = new Set<string>(DEMO);
for (const p of passages) for (const t of p.text) vocabSet.add(t);
const vocab = [...vocabSet].filter((w) => (uni.get(w) ?? 0) >= 2);
const vi = new Map(vocab.map((w, i) => [w, i]));
const V = vocab.length;
const co = Array.from({ length: V }, () => new Float64Array(V));
for (const s of corpus) {
  for (let i = 0; i < s.length; i++) {
    const a = vi.get(s[i]!); if (a === undefined) continue;
    for (let j = Math.max(0, i - 4); j <= Math.min(s.length - 1, i + 4); j++) {
      if (i === j) continue;
      const b = vi.get(s[j]!); if (b === undefined) continue;
      co[a]![b]! += 1;
    }
  }
}
const rowSum = co.map((r) => r.reduce((a, b) => a + b, 0));
const grand = rowSum.reduce((a, b) => a + b, 0) || 1;
const M = co.map((r, i) => Float64Array.from(r, (c, j) => {
  if (!c) return 0;
  const pmi = Math.log((c / grand) / ((rowSum[i]! / grand) * (rowSum[j]! / grand) || 1e-12));
  return Math.max(0, pmi);                                     // positive PMI
}));
// 16-d via power iteration + deflation on the PPMI matrix
const EDIM = 16;
const emb = Array.from({ length: V }, () => new Array<number>(EDIM).fill(0));
let work = M.map((r) => Float64Array.from(r));
for (let k = 0; k < EDIM; k++) {
  let w = new Float64Array(V).map((_, i) => Math.sin(i * 1.31 + k) + 0.05);
  for (let it = 0; it < 60; it++) {
    const nx = new Float64Array(V);
    for (let i = 0; i < V; i++) { let d = 0; for (let j = 0; j < V; j++) d += work[i]![j]! * w[j]!; for (let j = 0; j < V; j++) nx[j]! += work[i]![j]! * d; }
    const n = Math.hypot(...nx) || 1; w = nx.map((x) => x / n);
  }
  for (let i = 0; i < V; i++) { let d = 0; for (let j = 0; j < V; j++) d += work[i]![j]! * w[j]!; emb[i]![k] = d; }
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) work[i]![j]! -= emb[i]![k]! * w[j]!;
}
const norm = (v: number[]): number[] => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
writeFileSync("/tmp/tutorial2-emb.json", JSON.stringify({
  dim: EDIM,
  demo: DEMO,
  vocab: Object.fromEntries(vocab.map((w, i) => [w, norm(emb[i]!).map((x) => Number(x.toFixed(4)))])),
}));
console.log(`embeddings: ${V} tokens x ${EDIM}d -> /tmp/tutorial2-emb.json`);

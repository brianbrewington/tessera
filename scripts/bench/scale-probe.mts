// Where does the map break as the graph grows? (Brian's question: 10x nodes, 50x edges, and beyond.)
//
// Measures each stage separately, because they break at different sizes and for different reasons:
//   bootstrap settle  — O(n^2), a one-time CLI cost since slice 1 persists it
//   incremental pass  — O(|N|*|A|), what a drop-a-file actually costs
//   bundle bytes      — what the browser must parse before it can draw anything
//   per-frame edges   — what the canvas redraws 60x/second
//
// Run:  NODE_PATH="$PWD/node_modules" npx tsx scripts/bench/scale-probe.mts [maxNodes]
import { GraphStore } from "../../src/store/graphStore.js";
import { StubEmbedder } from "../../src/embedder.js";
import { layoutPass } from "../../src/layout/pass.js";
import { seedPositions, settle, type LayoutNode, type LayoutEdge } from "../../src/layout/settle.js";

const meta = { actor: "bench", cause: "scale" };
const ms = (f: () => void): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

/** Pure-layout cost at (n visible nodes, m edges) — no db, so it isolates the algorithm. */
function settleCost(n: number, m: number): number {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const seeds = seedPositions(ids);
  const nodes: LayoutNode[] = ids.map((id) => ({ id, ...seeds.get(id)!, vx: 0, vy: 0 }));
  const edges: LayoutEdge[] = Array.from({ length: m }, (_, k) => ({ a: k % n, b: (k * 7919 + 3) % n }))
    .filter((e) => e.a !== e.b);
  return ms(() => settle(nodes, edges));
}

/** What a drop-a-file costs: place `add` newcomers against `existing` frozen anchors. */
async function incrementalCost(existing: number, add: number, degree: number): Promise<number> {
  const s = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
  const ids: string[] = [];
  for (let i = 0; i < existing; i++) {
    ids.push((await s.putNode({ type: "CONCEPT", origin: "ingest", text: `c\t${i}`, name: `c${i}`, description: `c${i}` }, meta)).id);
  }
  for (let k = 0; k < existing * degree; k++) {
    const a = ids[k % existing]!, b = ids[(k * 7919 + 3) % existing]!;
    if (a !== b) await s.putEdge({ from: a, to: b, kind: "RELATED", reason: `${k}`, origin: "ingest" }, meta);
  }
  await layoutPass(s, meta); // bootstrap, not timed
  const fresh: string[] = [];
  for (let i = 0; i < add; i++) {
    fresh.push((await s.putNode({ type: "CONCEPT", origin: "ingest", text: `x\t${i}`, name: `x${i}`, description: `x${i}` }, meta)).id);
  }
  for (let i = 1; i < fresh.length; i++) await s.putEdge({ from: fresh[i - 1]!, to: fresh[i]!, kind: "RELATED", reason: `f${i}`, origin: "ingest" }, meta);
  await s.putEdge({ from: fresh[0]!, to: ids[0]!, kind: "RELATED", reason: "join", origin: "ingest" }, meta);
  const t0 = performance.now();
  await layoutPass(s, meta);
  const dt = performance.now() - t0;
  s.close();
  return dt;
}

/** Bundle bytes, extrapolated from the real per-node/per-edge payload in graphs/big. */
function bundleBytes(nodes: number, edges: number, bytesPerNode: number, bytesPerEdge: number): number {
  return nodes * bytesPerNode + edges * bytesPerEdge;
}

const BASE_N = 387;   // graphs/big, visible
const BASE_M = 416;
const args = process.argv.slice(2);
const maxN = Number(args[0] ?? 8000);

console.log("=== bootstrap settle — O(n^2), paid ONCE at the CLI since slice 1 persists it ===");
console.log("nodes   edges    settle");
for (const mult of [1, 2, 5, 10, 20]) {
  const n = BASE_N * mult;
  if (n > maxN) break;
  const m = BASE_M * mult * (mult >= 10 ? 5 : 1); // denser as it grows, per the question
  console.log(`${String(n).padStart(5)}  ${String(m).padStart(6)}   ${(settleCost(n, m) / 1000).toFixed(1)}s`);
}

console.log("\n=== incremental pass — O(|N|*|A|), what a dropped file actually costs ===");
console.log("existing  added   pass");
for (const existing of [387, 1000, 3870]) {
  if (existing > maxN) break;
  const t = await incrementalCost(existing, 30, 1);
  console.log(`${String(existing).padStart(8)}  ${String(30).padStart(5)}   ${(t / 1000).toFixed(2)}s`);
}

console.log("\n=== bundle bytes the browser must parse before the first pixel ===");
// measured from graphs/big: 748KB for 598 nodes + 1316 edges (edges carry reason + all assertions)
const BPN = 420, BPE = 380;
console.log("nodes   edges     bundle");
for (const [n, m] of [[598, 1316], [3870, 20800], [5980, 65800], [38700, 208000]] as const) {
  const mb = bundleBytes(n, m, BPN, BPE) / 1e6;
  console.log(`${String(n).padStart(5)}  ${String(m).padStart(6)}   ${mb.toFixed(1)} MB`);
}

console.log("\n=== per-frame draw load (canvas redraws every edge, 60x/sec) ===");
for (const m of [416, 20800, 65800, 208000]) {
  console.log(`${String(m).padStart(6)} edges -> ${((m * 60) / 1e6).toFixed(1)}M segments/sec at 60fps`);
}

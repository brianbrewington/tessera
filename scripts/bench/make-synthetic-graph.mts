// Build a synthetic graph at a chosen scale, so the viewer can be tested at sizes we do not yet have real
// corpora for. The bundle-size numbers in scale-probe.mts are EXTRAPOLATED; this exists to replace them with
// a real file you can actually open.
//
// Structure is deliberately corpus-shaped rather than uniform random, because layout cost and legibility both
// depend on structure: communities with dense interiors, a few high-degree hubs, sparse bridges between
// communities, and provenance (documents + chunks) hanging off the semantic nodes.
//
// Run:  NODE_PATH="$PWD/node_modules" npx tsx scripts/bench/make-synthetic-graph.mts <graphName> <visibleNodes> <edgesPerNode>
//   e.g. ... make-synthetic-graph.mts synth10x 3870 5.4
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../../src/store/graphStore.js";
import { StubEmbedder } from "../../src/embedder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const meta = { actor: "bench", cause: "synthetic" };

const name = process.argv[2] ?? "synth10x";
const nVisible = Number(process.argv[3] ?? 3870);
const edgesPerNode = Number(process.argv[4] ?? 5.4);

// Deterministic PRNG (mulberry32). The obvious textbook LCG is WRONG in JS: seed * 1103515245 exceeds
// 2^53, the float multiply silently drops low bits, and the generator collapses to a ~16k cycle. That
// produced a graph whose edge attempts kept redrawing the same pairs, so putEdge deduped them and the
// result had degree ~1.6 — a uniform dot field that looked like a scale problem and was a generator bug.
let seed = 0x9e3779b9;
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const dir = join(ROOT, "graphs", name);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });

const TYPES = ["CONCEPT", "PERSON", "PROJECT", "INSIGHT"] as const;
const nComms = Math.max(4, Math.round(nVisible / 60)); // ~60 nodes per community, like a document's worth
const t0 = Date.now();

// --- semantic nodes, grouped into communities that share vocabulary (so embeddings cluster too) ---
const comms: string[][] = Array.from({ length: nComms }, () => []);
for (let i = 0; i < nVisible; i++) {
  const c = i % nComms;
  const type = TYPES[i % TYPES.length]!;
  const n = await store.putNode(
    {
      type, origin: "ingest",
      text: `${type.toLowerCase()}\tc${c}-n${i}`,
      name: `c${c} entity ${i}`,
      description: `topic${c} alpha beta gamma delta entity ${i} — a synthetic node in community ${c}`,
    },
    meta,
  );
  comms[c]!.push(n.id);
  if (i % 500 === 0) process.stdout.write(`\r  nodes ${i}/${nVisible}`);
}
process.stdout.write(`\r  nodes ${nVisible}/${nVisible}\n`);

// --- edges: dense inside a community, sparse bridges between, plus hubs ---
const targetEdges = Math.round(nVisible * edgesPerNode);
let made = 0, attempts = 0;
const MAX_ATTEMPTS = targetEdges * 12; // dedup means attempts != edges; keep going until the target is met
while (made < targetEdges && attempts < MAX_ATTEMPTS) {
  attempts++;
  {
  const c = Math.floor(rnd() * nComms);
  const members = comms[c]!;
  let a = pick(members);
  let b = rnd() < 0.12 ? pick(comms[Math.floor(rnd() * nComms)]!) : pick(members); // 12% bridges
  if (rnd() < 0.08) a = members[0]!; // hub: first member of each community accumulates degree
  if (a === b) continue;
  try {
    const before = store.countEdges();
    await store.putEdge({ from: a, to: b, kind: "RELATED", reason: `${a} relates to ${b} in community ${c}`, origin: "ingest" }, meta);
    if (store.countEdges() > before) made++; // a repeat REINFORCES rather than throwing — do not count it
  } catch {
    /* UNIQUE collision on an already-present pair — fine, skip */
  }
  if (attempts % 2000 === 0) process.stdout.write(`\r  edges ${made}/${targetEdges} (${attempts} attempts)`);
  }
}
process.stdout.write(`\r  edges ${made}/${targetEdges}\n`);

// --- provenance: documents + chunks, hidden by default but carried in the bundle ---
const nDocs = nComms;
for (let d = 0; d < nDocs; d++) {
  const doc = await store.putNode(
    { type: "SOURCE", subtype: "document", origin: "ingest", text: `source\tdoc${d}`, name: `document ${d}`, description: `Document: synthetic ${d}` },
    meta,
  );
  for (let k = 0; k < 16; k++) {
    const ch = await store.putNode(
      {
        type: "SOURCE", subtype: "chunk", origin: "ingest",
        text: `chunk\tdoc${d}\tc${k}`, name: `chunk ${k} of document ${d}`,
        description: `Synthetic chunk ${k} of document ${d}. `.repeat(12), // realistic chunk bulk in the bundle
      },
      meta,
    );
    await store.putEdge({ from: ch.id, to: doc.id, kind: "ORIGINATED_FROM", reason: `chunk ${k} is from document ${d}`, origin: "ingest" }, meta);
    for (let m = 0; m < 4; m++) {
      const ent = pick(comms[d % nComms]!);
      try {
        await store.putEdge({ from: ent, to: ch.id, kind: "APPEARED_IN", reason: `entity appears in chunk ${k}`, origin: "ingest" }, meta);
      } catch { /* dup */ }
    }
  }
  if (d % 5 === 0) process.stdout.write(`\r  provenance ${d}/${nDocs}`);
}
process.stdout.write(`\r  provenance ${nDocs}/${nDocs}\n`);

const totalNodes = store.allNodes().length;
const totalEdges = store.countEdges();
store.close();
console.log(`\nbuilt graphs/${name}: ${totalNodes} nodes, ${totalEdges} edges, ${nComms} communities in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`next:  npx tsx scripts/cli.ts view ${name}`);

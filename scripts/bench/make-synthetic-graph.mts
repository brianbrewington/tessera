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

// --- edges: PREFERENTIAL ATTACHMENT within communities, hub-mediated bridges between ---
//
// Rich-get-richer (Barabasi-Albert style), because a flat degree distribution makes prominence-ranked
// tiling untestable: if every node has roughly the same degree there is no principled way to choose the
// top N, which is exactly what the first synthetic graph failed to exercise. Real corpora are power-law —
// a few hubs carry most of the structure — and that unevenness is the thing hierarchy exploits.
//
// networkx has the well-tested versions of this (barabasi_albert_graph, powerlaw_cluster_graph, and
// LFR_benchmark_graph which also gives ground-truth communities). This machine has no pip/venv, so this is
// a hand-rolled equivalent: BA within each community, plus bridges drawn preferentially so hubs mediate
// between communities the way they do in real link graphs.
const M_ATTACH = Math.max(2, Math.round(edgesPerNode / 2)); // each arriving node makes ~m edges -> mean degree ~2m
const BRIDGE_FRAC = 0.1;
let made = 0;

/** Repeated-node list: sampling it uniformly IS sampling proportional to degree. */
const repeated: string[][] = comms.map(() => []);
const allHubs: string[] = [];

for (let c = 0; c < nComms; c++) {
  const members = comms[c]!;
  const rep = repeated[c]!;
  // seed core: a small fully-connected clique so attachment has something to bite on
  const m0 = Math.min(M_ATTACH + 1, members.length);
  for (let i = 0; i < m0; i++) {
    for (let j = i + 1; j < m0; j++) {
      const before = store.countEdges();
      await store.putEdge({ from: members[i]!, to: members[j]!, kind: "RELATED", reason: `seed clique of community ${c}`, origin: "ingest" }, meta);
      if (store.countEdges() > before) made++;
      rep.push(members[i]!, members[j]!);
    }
  }
  // preferential attachment for the rest
  for (let k = m0; k < members.length; k++) {
    const node = members[k]!;
    const targets = new Set<string>();
    let guard = 0;
    while (targets.size < Math.min(M_ATTACH, rep.length) && guard++ < M_ATTACH * 20) {
      const t = rep[Math.floor(rnd() * rep.length)]!;
      if (t !== node) targets.add(t);
    }
    for (const t of targets) {
      const before = store.countEdges();
      await store.putEdge({ from: node, to: t, kind: "RELATED", reason: `${node} attaches to hub ${t} in community ${c}`, origin: "ingest" }, meta);
      if (store.countEdges() > before) made++;
      rep.push(node, t); // both endpoints gain degree -> richer nodes keep getting richer
    }
    if (k % 200 === 0) process.stdout.write(`\r  edges ${made} (community ${c}/${nComms})`);
  }
  // this community's hub = its highest-degree member, for bridging
  const degOf = new Map<string, number>();
  for (const id of rep) degOf.set(id, (degOf.get(id) ?? 0) + 1);
  allHubs.push([...degOf.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
}

// bridges: preferentially attached at BOTH ends, so inter-community links run hub-to-hub
const nBridges = Math.round(made * BRIDGE_FRAC);
for (let b = 0; b < nBridges; b++) {
  const ca = Math.floor(rnd() * nComms);
  let cb = Math.floor(rnd() * nComms);
  if (cb === ca) cb = (cb + 1) % nComms;
  const a = rnd() < 0.6 ? allHubs[ca]! : repeated[ca]![Math.floor(rnd() * repeated[ca]!.length)]!;
  const bb = rnd() < 0.6 ? allHubs[cb]! : repeated[cb]![Math.floor(rnd() * repeated[cb]!.length)]!;
  if (a === bb) continue;
  const before = store.countEdges();
  await store.putEdge({ from: a, to: bb, kind: "RELATED", reason: `bridge between community ${ca} and ${cb}`, origin: "ingest" }, meta);
  if (store.countEdges() > before) made++;
}
process.stdout.write(`\r  edges ${made} (preferential attachment, ${nBridges} bridges)\n`);

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

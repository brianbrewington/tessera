// Weighted intersection queries — "how are these personas connected, and how strongly?"
//
// The goal (Brian): organize personas that are STRONGLY CONNECTED and reason about their
// intersections VIA INTERMEDIATE NODES. This module is the pure, deterministic core; GraphStore
// wraps it (builds the adjacency from the db and hydrates results into NodeRecords).
//
// The weighting model, grounded in what the graph actually stores:
//   - Connectivity travels the SEMANTIC spine (RELATED by default). Provenance edges (APPEARED_IN,
//     ORIGINATED_FROM) are excluded — a shared chunk/document is not a real-world connection.
//   - Each edge carries a conductance = its hebbianWeight (how many times the relationship was
//     asserted/reinforced; ≥1). Parallel edges between the same pair combine by MAX (strongest link).
//   - A path's STRENGTH is its BOTTLENECK: the minimum conductance along the chain — a connection is
//     only as strong as its weakest link (the "widest path"). This is what "weighted path" means here;
//     it rewards chains that stay on well-reinforced edges and never inflates with length.
//   - For ranking the shared intermediates that BIND a set (connectorsOf), a node's contribution is
//     scaled by its DISTINCTIVENESS = 1/log2(2+degree): a rare shared concept is stronger evidence of
//     connection than a popular hub everyone touches (TF-IDF, on the graph).
//
// Everything here is O(branching^maxHops)-bounded with small default hop limits and an explicit
// exploration cap, so it stays cheap on a dense graph and can never run away.

import type { EdgeRecord, EdgeKind } from "../schema.js";

// Default connective kinds: the semantic spine only. Provenance is not connection.
export const CONNECTIVE_KINDS: EdgeKind[] = ["RELATED", "RESONATES_WITH", "REFERENCES"];

export interface Adjacency {
  adj: Map<string, { to: string; w: number }[]>; // undirected; w = combined conductance
  degree: Map<string, number>; // connective-spine degree (neighbor count) per node
}

export interface AdjacencyOptions {
  kinds?: EdgeKind[]; // which edge kinds carry connectivity; default CONNECTIVE_KINDS
  weightOf?: (e: EdgeRecord) => number; // conductance per edge; default max(hebbianWeight, 1)
}

const defaultWeightOf = (e: EdgeRecord): number => Math.max(1, e.hebbianWeight || 1);

// Build an undirected adjacency over the connective spine. Parallel edges (same pair, e.g. differing
// polarity) combine by MAX conductance — the strongest link between the two nodes stands for the pair.
export function buildAdjacency(edges: EdgeRecord[], opts: AdjacencyOptions = {}): Adjacency {
  const kinds = new Set(opts.kinds ?? CONNECTIVE_KINDS);
  const weightOf = opts.weightOf ?? defaultWeightOf;
  const pair = new Map<string, { to: string; w: number; from: string }>(); // canonical pair -> best
  for (const e of edges) {
    if (!kinds.has(e.kind)) continue;
    if (e.from === e.to) continue; // no self-loops
    const w = weightOf(e);
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
    const key = `${a}\t${b}`;
    const prev = pair.get(key);
    if (!prev || w > prev.w) pair.set(key, { from: a, to: b, w });
  }
  const adj = new Map<string, { to: string; w: number }[]>();
  const push = (from: string, to: string, w: number): void => {
    const list = adj.get(from) ?? [];
    list.push({ to, w });
    adj.set(from, list);
  };
  for (const { from, to, w } of pair.values()) {
    push(from, to, w);
    push(to, from, w);
  }
  // Deterministic neighbor order (strongest first, then id) so traversal/tie-breaks are stable.
  for (const list of adj.values()) list.sort((x, y) => y.w - x.w || (x.to < y.to ? -1 : 1));
  const degree = new Map<string, number>();
  for (const [id, list] of adj) degree.set(id, list.length);
  return { adj, degree };
}

export interface WeightedPath {
  nodes: string[]; // [a, ...intermediates..., b]
  edges: number[]; // per-hop conductance (length = nodes.length - 1)
  strength: number; // bottleneck: min(edges) — the "weighted path" strength
  hops: number; // edge count
  maxIntermediateDegree: number; // largest connective degree among the intermediates (hub-routing signal; 0 if none)
}

export interface PathsOptions {
  maxHops?: number; // longest chain (edge count) to consider; default 3
  topK?: number; // how many best paths to return; default 5
}

const EXPLORE_CAP = 200_000; // hard backstop on DFS steps — the hop bound already keeps this tiny

// Enumerate simple paths a→b up to maxHops edges, ranked by bottleneck strength (desc), then fewer
// hops, then path lexicographically — fully deterministic. Direct a–b edges (no intermediate) are
// included (hops=1); callers that only want via-intermediate paths filter on hops>=2.
export function pathsBetween(adj: Adjacency, a: string, b: string, opts: PathsOptions = {}): WeightedPath[] {
  const maxHops = opts.maxHops ?? 3;
  const topK = opts.topK ?? 5;
  if (a === b || !adj.adj.has(a) || !adj.adj.has(b)) return [];
  const results: WeightedPath[] = [];
  const nodes: string[] = [a];
  const edges: number[] = [];
  const onPath = new Set<string>([a]);
  let explored = 0;
  const record = (): void => {
    const strength = edges.reduce((m, w) => Math.min(m, w), Infinity);
    const inter = nodes.slice(1, -1);
    const maxIntermediateDegree = inter.reduce((m, id) => Math.max(m, adj.degree.get(id) ?? 0), 0);
    results.push({ nodes: [...nodes], edges: [...edges], strength, hops: edges.length, maxIntermediateDegree });
  };
  const dfs = (cur: string): void => {
    if (explored++ > EXPLORE_CAP) return;
    if (cur === b) {
      if (edges.length > 0) record();
      return; // a simple path ends at b — never route THROUGH it
    }
    if (edges.length >= maxHops) return;
    for (const { to, w } of adj.adj.get(cur) ?? []) {
      if (onPath.has(to)) continue;
      nodes.push(to);
      edges.push(w);
      onPath.add(to);
      dfs(to);
      nodes.pop();
      edges.pop();
      onPath.delete(to);
    }
  };
  dfs(a);
  results.sort(
    (x, y) => y.strength - x.strength || x.hops - y.hops || (x.nodes.join("\t") < y.nodes.join("\t") ? -1 : 1),
  );
  return results.slice(0, topK);
}

// Best route from `seed` to every other node within maxHops: highest bottleneck strength, and among
// equal-strength routes the fewest hops. Not restricted to simple paths (revisiting can never improve
// a bottleneck, so the maxima are unaffected) — cheap and correct.
function reachStrength(adj: Adjacency, seed: string, maxHops: number): Map<string, { strength: number; hops: number }> {
  const best = new Map<string, { strength: number; hops: number }>();
  const walk = (cur: string, hops: number, strength: number): void => {
    for (const { to, w } of adj.adj.get(cur) ?? []) {
      if (to === seed) continue;
      const s = Math.min(strength, w);
      const h = hops + 1;
      const prev = best.get(to);
      if (prev === undefined || s > prev.strength || (s === prev.strength && h < prev.hops)) best.set(to, { strength: s, hops: h });
      if (h < maxHops) walk(to, h, s);
    }
  };
  walk(seed, 0, Infinity);
  return best;
}

export interface Connector {
  id: string;
  seedsReached: number; // how many of the seeds this node bridges (>= minSeeds)
  strengthSum: number; // summed bottleneck strength over the seeds it reaches (raw, undiscounted)
  degree: number; // connective-spine degree (hub-ness)
  distinctiveness: number; // 1/log2(2+degree) — rare bridges score higher
  bridgeScore: number; // distinctiveness * Σ(strength/hops) — the ranking key (near, strong, rare wins)
}

export interface ConnectorsOptions {
  maxHops?: number; // how far an intermediate may sit from a seed; default 2
  minSeeds?: number; // a connector must bind at least this many seeds; default 2 (all seeds if fewer)
}

// The shared middle: nodes that bridge >= minSeeds of the seeds, ranked so a RARE shared node
// (low degree) outranks a popular hub that everyone incidentally touches.
export function connectorsOf(adj: Adjacency, seeds: string[], opts: ConnectorsOptions = {}): Connector[] {
  const maxHops = opts.maxHops ?? 2;
  const seedList = [...new Set(seeds)].filter((s) => adj.adj.has(s));
  const minSeeds = Math.min(opts.minSeeds ?? 2, seedList.length);
  if (seedList.length < 2 || minSeeds < 2) return [];
  const seedSet = new Set(seedList);
  const agg = new Map<string, { n: number; sum: number; disc: number }>();
  for (const s of seedList) {
    for (const [id, { strength, hops }] of reachStrength(adj, s, maxHops)) {
      if (seedSet.has(id)) continue; // a seed is not its own connector
      const a = agg.get(id) ?? { n: 0, sum: 0, disc: 0 };
      a.n += 1;
      a.sum += strength; // raw bottleneck (reported)
      a.disc += strength / hops; // distance-discounted — a directly-shared neighbor beats one reached via a hub
      agg.set(id, a);
    }
  }
  const out: Connector[] = [];
  for (const [id, a] of agg) {
    if (a.n < minSeeds) continue;
    const degree = adj.degree.get(id) ?? 1;
    const distinctiveness = 1 / Math.log2(2 + degree);
    out.push({
      id,
      seedsReached: a.n,
      strengthSum: a.sum,
      degree,
      distinctiveness,
      bridgeScore: distinctiveness * a.disc,
    });
  }
  out.sort((x, y) => y.bridgeScore - x.bridgeScore || y.seedsReached - x.seedsReached || (x.id < y.id ? -1 : 1));
  return out;
}

export interface AffinityOptions extends PathsOptions {}

// A single scalar for "how strongly connected are A and B" — the sum of the top paths' strengths,
// each discounted by length (a direct/short strong chain counts for more than a long faint one).
// Suitable for ranking/organizing personas by pairwise closeness. 0 = no connection within maxHops.
export function affinity(adj: Adjacency, a: string, b: string, opts: AffinityOptions = {}): number {
  const paths = pathsBetween(adj, a, b, { maxHops: opts.maxHops ?? 3, topK: opts.topK ?? 8 });
  return paths.reduce((acc, p) => acc + p.strength / Math.pow(2, Math.max(0, p.hops - 1)), 0);
}

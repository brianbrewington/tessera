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
    const w = Math.max(0, weightOf(e)); // clamp: a custom weightOf must not inject a negative conductance
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

const EXPLORE_CAP = 200_000; // hard backstop on traversal steps — the hop bound already keeps this tiny at default hops

export interface PathsOptions {
  maxHops?: number; // longest chain (edge count) to consider; default 3
  topK?: number; // how many best paths to return; default 5
  exploreCap?: number; // safety cap on DFS steps; default EXPLORE_CAP
  onTruncate?: () => void; // called (once) if the cap was hit — results are then a subset, NOT guaranteed strongest
}

// Enumerate simple paths a→b up to maxHops edges, ranked by bottleneck strength (desc), then fewer
// hops, then path lexicographically — fully deterministic. Direct a–b edges (no intermediate) are
// included (hops=1); callers that only want via-intermediate paths filter on hops>=2.
export function pathsBetween(adj: Adjacency, a: string, b: string, opts: PathsOptions = {}): WeightedPath[] {
  const maxHops = opts.maxHops ?? 3;
  const topK = opts.topK ?? 5;
  const cap = opts.exploreCap ?? EXPLORE_CAP;
  if (a === b || !adj.adj.has(a) || !adj.adj.has(b)) return [];
  const results: WeightedPath[] = [];
  const nodes: string[] = [a];
  const edges: number[] = [];
  const onPath = new Set<string>([a]);
  let explored = 0;
  let truncated = false;
  const record = (): void => {
    const strength = edges.reduce((m, w) => Math.min(m, w), Infinity);
    const inter = nodes.slice(1, -1);
    const maxIntermediateDegree = inter.reduce((m, id) => Math.max(m, adj.degree.get(id) ?? 0), 0);
    results.push({ nodes: [...nodes], edges: [...edges], strength, hops: edges.length, maxIntermediateDegree });
  };
  const dfs = (cur: string): void => {
    if (explored++ >= cap) { truncated = true; return; }
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
  if (truncated) opts.onTruncate?.(); // don't pretend a capped search returned the true strongest set
  results.sort(
    (x, y) => y.strength - x.strength || x.hops - y.hops || (x.nodes.join("\t") < y.nodes.join("\t") ? -1 : 1),
  );
  return results.slice(0, topK);
}

// Reach every node within maxHops of `seed` over the connective spine, returning per node BOTH:
//   strength = the max bottleneck (widest-path) conductance reaching it (raw connection strength), and
//   ratio    = the best strength/hops over all arrivals (a directly-shared neighbor beats one reached
//              via a hub — the "near, strong" signal connectorsOf ranks by).
// `blocked` nodes are never stepped into — for connectorsOf this is the full seed set, so a connector
// must attach to each seed by a path that does NOT transit another seed (otherwise a node hanging off
// seed B would be miscounted as also bridging seed A through B).
//
// This is a hop-bounded widest-path DP — O(maxHops · E), exact, and immune to the walk-enumeration
// blow-up a recursive traversal suffers on a dense graph at high --hops (no cap, nothing to truncate).
function reachStrength(
  adj: Adjacency,
  seed: string,
  maxHops: number,
  blocked: Set<string>,
): Map<string, { strength: number; ratio: number }> {
  const leq = new Map<string, number>(); // best bottleneck to reach node in <= h hops (grows each layer)
  const ratio = new Map<string, number>(); // best strength/hops over all arrivals so far
  let frontier = new Map<string, number>([[seed, Infinity]]); // best strength to reach each node in <= (h-1) hops
  for (let h = 1; h <= maxHops; h++) {
    const arrived = new Map<string, number>(); // best bottleneck to reach node in exactly-relaxed <= h hops this pass
    for (const [u, su] of frontier) {
      for (const { to, w } of adj.adj.get(u) ?? []) {
        if (blocked.has(to)) continue; // never transit through (or land on) a seed
        const s = Math.min(su, w);
        if (!arrived.has(to) || s > arrived.get(to)!) arrived.set(to, s);
      }
    }
    for (const [node, s] of arrived) {
      const prevLeq = leq.get(node);
      leq.set(node, prevLeq === undefined ? s : Math.max(prevLeq, s));
      const r = s / h;
      if (!ratio.has(node) || r > ratio.get(node)!) ratio.set(node, r);
    }
    frontier = new Map(leq); // relax from best-so-far strengths for the next hop layer
  }
  const out = new Map<string, { strength: number; ratio: number }>();
  for (const [node, strength] of leq) out.set(node, { strength, ratio: ratio.get(node)! });
  return out;
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
    // block ALL seeds as waypoints: a connector must reach each seed without passing through another
    for (const [id, { strength, ratio }] of reachStrength(adj, s, maxHops, seedSet)) {
      const a = agg.get(id) ?? { n: 0, sum: 0, disc: 0 };
      a.n += 1;
      a.sum += strength; // raw bottleneck strength (reported)
      a.disc += ratio; // best strength/hops — a directly-shared neighbor beats one reached via a hub
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
// Endpoints are canonicalized before the search so affinity(a,b) === affinity(b,a) ALWAYS — even if the
// path search hits its explore cap (the DFS would otherwise explore different regions from each end).
export function affinity(adj: Adjacency, a: string, b: string, opts: AffinityOptions = {}): number {
  const [x, y] = a < b ? [a, b] : [b, a];
  const paths = pathsBetween(adj, x, y, { maxHops: opts.maxHops ?? 3, topK: opts.topK ?? 8, exploreCap: opts.exploreCap, onTruncate: opts.onTruncate });
  return paths.reduce((acc, p) => acc + p.strength / Math.pow(2, Math.max(0, p.hops - 1)), 0);
}

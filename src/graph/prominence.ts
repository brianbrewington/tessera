// Edge prominence: what makes one edge more worth drawing than another (the attention budget).
//
// Measured on graphs/big before choosing these — the point being that most intuitive candidates do not
// discriminate at all:
//
//   simple random-walk traversal rate   spread     1.0x   <- EXACTLY constant, see below
//   PageRank-weighted walk              spread     2.7x
//   endpoint PageRank product           spread    96.0x
//   edge betweenness                    spread 13201.0x
//
// The random-walk rate is constant by algebra, not by accident: for a simple walk on an undirected graph the
// stationary distribution is pi(u) = deg(u)/2m, so an edge's traversal rate is
// pi(u)/deg(u) + pi(v)/deg(v) = 1/2m + 1/2m = 1/m for EVERY edge. Degree cancels exactly. Anything built on
// "how often is this edge walked" is thresholding a constant.
//
// So we compute two that do discriminate:
//   PAGERANK_PRODUCT  O(n+m) per iteration — cheap, always computed. Highlights hub-to-hub links.
//   BETWEENNESS       O(n*m) via Brandes — expensive, gated by size. Highlights the bridges that hold the
//                     map together, and (usefully) surfaces wrongly-merged hubs, since a bad merge is by
//                     construction a huge artificial bridge.

export type ProminenceMeasure = "pagerank_product" | "betweenness";
export const MEASURES: ProminenceMeasure[] = ["pagerank_product", "betweenness"];

export interface ProminenceInput {
  /** Node ids, in a stable order. */
  nodes: readonly string[];
  /** Undirected edges as [from, to, edgeId]; endpoints must be in `nodes`. */
  edges: ReadonlyArray<readonly [string, string, string]>;
}

/** PageRank by power iteration on the undirected graph (each edge contributes both directions). */
export function pagerank(input: ProminenceInput, damping = 0.85, iterations = 60, tol = 1e-10): Map<string, number> {
  const { nodes, edges } = input;
  const n = nodes.length;
  const idx = new Map(nodes.map((id, i) => [id, i]));
  const out: number[] = new Array(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    const i = idx.get(a), j = idx.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i]!.push(j);
    adj[j]!.push(i);
    out[i]!++;
    out[j]!++;
  }
  let pr: number[] = new Array(n).fill(1 / Math.max(1, n));
  for (let it = 0; it < iterations; it++) {
    const next: number[] = new Array(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] === 0) dangling += pr[i]!;
      else {
        const share = pr[i]! / out[i]!;
        for (const j of adj[i]!) next[j]! += share;
      }
    }
    const base = (1 - damping) / Math.max(1, n) + (damping * dangling) / Math.max(1, n);
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const v = base + damping * next[i]!;
      delta += Math.abs(v - pr[i]!);
      next[i] = v;
    }
    pr = next;
    if (delta < tol) break;
  }
  return new Map(nodes.map((id, i) => [id, pr[i]!]));
}

/**
 * Edge betweenness via Brandes' algorithm (unweighted, undirected). O(n*m) time, O(n+m) space.
 * Normalised by 2/(n(n-1)) — matches networkx to floating-point identity on real data.
 */
export function edgeBetweenness(input: ProminenceInput): Map<string, number> {
  const { nodes, edges } = input;
  const n = nodes.length;
  const idx = new Map(nodes.map((id, i) => [id, i]));
  const adj: Array<Array<{ to: number; edge: number }>> = Array.from({ length: n }, () => []);
  const edgeIds: string[] = [];
  edges.forEach(([a, b, id]) => {
    const i = idx.get(a), j = idx.get(b);
    if (i === undefined || j === undefined || i === j) return;
    const e = edgeIds.push(id) - 1;
    adj[i]!.push({ to: j, edge: e });
    adj[j]!.push({ to: i, edge: e });
  });
  const score: number[] = new Array(edgeIds.length).fill(0);

  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const preds: number[][] = Array.from({ length: n }, () => []);
  const predEdge: number[][] = Array.from({ length: n }, () => []);
  const queue = new Int32Array(n);
  const stack = new Int32Array(n);

  for (let s = 0; s < n; s++) {
    for (let i = 0; i < n; i++) {
      sigma[i] = 0;
      dist[i] = -1;
      delta[i] = 0;
      preds[i]!.length = 0;
      predEdge[i]!.length = 0;
    }
    sigma[s] = 1;
    dist[s] = 0;
    let qh = 0, qt = 0, sp = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const v = queue[qh++]!;
      stack[sp++] = v;
      for (const { to: w, edge } of adj[v]!) {
        if (dist[w]! < 0) {
          dist[w] = dist[v]! + 1;
          queue[qt++] = w;
        }
        if (dist[w]! === dist[v]! + 1) {
          sigma[w] = sigma[w]! + sigma[v]!;
          preds[w]!.push(v);
          predEdge[w]!.push(edge);
        }
      }
    }
    while (sp > 0) {
      const w = stack[--sp]!;
      const ps = preds[w]!;
      const pe = predEdge[w]!;
      for (let k = 0; k < ps.length; k++) {
        const v = ps[k]!;
        const c = (sigma[v]! / sigma[w]!) * (1 + delta[w]!);
        delta[v]! += c;
        score[pe[k]!]! += c;
      }
    }
  }
  // EDGE betweenness normalises by 2/(n(n-1)) — the number of node PAIRS. The node-betweenness constant
  // 2/((n-1)(n-2)) is a different formula and using it here made every value 0.5% high, caught only by
  // cross-validating against networkx on real data (383 nodes: ratio 1.00525 predicted, 1.00524 observed).
  const norm = n > 1 ? 2 / (n * (n - 1)) : 1;
  const out = new Map<string, number>();
  edgeIds.forEach((id, e) => out.set(id, (score[e]! / 2) * norm)); // /2: each pair counted from both ends
  return out;
}

/** Endpoint PageRank product — the cheap measure. */
export function pagerankProduct(input: ProminenceInput, pr?: Map<string, number>): Map<string, number> {
  const rank = pr ?? pagerank(input);
  const out = new Map<string, number>();
  for (const [a, b, id] of input.edges) {
    const ra = rank.get(a), rb = rank.get(b);
    if (ra === undefined || rb === undefined) continue;
    out.set(id, ra * rb);
  }
  return out;
}

/**
 * Betweenness is O(n*m). Past this product it costs more than a CLI command should, so callers skip it and
 * fall back to the cheap measure rather than hanging. Chosen from measurement: 3,870 nodes x 19,350 edges
 * is ~75M steps and runs in a few seconds; an order of magnitude beyond that is not interactive.
 */
export const BETWEENNESS_BUDGET = 150_000_000;

export function betweennessAffordable(nodeCount: number, edgeCount: number): boolean {
  return nodeCount * edgeCount <= BETWEENNESS_BUDGET;
}

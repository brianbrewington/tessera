// Compute and persist edge prominence for the visible subgraph (the attention budget's ranking signal).
// Runs at CLI time like the layout pass: expensive once, free at render.
import type { GraphStore } from "../store/graphStore.js";
import type { Meta } from "../schema.js";
import { isProvenance } from "../layout/incremental.js";
import { pagerank, pagerankProduct, edgeBetweenness, betweennessAffordable, type ProminenceInput } from "./prominence.js";

export interface ProminencePassResult {
  nodes: number;
  edges: number;
  measures: string[];
  betweennessSkipped: boolean;
}

export function prominencePass(store: GraphStore, meta: Meta): ProminencePassResult {
  const visible = store.allNodes().filter((n) => !isProvenance(n));
  const visibleIds = new Set(visible.map((n) => n.id));
  const edges = store
    .allEdges()
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
    .map((e) => [e.from, e.to, e.id] as const);
  const input: ProminenceInput = { nodes: visible.map((n) => n.id), edges };
  const measures: string[] = [];

  if (edges.length === 0) return { nodes: visible.length, edges: 0, measures, betweennessSkipped: false };

  const pr = pagerank(input);
  store.putEdgeProminence("pagerank_product", pagerankProduct(input, pr), meta);
  measures.push("pagerank_product");

  // Betweenness is O(n*m); skip rather than hang a CLI command on a graph too large for it.
  const affordable = betweennessAffordable(visible.length, edges.length);
  if (affordable) {
    store.putEdgeProminence("betweenness", edgeBetweenness(input), meta);
    measures.push("betweenness");
  }
  return { nodes: visible.length, edges: edges.length, measures, betweennessSkipped: !affordable };
}

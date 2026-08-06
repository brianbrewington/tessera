// The layout pass (design §3.3 + §3.6) — the single rule that covers bootstrap, incremental, and every
// mixed state, so no caller has to decide which case it is in:
//
//     always compute N = nodesLackingLayout() ∩ visible(), and run the placement on it.
//
//   A = ∅  → degenerates to the full settle (bootstrap). The only path allowed to move existing nodes,
//            because there are none.
//   N = ∅  → no work, no writes, no mutation_log ops.
//   else   → incremental, and A NEVER moves.
//
// A naive "if anything is missing, re-run the full settle" would move all of A and rewrite the geometry that
// F-2 exists to protect — every scene a user saved is pinned to it until slice 2 anchors them.
import type { GraphStore } from "../store/graphStore.js";
import type { Meta } from "../schema.js";
import { seedPositions, settle, type LayoutNode, type LayoutEdge } from "./settle.js";
import {
  isProvenance,
  componentsOf,
  placeComponent,
  componentOffset,
  bboxCentre,
  settleIncremental,
  SEMANTIC_FLOOR,
  SEMANTIC_K,
  type SeedRule,
  type AnchoredPoint,
} from "./incremental.js";

export interface LayoutPassResult {
  mode: "noop" | "bootstrap" | "incremental";
  laidOut: number;
  written: number;
  unchanged: number;
  components: number;
  /** How many components each seeding rule claimed — the branch-reachability evidence (design §10). */
  byRule: Record<SeedRule, number>;
  /**
   * Max distance from any newcomer to its own component's seedPoint, BEFORE the relax. This is the
   * honest place to police seed policy: post-relax shape cannot do it (measured — the relax washes the
   * seed out above |C| ~= 4), whereas this directly asserts "the component was placed as one thing".
   * Bounded by the jitter spiral: 18*sqrt(|C|).
   */
  preRelaxSpread: number;
}

const EMPTY_RULES = (): Record<SeedRule, number> => ({ graph: 0, semantic: 0, map: 0 });

/**
 * Lay out every visible node that lacks a position. Returns what it did, including which seeding rule
 * claimed each component — the branch-reachability numbers are reported rather than inferred, because a
 * rule that never fires in production is the defect that survived three design rewrites.
 */
export async function layoutPass(store: GraphStore, meta: Meta): Promise<LayoutPassResult> {
  const all = store.allNodes(); // rowid order — seeds are index-derived, so this IS the geometry
  const allIds = all.map((n) => n.id);
  const visible = all.filter((n) => !isProvenance(n));
  const visibleIds = visible.map((n) => n.id);
  const visibleSet = new Set(visibleIds);

  const layout = store.getLayout();
  const anchoredIds = visibleIds.filter((id) => layout.has(id));
  const newIds = visibleIds.filter((id) => !layout.has(id));

  if (newIds.length === 0) {
    return { mode: "noop", laidOut: 0, written: 0, unchanged: 0, components: 0, byRule: EMPTY_RULES(), preRelaxSpread: 0 };
  }

  // visible-endpoint adjacency (all edge kinds, matching what the browser settle springs over)
  const adj = new Map<string, Set<string>>(visibleIds.map((id) => [id, new Set<string>()]));
  const visEdges: Array<{ a: string; b: string }> = [];
  for (const e of store.allEdges()) {
    if (!visibleSet.has(e.from) || !visibleSet.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
    visEdges.push({ a: e.from, b: e.to });
  }

  // --- bootstrap: nothing anchored yet, so the full settle is safe and correct -----------------------
  if (anchoredIds.length === 0) {
    const seeds = seedPositions(allIds); // FULL list — provenance included (design §3.2)
    const idx = new Map(visibleIds.map((id, i) => [id, i]));
    const nodes: LayoutNode[] = visibleIds.map((id) => ({ id, ...seeds.get(id)!, vx: 0, vy: 0 }));
    const edges: LayoutEdge[] = visEdges.map((e) => ({ a: idx.get(e.a)!, b: idx.get(e.b)! }));
    settle(nodes, edges);
    const r = store.putLayoutBatch(nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })), meta);
    return {
      mode: "bootstrap",
      laidOut: nodes.length,
      written: r.written,
      unchanged: r.unchanged,
      components: 1,
      byRule: EMPTY_RULES(),
      preRelaxSpread: 0,
    };
  }

  // --- incremental ------------------------------------------------------------------------------------
  const anchored: AnchoredPoint[] = anchoredIds.map((id) => ({ id, ...layout.get(id)!, x: layout.get(id)!.x, y: layout.get(id)!.y }));
  const anchoredPos = new Map(anchored.map((p) => [p.id, p]));
  const anchoredIndex = new Map(anchored.map((p, i) => [p.id, i]));
  const mapCentre = bboxCentre(anchored);

  // components over edges WITHIN the newcomer set — the component is the unit that gets placed (design §3.3.1)
  const newSet = new Set(newIds);
  const newAdj = new Map<string, Set<string>>(newIds.map((id) => [id, new Set<string>()]));
  for (const e of visEdges) {
    if (newSet.has(e.a) && newSet.has(e.b)) {
      newAdj.get(e.a)!.add(e.b);
      newAdj.get(e.b)!.add(e.a);
    }
  }
  const comps = componentsOf(newIds, newAdj);
  const byRule = EMPTY_RULES();

  const placed = new Map<string, { x: number; y: number }>();
  let preRelaxSpread = 0;
  for (let j = 0; j < comps.length; j++) {
    const C = comps[j]!;

    // (a) GRAPH ANCHOR — any member with an edge into the anchored field
    // design §3.3(a) says anch is a SET: two members linking the SAME anchored node must not
    // double-weight it, or the centroid drifts toward whichever anchor happens to be linked twice.
    const anchorIds = new Set<string>();
    for (const c of C) for (const nb of adj.get(c) ?? []) if (anchoredPos.has(nb)) anchorIds.add(nb);
    const anchorPts: AnchoredPoint[] = [...anchorIds].map((id) => anchoredPos.get(id)!);
    let seed: { x: number; y: number } | null = null;
    let rule: SeedRule = "map";
    if (anchorPts.length) {
      seed = {
        x: anchorPts.reduce((s, p) => s + p.x, 0) / anchorPts.length,
        y: anchorPts.reduce((s, p) => s + p.y, 0) / anchorPts.length,
      };
      rule = "graph";
    } else {
      // (b) SEMANTIC ANCHOR — the 3 highest-degree members, stored vectors, nearest hit inside A
      const probes = [...C].sort((x, y) => (adj.get(y)?.size ?? 0) - (adj.get(x)?.size ?? 0)).slice(0, 3);
      let best: { cosine: number; id: string } | null = null;
      for (const p of probes) {
        const vec = store.vectorOf(p, "quarantine"); // stored, never re-embedded (design §3.3(b))
        if (!vec) continue;
        for (const hit of await store.querySimilar(vec, SEMANTIC_K, { index: "quarantine" })) {
          if (!anchoredPos.has(hit.node.id)) continue;
          if (!best || hit.cosine > best.cosine) best = { cosine: hit.cosine, id: hit.node.id };
        }
      }
      if (best && best.cosine >= SEMANTIC_FLOOR) {
        const p = anchoredPos.get(best.id)!;
        seed = { x: p.x, y: p.y };
        rule = "semantic";
      } else {
        // (c) MAP SEED — open space near the map, offset per component index
        const off = componentOffset(j);
        seed = { x: mapCentre.x + off.dx, y: mapCentre.y + off.dy };
        rule = "map";
      }
    }
    byRule[rule]++;
    // members land TOGETHER around one seed; the jitter guarantees distinct points, which is a
    // correctness requirement — settle() can never separate coincident nodes
    placeComponent(seed, C.length).forEach((pt, m) => {
      placed.set(C[m]!, pt);
      preRelaxSpread = Math.max(preRelaxSpread, Math.hypot(pt.x - seed!.x, pt.y - seed!.y));
    });
  }

  const newcomers: LayoutNode[] = newIds.map((id) => ({ id, ...placed.get(id)!, vx: 0, vy: 0 }));
  const newIndex = new Map(newIds.map((id, i) => [id, i]));
  const incEdges: Array<{ a: number; b: number | null; anchoredB?: number }> = [];
  for (const e of visEdges) {
    const aNew = newIndex.get(e.a);
    const bNew = newIndex.get(e.b);
    if (aNew !== undefined && bNew !== undefined) incEdges.push({ a: aNew, b: bNew });
    else if (aNew !== undefined && anchoredIndex.has(e.b)) incEdges.push({ a: aNew, b: null, anchoredB: anchoredIndex.get(e.b)! });
    else if (bNew !== undefined && anchoredIndex.has(e.a)) incEdges.push({ a: bNew, b: null, anchoredB: anchoredIndex.get(e.a)! });
    // A–A edges are skipped: neither endpoint moves, so they cannot affect anything
  }

  settleIncremental(anchored, newcomers, incEdges);
  const r = store.putLayoutBatch(newcomers.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })), meta);
  return {
    mode: "incremental",
    laidOut: newcomers.length,
    written: r.written,
    unchanged: r.unchanged,
    components: comps.length,
    byRule,
    preRelaxSpread,
  };
}

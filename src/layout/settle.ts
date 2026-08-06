// The force layout, ported out of the browser so the CLI can own it (design §3.2, F-1).
//
// This is a VERBATIM port of viewer/template.html's settle() — same constants, same schedule, same
// integration order. "Verbatim" is load-bearing: slice 1 must not move the map, because saved scenes are
// still raw camera coordinates until slice 2 anchors them (F-2). test/layout-settle.test.ts pins this by
// extracting settle() from the template at test time and asserting bit-identical output, so template drift
// fails the build rather than silently rewriting everyone's map.
//
// The two populations below are DIFFERENT and conflating them is the easiest way to build this wrong:
//   SEEDING is over the FULL node list (provenance included) — template.html:199 maps GRAPH.nodes, so a
//           node's seed index is its position among ALL nodes, not among the visible ones.
//   FORCES  are over the VISIBLE subset — template.html:209-215 filters, then settles.
// Seeding over the filtered list would change the seed of every visible node and produce a different map.

export const SETTLE = {
  kRep: 5200,
  kSpring: 0.045,
  rest: 90,
  grav: 0.012,
  iterations: 500,
  damp: 0.82,
  alphaFloor: 0.03,
  alphaDecay: 0.992,
} as const;

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** An edge between two nodes present in the settle population, by index into it. */
export interface LayoutEdge {
  a: number;
  b: number;
}

/**
 * Seed positions, keyed by each id's index in the FULL ordered node list (design §3.2).
 * Mirrors template.html:198-199 exactly, including the (i%7-3)/(i%5-2) jitter terms.
 */
export function seedPositions(allIdsInRowidOrder: readonly string[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  allIdsInRowidOrder.forEach((id, i) => {
    out.set(id, { x: Math.cos(i) * 220 + ((i % 7) - 3) * 30, y: Math.sin(i) * 220 + ((i % 5) - 2) * 30 });
  });
  return out;
}

/**
 * Settle in place. `nodes` is the FORCE population (visible only, in rowid order); `edges` indexes into it.
 * Positions must already be seeded (or loaded) — settle() deliberately does not re-seed, matching
 * template.html:242, which zeroes velocities only.
 */
export function settle(nodes: LayoutNode[], edges: readonly LayoutEdge[]): void {
  const { kRep, kSpring, rest, grav, iterations, damp, alphaFloor, alphaDecay } = SETTLE;
  for (const n of nodes) {
    n.vx = 0;
    n.vy = 0;
  }
  for (let it = 0; it < iterations; it++) {
    const alpha = Math.max(alphaFloor, Math.pow(alphaDecay, it));
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = kRep / d2;
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      // gravity is applied INSIDE the outer loop in the template, not in a pass of its own
      a.vx -= a.x * grav;
      a.vy -= a.y * grav;
    }
    for (const e of edges) {
      const na = nodes[e.a]!;
      const nb = nodes[e.b]!;
      const dx = nb.x - na.x;
      const dy = nb.y - na.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = kSpring * (d - rest);
      const fx = (f * dx) / d;
      const fy = (f * dy) / d;
      na.vx += fx;
      na.vy += fy;
      nb.vx -= fx;
      nb.vy -= fy;
    }
    for (const n of nodes) {
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= damp;
      n.vy *= damp;
    }
  }
}

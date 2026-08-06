// Anchored incremental placement (design §3.3): place NEW nodes against a frozen existing map.
//
// This file starts with the jitter, because the jitter is a correctness guard, not spacing. settle() cannot
// separate two nodes at identical coordinates — with dx = dy = 0 the repulsion is fx = f*dx/d = 0 for any
// softening value, so coincident nodes are welded together permanently (see test/layout-settle.test.ts).
// §3.3 places every member of a component at one seedPoint, so without distinct offsets an entire dropped
// document would collapse onto a single immovable point.

import { SETTLE, type LayoutNode } from "./settle.js";

/** Golden angle, in radians — spreads successive indices without ever repeating a direction. */
export const GOLDEN_ANGLE = 2.399963;

/** Base radius for the member spiral. */
export const JITTER_BASE = 18;

export interface Offset {
  dx: number;
  dy: number;
}

/**
 * Deterministic offset for the m-th member of a component (design §3.3).
 *
 * ρ = JITTER_BASE·√(m+1), φ = m·GOLDEN_ANGLE — a sunflower spiral: ρ grows so points never collide as the
 * component gets larger, and φ never repeats a direction. Deterministic by index; Math.random() is forbidden
 * here because layout must reproduce exactly across runs and machines.
 */
export function memberJitter(m: number): Offset {
  if (!Number.isInteger(m) || m < 0) throw new Error(`memberJitter: m must be a non-negative integer, got ${m}`);
  const rho = JITTER_BASE * Math.sqrt(m + 1);
  const phi = m * GOLDEN_ANGLE;
  return { dx: rho * Math.cos(phi), dy: rho * Math.sin(phi) };
}

/**
 * Offset for the j-th component that falls through to the map-seed rule (design §3.3(c)).
 * r = 220 + 60·j so components don't overlap each other; θ on the same golden angle.
 */
export function componentOffset(j: number): Offset {
  if (!Number.isInteger(j) || j < 0) throw new Error(`componentOffset: j must be a non-negative integer, got ${j}`);
  const r = 220 + 60 * j;
  const theta = j * GOLDEN_ANGLE;
  return { dx: r * Math.cos(theta), dy: r * Math.sin(theta) };
}

/**
 * Place a component's members around a seed point. Returns positions in member order.
 * The distinctness guarantee lives here and is enforced by test.
 */
export function placeComponent(seed: { x: number; y: number }, size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let m = 0; m < size; m++) {
    const { dx, dy } = memberJitter(m);
    out.push({ x: seed.x + dx, y: seed.y + dy });
  }
  return out;
}

// --- the placement pass ------------------------------------------------------------------------------

/** Calibrated by scripts/bench/semantic-anchor-floor.ts — NOT a number chosen in prose (design §3.3). */
export const SEMANTIC_FLOOR = 0.75;
export const SEMANTIC_K = 25;

/** Matches the viewer's isProv (template.html:205) exactly — provenance is the RAG substrate, not the map. */
export function isProvenance(n: { type: string; subtype?: string | null }): boolean {
  return n.type === "SOURCE" && (n.subtype === "chunk" || n.subtype === "document");
}

/**
 * Connected components of `ids` over `adj`, ordered by each component's MINIMUM index in `ids`.
 * `ids` arrives in rowid order, so this ordering is deterministic; a bare DFS/BFS ordering would give
 * different component indices run to run and therefore different (c) offsets (design §3.3).
 */
export function componentsOf(ids: readonly string[], adj: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const nb of adj.get(cur) ?? []) if (rank.has(nb) && !seen.has(nb)) stack.push(nb);
    }
    comp.sort((a, b) => rank.get(a)! - rank.get(b)!); // members in rowid order → jitter index is stable
    comps.push(comp);
  }
  comps.sort((a, b) => rank.get(a[0]!)! - rank.get(b[0]!)!);
  return comps;
}

export type SeedRule = "graph" | "semantic" | "map";

export interface AnchoredPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * Relax newcomers against a frozen anchored field (design §3.3 step 4). Uses §3.2's exact constants — the
 * incremental pass must not have its own physics, or incremental and full maps diverge.
 * Anchored nodes exert repulsion and spring force but never move (one-sided: the full force lands on the
 * newcomer endpoint). Cost is O(|N|·(|A|+|N|)) per iteration — linear in the existing map.
 */
export function settleIncremental(
  anchored: readonly AnchoredPoint[],
  newcomers: LayoutNode[],
  edges: readonly { a: number; b: number | null; anchoredB?: number }[],
): void {
  const { kRep, kSpring, rest, grav, iterations, damp, alphaFloor, alphaDecay } = SETTLE;
  for (const n of newcomers) {
    n.vx = 0;
    n.vy = 0;
  }
  for (let it = 0; it < iterations; it++) {
    const alpha = Math.max(alphaFloor, Math.pow(alphaDecay, it));
    for (let i = 0; i < newcomers.length; i++) {
      const a = newcomers[i]!;
      for (let j = i + 1; j < newcomers.length; j++) {
        const b = newcomers[j]!;
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
      for (const p of anchored) {
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = kRep / d2;
        a.vx += (f * dx) / d; // one-sided: the anchored node does not react
        a.vy += (f * dy) / d;
      }
      a.vx -= a.x * grav;
      a.vy -= a.y * grav;
    }
    for (const e of edges) {
      const na = newcomers[e.a]!;
      if (e.b !== null) {
        const nb = newcomers[e.b]!;
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
      } else {
        const p = anchored[e.anchoredB!]!;
        const dx = p.x - na.x;
        const dy = p.y - na.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = kSpring * (d - rest);
        na.vx += (f * dx) / d; // one-sided again
        na.vy += (f * dy) / d;
      }
    }
    for (const n of newcomers) {
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.vx *= damp;
      n.vy *= damp;
    }
  }
}

/** Bounding-box centre of the anchored field; {0,0} when there is nothing anchored. */
export function bboxCentre(pts: readonly { x: number; y: number }[]): { x: number; y: number } {
  if (!pts.length) return { x: 0, y: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

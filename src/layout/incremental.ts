// Anchored incremental placement (design §3.3): place NEW nodes against a frozen existing map.
//
// This file starts with the jitter, because the jitter is a correctness guard, not spacing. settle() cannot
// separate two nodes at identical coordinates — with dx = dy = 0 the repulsion is fx = f*dx/d = 0 for any
// softening value, so coincident nodes are welded together permanently (see test/layout-settle.test.ts).
// §3.3 places every member of a component at one seedPoint, so without distinct offsets an entire dropped
// document would collapse onto a single immovable point.

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

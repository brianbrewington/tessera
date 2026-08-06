// Placement guards (design §3.3). The distinctness test here is the one that actually protects the map:
// test/layout-settle.test.ts proves settle() WELDS coincident nodes together permanently, and this proves
// the placement never hands it a coincident pair. A characterization test of the defect is not a fix.
import { describe, it, expect } from "vitest";
import { memberJitter, componentOffset, placeComponent, JITTER_BASE, GOLDEN_ANGLE } from "../src/layout/incremental.js";
import { settle, type LayoutNode, type LayoutEdge } from "../src/layout/settle.js";

const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;

describe("component placement — distinctness is a correctness guard", () => {
  it("never places two members of a component at the same point", () => {
    // Sizes span the real range: graphs/big's (a)-miss components are 1,1,1,1,2,31, and the dominant
    // drop-file component is 28. 200 covers a much larger document than we have.
    for (const size of [1, 2, 3, 28, 31, 200]) {
      const pts = placeComponent({ x: 0, y: 0 }, size);
      expect(pts.length).toBe(size);
      expect(new Set(pts.map(key)).size).toBe(size);
    }
  });

  it("keeps a real separation, not merely distinct floats", () => {
    // Distinct-but-adjacent floats would satisfy a naive Set check while still producing a useless pile,
    // and (worse) a near-zero dx/dy makes the repulsion force astronomically large.
    const pts = placeComponent({ x: 0, y: 0 }, 31);
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
      }
    }
    expect(min).toBeGreaterThan(5);
  });

  it("a placed component actually spreads under settle (the end-to-end consequence)", () => {
    // The point of all of the above: hand the placement's output to the real settle() and confirm the
    // component does not stay collapsed. With a coincident placement this fails, because settle() cannot
    // break a tie.
    const size = 12;
    const pts = placeComponent({ x: 300, y: -150 }, size);
    const nodes: LayoutNode[] = pts.map((p, i) => ({ id: `n${i}`, x: p.x, y: p.y, vx: 0, vy: 0 }));
    const edges: LayoutEdge[] = Array.from({ length: size - 1 }, (_, i) => ({ a: i, b: i + 1 }));
    settle(nodes, edges);
    expect(new Set(nodes.map(key)).size).toBe(size);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("is deterministic — same index, same offset, across calls", () => {
    for (const m of [0, 1, 7, 27, 199]) {
      expect(memberJitter(m)).toEqual(memberJitter(m));
    }
    expect(memberJitter(0)).toEqual({ dx: JITTER_BASE, dy: 0 }); // φ=0 → straight along +x
  });

  it("component offsets are distinct and grow apart", () => {
    const offs = Array.from({ length: 12 }, (_, j) => componentOffset(j));
    expect(new Set(offs.map((o) => `${o.dx},${o.dy}`)).size).toBe(offs.length);
    // radius is strictly increasing, so components can't land on each other
    const radii = offs.map((o) => Math.hypot(o.dx, o.dy));
    for (let j = 1; j < radii.length; j++) expect(radii[j]!).toBeGreaterThan(radii[j - 1]!);
  });

  it("rejects invalid indices rather than silently returning NaN", () => {
    expect(() => memberJitter(-1)).toThrow();
    expect(() => memberJitter(1.5)).toThrow();
    expect(() => componentOffset(-1)).toThrow();
  });

  it("uses the golden angle, so directions never repeat within a component", () => {
    expect(GOLDEN_ANGLE).toBeCloseTo(2.399963, 6);
    const dirs = Array.from({ length: 60 }, (_, m) => (((m * GOLDEN_ANGLE) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    const sorted = [...dirs].sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i]! - sorted[i - 1]!);
    expect(minGap).toBeGreaterThan(0.01);
  });
});

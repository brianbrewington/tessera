// Hop-distance dimming (viewer/template.html). Extracted from the template and driven directly, per the
// discipline in scenes-bridge.test.ts: logic the viewer depends on should be executable outside a browser.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TPL = readFileSync(new URL("../viewer/template.html", import.meta.url), "utf8");

/** Pull a top-level function out of the template by name, so these tests run the SHIPPED code. */
function grab(name: string): string {
  const start = TPL.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`template has no function ${name}`);
  let depth = 0, i = TPL.indexOf("{", start);
  for (let j = i; j < TPL.length; j++) {
    if (TPL[j] === "{") depth++;
    else if (TPL[j] === "}") { depth--; if (depth === 0) return TPL.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

type Node = { id: string };
type Edge = { a: Node; b: Node };

/**
 * Build a sandbox holding the template's own hop machinery plus the module-level state it closes over.
 * Returns handles so a test can change the edge set the way the edge-budget slider and the `h` toggle do.
 */
function sandbox(): {
  setEdges: (e: Edge[]) => void;
  select: (n: Node | null) => void;
  /** the guard draw() uses to decide whether to recompute */
  tick: () => void;
  hops: () => Map<string, number> | null;
  computeCount: () => number;
} {
  const src = `
    let EDGES = [], selected = null, hopMap = null, hopFor = null, hopEpoch = -1, edgeEpoch = 0, computes = 0;
    ${grab("computeHops").replace("function computeHops(){", "function computeHops(){ computes++;")}
    ${TPL.includes("function hopsStale(") ? grab("hopsStale") : "function hopsStale(){ return hopFor !== selected; }"}
    return {
      setEdges: e => { EDGES = e; edgeEpoch++; },
      select: n => { selected = n; },
      tick: () => { if (hopsStale()) computeHops(); },
      hops: () => hopMap,
      computeCount: () => computes,
    };
  `;
  return new Function(src)() as ReturnType<typeof sandbox>;
}

const mk = (...ids: string[]): Record<string, Node> => Object.fromEntries(ids.map((id) => [id, { id }]));

describe("hop-distance dimming", () => {
  it("BFS gives SHORTEST distance, not whichever path arrived first", () => {
    // A-B-C-D chain plus a shortcut A-D. D must be 1 hop, not 3 — this is what Matthew's
    // "skip nodes already set" note buys, and it only shows up when a shortcut exists.
    const n = mk("A", "B", "C", "D");
    const s = sandbox();
    s.setEdges([
      { a: n.A!, b: n.B! }, { a: n.B!, b: n.C! }, { a: n.C!, b: n.D! }, { a: n.A!, b: n.D! },
    ]);
    s.select(n.A!);
    s.tick();
    const h = s.hops()!;
    expect(h.get("A")).toBe(0);
    expect(h.get("B")).toBe(1);
    expect(h.get("D")).toBe(1);
    expect(h.get("C")).toBe(2);
  });

  it("leaves disconnected nodes out of the map entirely (they take HOP_NONE, not the ramp floor)", () => {
    const n = mk("A", "B", "Z");
    const s = sandbox();
    s.setEdges([{ a: n.A!, b: n.B! }]);
    s.select(n.A!);
    s.tick();
    expect(s.hops()!.has("Z")).toBe(false);
  });

  it("RECOMPUTES when the visible edge set changes under a held selection", () => {
    // The bug this test was written for. The cache was keyed on the SELECTION alone, so moving the edge-budget
    // slider or pressing `h` — both of which rebuild EDGES — left hop distances computed over the previous
    // edge set. The map then dimmed by a structure that was no longer on screen, which is worse than not
    // dimming at all because it looks authoritative.
    const n = mk("A", "B", "C");
    const s = sandbox();
    s.setEdges([{ a: n.A!, b: n.B! }, { a: n.B!, b: n.C! }]);
    s.select(n.A!);
    s.tick();
    expect(s.hops()!.get("C")).toBe(2);

    // the budget slider drops the B-C edge; C is now unreachable
    s.setEdges([{ a: n.A!, b: n.B! }]);
    s.tick();
    expect(s.computeCount()).toBe(2);          // it must have recomputed
    expect(s.hops()!.has("C")).toBe(false);    // and C must now be unreachable
  });

  it("does NOT recompute when nothing relevant changed", () => {
    const n = mk("A", "B");
    const s = sandbox();
    s.setEdges([{ a: n.A!, b: n.B! }]);
    s.select(n.A!);
    s.tick(); s.tick(); s.tick();
    expect(s.computeCount()).toBe(1);
  });
});

describe("the hop→opacity ladder", () => {
  // Pinned because the exact values are a design decision argued from perception data, not an implementation
  // detail: the jump from hop 1 to hop 2 skips the 0.25–1.00 interference band in one step rather than ramping
  // through it, and "unreachable" sits below the band entirely because it means DISCONNECTED, not far.
  const f = new Function(
    `${TPL.match(/const HOP_NONE[^\n]*\n/)![0]}${TPL.match(/const BG_LO[^\n]*\n/)![0]}` +
      `${TPL.match(/function hopAlpha\(h\)\{[\s\S]*?\n\}/)![0]}; return hopAlpha;`,
  )() as (h: number | undefined) => number;

  it("puts unreachable nodes below the backgrounded band", () => {
    expect(f(undefined)).toBeCloseTo(0.02, 5);
    expect(f(undefined)).toBeLessThan(f(5)); // fainter than the farthest REACHABLE node
  });

  it("keeps the selection and its direct neighbours fully present", () => {
    expect(f(0)).toBe(1);
    expect(f(1)).toBe(1);
  });

  it("skips the 0.25–1.00 interference band in one step", () => {
    // The load-bearing property. Two labs found 0.25 through 1.00 perceptually flat, so any value landing
    // there costs contrast and buys nothing. Nothing the function returns may fall inside it.
    for (const h of [0, 1, 2, 3, 4, 5, 9, undefined]) {
      const a = f(h);
      expect(a === 1 || a < 0.25).toBe(true);
    }
    expect(f(1) - f(2)).toBeCloseTo(0.8, 5); // the jump, stated
  });

  it("is monotonically non-increasing in hop count", () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 10].map(f);
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
  });
});

describe("the adaptive zoom ceiling", () => {
  const tightest = new Function(
    `${TPL.match(/function tightestSpacing\(pts\)\{[\s\S]*?\n\}/)![0]}; return tightestSpacing;`,
  )() as (pts: number[][]) => number | null;

  it("ignores EXACTLY coincident points, which no zoom level can separate", () => {
    // The graph has 20 nodes at identical positions. Including them drives the ceiling to infinity while
    // fixing nothing, because zoom multiplies a zero distance by a constant and gets zero.
    const grid: number[][] = [];
    for (let i = 0; i < 40; i++) grid.push([i * 10, 0]);
    const withDupes = [...grid, [0, 0], [0, 0], [10, 0]];
    expect(tightest(grid)).toBeCloseTo(10, 3);
    expect(tightest(withDupes)).toBeCloseTo(10, 3); // unchanged: the duplicates are skipped
  });

  it("reports a TIGHT cluster, not the average spacing", () => {
    // The whole point: one dense clump inside a sparse field must set the ceiling, or you hit the cap before
    // the clump comes apart. That is the failure Brian hit after applying a t-SNE layout.
    const sparse: number[][] = [];
    for (let i = 0; i < 60; i++) sparse.push([i * 100, 0]);
    const clumped = [...sparse];
    for (let i = 0; i < 6; i++) clumped.push([5000 + i * 0.5, 500]);
    const a = tightest(sparse)!, b = tightest(clumped)!;
    expect(b).toBeLessThan(a);
    expect(b).toBeLessThanOrEqual(0.5);
  });

  it("returns null when there is nothing to measure", () => {
    expect(tightest([])).toBeNull();
    expect(tightest([[0, 0]])).toBeNull();
  });

  it("agrees with brute force on a small random set", () => {
    // The grid bucketing is an optimisation; it must not change the answer. Without this check the whole
    // ceiling could be wrong in a way that only shows on real data.
    const pts: number[][] = [];
    for (let i = 0; i < 120; i++) pts.push([Math.sin(i * 7.3) * 500, Math.cos(i * 3.1) * 500]);
    const nn: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(pts[i]![0]! - pts[j]![0]!, pts[i]![1]! - pts[j]![1]!);
        if (d > 1e-3 && d < best) best = d;
      }
      if (Number.isFinite(best)) nn.push(best);
    }
    nn.sort((a, b) => a - b);
    expect(tightest(pts)).toBeCloseTo(nn[Math.floor(0.02 * (nn.length - 1))]!, 6);
  });
});

describe("the zoom ceiling on degenerate graphs", () => {
  const tightest = new Function(
    `${TPL.match(/function tightestSpacing\(pts\)\{[\s\S]*?\n\}/)![0]}; return tightestSpacing;`,
  )() as (pts: number[][]) => number | null;
  // Mirror the ceiling formula so the clamp behaviour is asserted, not assumed.
  const ceiling = (pts: number[][]): number => {
    const sep = tightest(pts);
    return sep ? Math.min(400, Math.max(8, 44 / sep)) : 8;
  };

  it("falls back to 8x when EVERY node is coincident", () => {
    // The pathological case the exclusion creates: if all pairs are skipped, there is nothing to measure.
    // Returning null here rather than Infinity or 0 is what keeps the ceiling finite.
    const all = Array.from({ length: 20 }, () => [100, 100]);
    expect(tightest(all)).toBeNull();
    expect(ceiling(all)).toBe(8);
  });

  it("never returns a ceiling below the old fixed cap", () => {
    // A very sparse graph would compute a tiny ceiling; the clamp must stop it, or this "feature" would be a
    // regression that removes zoom people already had.
    const sparse = Array.from({ length: 30 }, (_, i) => [i * 100000, 0]);
    expect(ceiling(sparse)).toBe(8);
  });

  it("never returns a ceiling above the hard cap, however tight the clump", () => {
    const clumped = Array.from({ length: 30 }, (_, i) => [i * 1e-9, 0]);
    const c = ceiling(clumped);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeLessThanOrEqual(400);
  });

  it("survives extreme aspect ratios and a far outlier", () => {
    // Grid bucketing sizes cells from the bounding span. One point a long way out inflates the span, which
    // could make every cell enormous and quietly degrade the search to "found nothing".
    const wide: number[][] = [];
    for (let i = 0; i < 80; i++) wide.push([i * 3, 0]);
    wide.push([900000, 0]);
    const s = tightest(wide);
    expect(s).not.toBeNull();
    expect(Number.isFinite(s!)).toBe(true);
    expect(s!).toBeGreaterThan(0);
  });
});

describe("the attraction knob cannot produce an unusable layout", () => {
  // The slider spans 0.3x to 8x. STEP_MAX bounds a step, not a NaN, so every offered value has to be shown
  // to terminate finite — an optimiser that diverges at one end of a control is a control that ships a bug.
  const src =
    TPL.match(/function makeTsne\(ids, perp, init, attraction\)\{[\s\S]*?\n\}\n/)![0];
  const make = new Function("EMB", `${src}; return makeTsne;`) as (e: unknown) => unknown;

  const EMB: Record<string, number[]> = {};
  const ids: string[] = [];
  for (let i = 0; i < 70; i++) {
    const id = `n${i}`;
    ids.push(id);
    // three loose clumps, so there is real structure for attraction to act on
    const c = i % 3;
    EMB[id] = Array.from({ length: 8 }, (_, d) => Math.sin(i * 1.7 + d) * 0.4 + c * 2);
  }

  for (const attraction of [0.3, 0.5, 1, 2, 4, 8]) {
    it(`stays finite and spread at attraction ${attraction}x`, () => {
      const makeTsne = make(EMB) as (i: string[], p: number, init: number[][], a: number) => { Y: number[][]; step: () => void };
      const init = ids.map((_, i) => [Math.sin(i * 12.9) * 1e-2, Math.cos(i * 78.2) * 1e-2]);
      const t = makeTsne(ids, 10, init, attraction);
      for (let i = 0; i < 300; i++) t.step();
      expect(t.Y.every((p) => Number.isFinite(p[0]!) && Number.isFinite(p[1]!))).toBe(true);
      const r = Math.max(...t.Y.map((p) => Math.hypot(p[0]!, p[1]!)));
      expect(r).toBeGreaterThan(1e-6); // not collapsed to a single point
      expect(r).toBeLessThan(1e6);     // not diverged
    });
  }
});

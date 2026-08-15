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

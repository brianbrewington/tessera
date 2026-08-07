// Edge prominence. The load-bearing property is DISCRIMINATION: a measure that returns near-identical values
// for every edge cannot drive an attention budget, however principled it looks. The simple random-walk rate
// is the cautionary case — it is exactly constant, which is why it is not implemented here.
import { describe, it, expect } from "vitest";
import { pagerank, pagerankProduct, edgeBetweenness, betweennessAffordable, type ProminenceInput } from "../src/graph/prominence.js";

/** Two dense clusters joined by ONE bridge — the canonical shape betweenness must find. */
function barbell(sizeA = 6, sizeB = 6): ProminenceInput {
  const nodes: string[] = [];
  const edges: Array<[string, string, string]> = [];
  const a = Array.from({ length: sizeA }, (_, i) => `a${i}`);
  const b = Array.from({ length: sizeB }, (_, i) => `b${i}`);
  nodes.push(...a, ...b);
  const link = (x: string, y: string): void => void edges.push([x, y, `${x}|${y}`]);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) link(a[i]!, a[j]!);
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) link(b[i]!, b[j]!);
  link(a[0]!, b[0]!); // the bridge
  return { nodes, edges };
}

describe("pagerank", () => {
  it("sums to 1 and ranks a hub above a leaf", () => {
    const nodes = ["hub", "l1", "l2", "l3", "l4"];
    const edges: Array<[string, string, string]> = nodes.slice(1).map((l) => ["hub", l, `hub|${l}`]);
    const pr = pagerank({ nodes, edges });
    expect([...pr.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(pr.get("hub")!).toBeGreaterThan(pr.get("l1")! * 2);
  });

  it("handles an isolated node without producing NaN", () => {
    const pr = pagerank({ nodes: ["a", "b", "lonely"], edges: [["a", "b", "e"]] });
    for (const v of pr.values()) expect(Number.isFinite(v)).toBe(true);
    expect(pr.get("lonely")!).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const g = barbell();
    expect([...pagerank(g).entries()]).toEqual([...pagerank(g).entries()]);
  });
});

describe("edge betweenness", () => {
  it("ranks the single bridge far above every intra-cluster edge", () => {
    const g = barbell();
    const eb = edgeBetweenness(g);
    const bridge = eb.get("a0|b0")!;
    const others = [...eb.entries()].filter(([k]) => k !== "a0|b0").map(([, v]) => v);
    expect(bridge).toBeGreaterThan(Math.max(...others) * 3);
  });

  it("DISCRIMINATES — the property that makes it usable at all", () => {
    // The bar a measure has to clear. Simple random-walk rate scores 1.0x here and is why it is absent.
    const eb = edgeBetweenness(barbell(8, 8));
    const vals = [...eb.values()].sort((a, b) => b - a);
    expect(vals[0]! / vals[vals.length - 1]!).toBeGreaterThan(10);
  });

  it("is symmetric under relabelling of the two clusters", () => {
    const eb1 = edgeBetweenness(barbell(6, 6));
    const vals = [...eb1.values()].sort((a, b) => a - b);
    // the two clusters are isomorphic, so their intra-cluster edge scores must match pairwise
    const intra = vals.slice(0, vals.length - 1);
    expect(intra[0]).toBeCloseTo(intra[1]!, 10);
  });

  it("a path graph puts the middle edge highest", () => {
    const nodes = ["n0", "n1", "n2", "n3", "n4"];
    const edges: Array<[string, string, string]> = [
      ["n0", "n1", "e0"], ["n1", "n2", "e1"], ["n2", "n3", "e2"], ["n3", "n4", "e3"],
    ];
    const eb = edgeBetweenness({ nodes, edges });
    expect(eb.get("e1")!).toBeGreaterThan(eb.get("e0")!);
    expect(eb.get("e2")!).toBeGreaterThan(eb.get("e3")!);
    expect(eb.get("e1")!).toBeCloseTo(eb.get("e2")!, 10); // symmetric path
  });

  it("returns finite values on a disconnected graph", () => {
    const eb = edgeBetweenness({ nodes: ["a", "b", "c", "d"], edges: [["a", "b", "e1"], ["c", "d", "e2"]] });
    for (const v of eb.values()) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("ABSOLUTE values — the regression test the normalisation bug needed", () => {
  // The normalisation bug (node constant 2/((n-1)(n-2)) instead of the edge constant 2/(n(n-1))) shipped
  // green: every other assertion here is ORDINAL — ratios, orderings, symmetry — and a uniform scale factor
  // preserves all of them. Only cross-validating against networkx caught it. These pin the actual numbers so
  // the same class of bug cannot regress silently.
  it("a single edge scores exactly 1.0", () => {
    const eb = edgeBetweenness({ nodes: ["a", "b"], edges: [["a", "b", "e"]] });
    expect(eb.get("e")!).toBeCloseTo(1.0, 12);
  });

  it("a 3-node path scores exactly 2/3 on both edges", () => {
    // 3 pairs; each edge lies on 2 of the 3 shortest paths -> 2/3 under 2/(n(n-1)) normalisation.
    const eb = edgeBetweenness({ nodes: ["a", "b", "c"], edges: [["a", "b", "e1"], ["b", "c", "e2"]] });
    expect(eb.get("e1")!).toBeCloseTo(2 / 3, 12);
    expect(eb.get("e2")!).toBeCloseTo(2 / 3, 12);
  });

  it("a 4-node path: outer edges 1/2, middle edge 2/3", () => {
    const eb = edgeBetweenness({
      nodes: ["a", "b", "c", "d"],
      edges: [["a", "b", "e1"], ["b", "c", "e2"], ["c", "d", "e3"]],
    });
    expect(eb.get("e1")!).toBeCloseTo(0.5, 12);
    expect(eb.get("e3")!).toBeCloseTo(0.5, 12);
    expect(eb.get("e2")!).toBeCloseTo(2 / 3, 12);
  });
});

describe("PARALLEL EDGES — the shape the networkx cross-check could not exercise", () => {
  // graphs/big has ZERO parallel pairs and zero self-loops, so "matches networkx to floating-point identity"
  // was validated on the one graph shape that cannot show a divergence. graphs/synthpl has 15 parallel pairs.
  // Edges are unique on (from,to,kind,polarity), so the same conceptual link asserted under two kinds
  // produces two rows. Documenting the semantics rather than leaving them accidental:
  it("splits credit between parallel rows rather than double-counting", () => {
    const single = edgeBetweenness({ nodes: ["a", "b", "c"], edges: [["a", "b", "e1"], ["b", "c", "e2"]] });
    const dup = edgeBetweenness({
      nodes: ["a", "b", "c"],
      edges: [["a", "b", "e1"], ["a", "b", "e1dup"], ["b", "c", "e2"]],
    });
    // the duplicated link's credit is halved across its two rows...
    expect(dup.get("e1")! + dup.get("e1dup")!).toBeCloseTo(single.get("e1")!, 12);
    expect(dup.get("e1")!).toBeCloseTo(dup.get("e1dup")!, 12);
    // ...while the untouched downstream edge is unchanged: path counting stays internally coherent
    expect(dup.get("e2")!).toBeCloseTo(single.get("e2")!, 12);
    // CONSEQUENCE, stated: under a top-N% filter a double-asserted bridge can fall below the cut while
    // weaker single rows survive. Collapsing parallel rows before ranking is the fix if that ever bites.
  });

  it("betweenness skips self-loops; pagerankProduct scores them — the two cover different edge sets", () => {
    const inp = { nodes: ["a", "b"], edges: [["a", "b", "e"], ["a", "a", "loop"]] as Array<readonly [string, string, string]> };
    expect(edgeBetweenness(inp).has("loop")).toBe(false);
    expect(pagerankProduct(inp).has("loop")).toBe(true);
  });
});

describe("pagerank product", () => {
  it("scores a hub-to-hub edge above a leaf-to-leaf edge", () => {
    const nodes = ["h1", "h2", "l1", "l2"];
    const edges: Array<[string, string, string]> = [
      ["h1", "h2", "hub-hub"], ["l1", "l2", "leaf-leaf"],
      ["h1", "l1", "x1"], ["h1", "l2", "x2"], ["h2", "l1", "x3"], ["h2", "l2", "x4"],
      ["h1", "h2", "dup"],
    ];
    const pp = pagerankProduct({ nodes, edges });
    expect(pp.get("hub-hub")!).toBeGreaterThan(pp.get("leaf-leaf")!);
  });

  it("discriminates on SKEWED degree — which is the only shape it can discriminate on", () => {
    // A barbell is nearly regular inside each cluster, so PageRank is nearly uniform there and the product
    // spreads only ~3x. That is a property of the measure, not a bug: pagerank_product ranks by endpoint
    // prominence, so it needs prominence to actually vary. On graphs/big (skewed degree) it measured 96x.
    // Betweenness is the measure that works on a barbell; these two are complementary, not redundant.
    const nodes = ["hub"];
    const edges: Array<[string, string, string]> = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(`s${i}`);
      edges.push(["hub", `s${i}`, `hub-s${i}`]);
    }
    nodes.push("t1", "t2");
    edges.push(["t1", "t2", "tail"]); // a peripheral pair, far from the hub
    edges.push(["s0", "t1", "join"]);
    const pp = pagerankProduct({ nodes, edges });
    const vals = [...pp.values()].sort((a, b) => b - a);
    expect(vals[0]! / vals[vals.length - 1]!).toBeGreaterThan(10);
    expect(pp.get("hub-s0")!).toBeGreaterThan(pp.get("tail")!);
  });

  it("is near-flat on a regular graph — stated, so nobody mistakes it for a universal measure", () => {
    const pp = pagerankProduct(barbell(10, 3));
    const vals = [...pp.values()].sort((a, b) => b - a);
    expect(vals[0]! / vals[vals.length - 1]!).toBeLessThan(5); // ~3x, measured
  });
});

describe("the cost gate", () => {
  it("affords a real corpus and refuses a runaway one", () => {
    expect(betweennessAffordable(383, 416)).toBe(true); // graphs/big
    expect(betweennessAffordable(3870, 19350)).toBe(true); // the 10x synthetic, ~75M
    expect(betweennessAffordable(40000, 200000)).toBe(false); // 8e9 — would hang a CLI command
  });
});

// Prominence wiring (store -> CLI -> bundle -> viewer filter). The algorithm tests live in
// prominence.test.ts; these check that the numbers actually reach the place they are used, which is the
// failure both slice-1 reviewers flagged when layoutPass existed but nothing product-facing called it.
import { describe, it, expect, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { prominencePass } from "../src/graph/prominence-pass.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE = readFileSync(join(ROOT, "viewer", "template.html"), "utf8");
const meta = { actor: "test", cause: "prominence" };

const GRAPH = "__prom_test__";
const dir = join(ROOT, "graphs", GRAPH);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Barbell in the store: two clusters, one bridge — the bridge must win on betweenness. */
async function build(dbDir: string): Promise<{ bridgeEdge: string; intraEdge: string }> {
  rmSync(dbDir, { recursive: true, force: true });
  mkdirSync(dbDir, { recursive: true });
  const s = new GraphStore({ path: join(dbDir, "graph.db"), embedder: new StubEmbedder(768) });
  const mk = async (t: string): Promise<string> =>
    (await s.putNode({ type: "CONCEPT", origin: "ingest", text: `c\t${t}`, name: t, description: t }, meta)).id;
  const A = await Promise.all(["a0", "a1", "a2", "a3"].map(mk));
  const B = await Promise.all(["b0", "b1", "b2", "b3"].map(mk));
  const link = async (x: string, y: string): Promise<string> =>
    (await s.putEdge({ from: x, to: y, kind: "RELATED", reason: `${x}~${y}`, origin: "ingest" }, meta)).edgeId;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) await link(A[i]!, A[j]!);
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) await link(B[i]!, B[j]!);
  const bridgeEdge = await link(A[0]!, B[0]!);
  const intraEdge = (await link(A[1]!, A[2]!)) as string; // already exists -> same edge id, fine
  s.close();
  return { bridgeEdge, intraEdge };
}

describe("prominence reaches the store", () => {
  it("computes both measures and stores one row per (edge, measure)", async () => {
    const { bridgeEdge } = await build(dir);
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const r = prominencePass(s, meta);
    expect(r.measures).toEqual(["pagerank_product", "betweenness"]);
    expect(r.betweennessSkipped).toBe(false);

    const bt = s.edgeProminence("betweenness");
    const pp = s.edgeProminence("pagerank_product");
    expect(bt.size).toBe(r.edges);
    expect(pp.size).toBe(r.edges);

    // the bridge is the highest-betweenness edge — the property the measure exists for
    const ranked = [...bt.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0]![0]).toBe(bridgeEdge);
    expect(s.prominenceMeasures().sort()).toEqual(["betweenness", "pagerank_product"]);
    s.close();
  });

  it("re-running replaces rather than accumulating", async () => {
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const first = prominencePass(s, meta);
    const before = s.edgeProminence("betweenness").size;
    prominencePass(s, meta);
    expect(s.edgeProminence("betweenness").size).toBe(before);
    expect(first.edges).toBe(before);
    s.close();
  });

  it("rejects a non-finite value rather than persisting NaN", async () => {
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    const anyEdge = [...s.edgeProminence("betweenness").keys()][0]!;
    expect(() => s.putEdgeProminence("bogus", new Map([[anyEdge, NaN]]), meta)).toThrow(/non-finite/);
    s.close();
  });
});

describe("prominence reaches the bundle and the viewer", () => {
  it("`tessera view` computes it and the exported bundle carries every measure, keyed by edge id", async () => {
    const out = execFileSync("npx", ["tsx", "scripts/cli.ts", "view", GRAPH], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/prominence: pagerank_product, betweenness/);

    const html = readFileSync(join(dir, "view.html"), "utf8");
    const marker = "const GRAPH = ";
    const start = html.indexOf(marker) + marker.length;
    const data = JSON.parse(html.slice(start, html.indexOf("\n", start)).replace(/;$/, "").replace(/\\u003c/g, "<"));

    expect(Object.keys(data.prominence).sort()).toEqual(["betweenness", "pagerank_product"]);
    expect(data.edges[0].id).toBeTruthy(); // edges must carry ids or the filter cannot look them up
    const ids = new Set(data.edges.map((e: any) => e.id));
    for (const id of Object.keys(data.prominence.betweenness)) expect(ids.has(id)).toBe(true);
  }, 60_000);

  it("the viewer's edge filter keeps the top N% by the selected measure", () => {
    // Extract the filter from the shipped template so it cannot drift from what users run.
    const start = TEMPLATE.indexOf("  // apply the attention budget");
    const end = TEMPLATE.indexOf("} else { edgeCut = -Infinity; }", start) + "} else { edgeCut = -Infinity; }".length;
    expect(start).toBeGreaterThan(0);
    const src = TEMPLATE.slice(start, end);

    const mkEdges = () => Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, a: 1, b: 2 }));
    const tbl = Object.fromEntries(mkEdges().map((e, i) => [e.id, i])); // e99 most prominent
    const run = (pct: number, measure: string): any[] => {
      const fn = new Function(
        "EDGES", "PROM", "edgeMeasure", "edgeKeepPct", "edgeCut",
        `${src}\nreturn EDGES;`,
      );
      return fn(mkEdges(), { m: tbl }, measure, pct, -Infinity);
    };
    expect(run(100, "m").length).toBe(100); // 100% keeps everything
    expect(run(10, "m").length).toBe(10);
    expect(run(10, "m").map((e) => e.id)).toContain("e99"); // keeps the MOST prominent
    expect(run(10, "m").map((e) => e.id)).not.toContain("e0"); // drops the least
    expect(run(10, "none").length).toBe(100); // 'none' disables the budget entirely
  });
});

describe("prominence is VISIBLE, not just filterable", () => {
  // Extracted from the shipped template so the encoding cannot drift from what users see.
  it("percentile-ranks surviving edges 0..1 by the active measure", () => {
    const start = TEMPLATE.indexOf("  // Visual weight: rank the surviving edges");
    const end = TEMPLATE.indexOf("} else { for(const e of EDGES) e.prom = 0.5; }", start) + "} else { for(const e of EDGES) e.prom = 0.5; }".length;
    expect(start).toBeGreaterThan(0);
    const src = TEMPLATE.slice(start, end);

    const edges = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, prom: undefined as number | undefined }));
    // betweenness-like: four orders of magnitude, which a LINEAR scale would collapse to invisibility
    const tbl = { e0: 0.00001, e1: 0.0001, e2: 0.001, e3: 0.01, e4: 0.1 };
    new Function("EDGES", "PROM", "edgeMeasure", src)(edges, { m: tbl }, "m");
    expect(edges.map((e) => e.prom)).toEqual([0, 0.25, 0.5, 0.75, 1]); // rank, not raw value
  });

  it("'none' flattens every edge to the middle, restoring uniform rendering", () => {
    const start = TEMPLATE.indexOf("  // Visual weight: rank the surviving edges");
    const end = TEMPLATE.indexOf("} else { for(const e of EDGES) e.prom = 0.5; }", start) + "} else { for(const e of EDGES) e.prom = 0.5; }".length;
    const src = TEMPLATE.slice(start, end);
    const edges = [{ id: "a", prom: undefined as number | undefined }, { id: "b", prom: undefined as number | undefined }];
    new Function("EDGES", "PROM", "edgeMeasure", src)(edges, { m: { a: 1, b: 2 } }, "none");
    expect(edges.every((e) => e.prom === 0.5)).toBe(true);
  });

  it("width and opacity both increase with rank (the encoding itself)", () => {
    const widthOf = (p: number): number => 0.35 + 1.45 * p;
    const alphaOf = (p: number, base = 0.2): number => Math.min(0.6, base * (0.35 + 1.3 * p));
    expect(widthOf(1)).toBeGreaterThan(widthOf(0) * 4); // a top edge is >4x the width of the faintest
    expect(alphaOf(1)).toBeGreaterThan(alphaOf(0) * 4);
    expect(widthOf(0)).toBeGreaterThan(0.3); // the faintest edge is still drawn, not erased
    // pinned against the template so tuning the constants there fails here rather than silently
    expect(TEMPLATE).toContain("0.35 + 1.45*p");
    expect(TEMPLATE).toContain("0.35 + 1.30*p");
  });

  it("the edge control clears the minimap (they collided at bottom:150px)", () => {
    // The minimap is fixed at bottom:14px and is ~192px tall (24px head + 168px canvas), so it occupies up
    // to ~206px. Brian hit this on synthpl: the slider was underneath it.
    expect(TEMPLATE).toMatch(/#minimap\{[^}]*bottom:14px/);
    expect(TEMPLATE).toMatch(/id='edgectl'[\s\S]{0,220}bottom:220px/);
  });
});

describe("stale prominence must not survive a skipped pass (Fable, HIGH)", () => {
  it("clearEdgeProminence removes a measure entirely", async () => {
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    prominencePass(s, meta);
    expect(s.edgeProminence("betweenness").size).toBeGreaterThan(0);
    const r = s.clearEdgeProminence("betweenness", meta);
    expect(r.removed).toBeGreaterThan(0);
    expect(s.edgeProminence("betweenness").size).toBe(0);
    expect(s.prominenceMeasures()).not.toContain("betweenness");
    s.close();
  });

  it("a pass that SKIPS betweenness deletes the previous run's values", async () => {
    // The failure this prevents: a graph grows past BETWEENNESS_BUDGET, every later `view` prints
    // "(betweenness skipped)" but exports values computed over the PRE-GROWTH graph — and the viewer
    // defaults to betweenness whenever the key exists, so every edge added since scores 0 (`?? 0`) and is
    // the first to disappear at any slider position below 100%. Silently, under the default measure.
    const s = new GraphStore({ path: join(dir, "graph.db"), embedder: new StubEmbedder(768) });
    prominencePass(s, meta);
    expect(s.edgeProminence("betweenness").size).toBeGreaterThan(0);

    // force the skip path without building a huge graph
    const mod = await import("../src/graph/prominence.js");
    const spy = vi.spyOn(mod, "betweennessAffordable").mockReturnValue(false);
    const { prominencePass: freshPass } = await import("../src/graph/prominence-pass.js");
    const r = freshPass(s, meta);
    spy.mockRestore();

    expect(r.betweennessSkipped).toBe(true);
    expect(r.measures).toEqual(["pagerank_product"]);
    expect(s.edgeProminence("betweenness").size).toBe(0); // stale rows GONE, not left behind
    expect(s.prominenceMeasures()).toEqual(["pagerank_product"]);
    s.close();
  });
});

describe("ties share a rank rather than inventing differences (Fable, MEDIUM)", () => {
  it("equal values get an equal, averaged rank", () => {
    const start = TEMPLATE.indexOf("  // Visual weight: rank the surviving edges");
    const end = TEMPLATE.indexOf("} else { for(const e of EDGES) e.prom = 0.5; }", start) + "} else { for(const e of EDGES) e.prom = 0.5; }".length;
    const src = TEMPLATE.slice(start, end);
    // betweenness produces mass ties at exactly 0 — every edge on no shortest path
    const edges = ["a", "b", "c", "d", "e"].map((id) => ({ id, prom: undefined as number | undefined }));
    const tbl = { a: 0, b: 0, c: 0, d: 5, e: 9 };
    new Function("EDGES", "PROM", "edgeMeasure", src)(edges, { m: tbl }, "m");
    const by = Object.fromEntries(edges.map((x) => [x.id, x.prom]));
    expect(by.a).toBe(by.b);
    expect(by.b).toBe(by.c); // the three zeros are indistinguishable, and now render identically
    expect(by.a).toBeCloseTo(((0 + 2) / 2) / 4, 12); // averaged rank, not 0 / 0.25 / 0.5
    expect(by.d!).toBeGreaterThan(by.a!);
    expect(by.e!).toBeGreaterThan(by.d!);
  });
});

describe("the edge budget must not move nodes (Fable, MEDIUM)", () => {
  it("rebuild(false) skips repositioning entirely", () => {
    const start = TEMPLATE.indexOf("  const complete = NODES.length>0");
    const end = TEMPLATE.indexOf("computeBounds();", start);
    const src = TEMPLATE.slice(start, end);
    const mk = () => [{ id: "n0", sx: 1, sy: 2, x: 50, y: 60, vx: 7, vy: 8 }];
    let settles = 0;
    const settle = (): void => { settles++; };

    // incomplete layout + reposition:false -> no settle, nothing moved. Without this the slider would run a
    // full settle per tick (36.6s on the 10x graph) AND make geometry depend on slider position, since
    // springs only act along the edges that survived the filter.
    const nodes = mk();
    new Function("NODES", "LAYOUT", "settle", "reposition", src)(nodes, {}, settle, false);
    expect(settles).toBe(0);
    expect(nodes[0]!.x).toBe(50); // untouched
    expect(nodes[0]!.y).toBe(60);

    // the same input WITH reposition:true does settle, so the guard is what makes the difference
    const nodes2 = mk();
    new Function("NODES", "LAYOUT", "settle", "reposition", src)(nodes2, {}, settle, true);
    expect(settles).toBe(1);
    expect(nodes2[0]!.x).toBe(1);
  });

  it("the slider and selector both call rebuild(false)", () => {
    expect(TEMPLATE).toMatch(/sl\.oninput=\(\)=>\{ edgeKeepPct=Number\(sl\.value\); rebuild\(false\)/);
    expect(TEMPLATE).toMatch(/sel\.onchange=\(\)=>\{ edgeMeasure=sel\.value; rebuild\(false\)/);
  });
});

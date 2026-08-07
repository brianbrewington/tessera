// Prominence wiring (store -> CLI -> bundle -> viewer filter). The algorithm tests live in
// prominence.test.ts; these check that the numbers actually reach the place they are used, which is the
// failure both slice-1 reviewers flagged when layoutPass existed but nothing product-facing called it.
import { describe, it, expect, afterAll } from "vitest";
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

// Weighted intersection queries (src/graph/paths.ts) — deterministic, no network.
// Covers the weighting model: connective-spine filtering, parallel-edge combine, bottleneck path
// strength, ranking/determinism, hop bounds, rare-bridge-over-hub ranking, and the store hydration.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { buildAdjacency, pathsBetween, connectorsOf, affinity } from "../src/graph/paths.js";
import type { EdgeRecord, EdgeKind } from "../src/schema.js";

let uid = 0;
function e(from: string, to: string, kind: EdgeKind = "RELATED", w = 1, polarity: EdgeRecord["polarity"] = null): EdgeRecord {
  return { id: `e${uid++}`, from, to, kind, polarity, semanticWeight: 0, hebbianWeight: w, status: "proposed", version: 1 };
}

describe("buildAdjacency", () => {
  it("keeps only connective kinds — provenance (APPEARED_IN/ORIGINATED_FROM) is not connection", () => {
    const adj = buildAdjacency([e("P1", "C1", "RELATED"), e("P1", "chunk", "APPEARED_IN"), e("C1", "doc", "ORIGINATED_FROM")]);
    expect(adj.adj.get("P1")!.map((x) => x.to)).toEqual(["C1"]); // the chunk edge is gone
    expect(adj.adj.has("chunk")).toBe(false);
    expect(adj.degree.get("P1")).toBe(1);
  });

  it("is undirected and combines parallel edges between a pair by MAX conductance", () => {
    const adj = buildAdjacency([e("A", "B", "RELATED", 1), e("B", "A", "RELATED", 4, "supports")]);
    expect(adj.adj.get("A")).toEqual([{ to: "B", w: 4 }]);
    expect(adj.adj.get("B")).toEqual([{ to: "A", w: 4 }]);
  });

  it("drops self-loops and honors a custom weightOf / kind set", () => {
    const adj = buildAdjacency([e("A", "A", "RELATED", 9), e("A", "B", "RESONATES_WITH", 3)], {
      kinds: ["RESONATES_WITH"],
      weightOf: () => 7,
    });
    expect(adj.adj.has("A")).toBe(true);
    expect(adj.adj.get("A")).toEqual([{ to: "B", w: 7 }]); // custom weight, self-loop dropped, RELATED excluded
  });
});

describe("pathsBetween — bottleneck-weighted paths", () => {
  // A–B connect three ways: direct (w1), via C1 (w1,w1), via C2 (w5,w5). A–D has no path.
  const edges = [
    e("A", "B", "RELATED", 1),
    e("A", "C1", "RELATED", 1), e("C1", "B", "RELATED", 1),
    e("A", "C2", "RELATED", 5), e("C2", "B", "RELATED", 5),
    e("D", "E", "RELATED", 1),
  ];
  const adj = buildAdjacency(edges);

  it("strength is the bottleneck (min edge conductance) along the chain", () => {
    const viaC2 = pathsBetween(adj, "A", "B").find((p) => p.nodes.includes("C2"))!;
    expect(viaC2.edges).toEqual([5, 5]);
    expect(viaC2.strength).toBe(5);
    expect(viaC2.hops).toBe(2);
  });

  it("ranks by strength desc, then fewer hops, then lexicographically — deterministically", () => {
    const ps = pathsBetween(adj, "A", "B");
    // strongest first (C2 bottleneck 5), then the two bottleneck-1 chains with the DIRECT (1 hop) before via-C1 (2 hops)
    expect(ps.map((p) => p.nodes)).toEqual([
      ["A", "C2", "B"],
      ["A", "B"],
      ["A", "C1", "B"],
    ]);
  });

  it("never routes through the target and returns only simple paths", () => {
    for (const p of pathsBetween(adj, "A", "B")) {
      expect(p.nodes.indexOf("B")).toBe(p.nodes.length - 1); // B only at the end
      expect(new Set(p.nodes).size).toBe(p.nodes.length); // no repeats
    }
  });

  it("honors maxHops and topK, and returns [] when there is no path (or same node / unknown node)", () => {
    expect(pathsBetween(adj, "A", "B", { maxHops: 1 }).map((p) => p.nodes)).toEqual([["A", "B"]]); // only the direct edge fits
    expect(pathsBetween(adj, "A", "B", { topK: 1 }).length).toBe(1);
    expect(pathsBetween(adj, "A", "D")).toEqual([]); // disconnected components
    expect(pathsBetween(adj, "A", "A")).toEqual([]);
    expect(pathsBetween(adj, "A", "ZZZ")).toEqual([]);
  });

  it("reports the max intermediate degree (a hub-routing signal)", () => {
    // hub H touches A,B,X,Y (deg 4); via H is a hop through a hub, via C2 is not.
    const a2 = buildAdjacency([e("A", "H"), e("H", "B"), e("H", "X"), e("H", "Y"), e("A", "C2", "RELATED", 5), e("C2", "B", "RELATED", 5)]);
    const viaH = pathsBetween(a2, "A", "B").find((p) => p.nodes.includes("H"))!;
    const viaC2 = pathsBetween(a2, "A", "B").find((p) => p.nodes.includes("C2"))!;
    expect(viaH.maxIntermediateDegree).toBe(4);
    expect(viaC2.maxIntermediateDegree).toBe(2);
  });
});

describe("connectorsOf — the shared middle, rare-bridge-first", () => {
  it("finds intermediates bridging >= minSeeds seeds and excludes the seeds themselves", () => {
    // C bridges P1,P2,P3; L bridges only P1,P2.
    const adj = buildAdjacency([
      e("P1", "C"), e("P2", "C"), e("P3", "C"),
      e("P1", "L"), e("P2", "L"),
    ]);
    const cs = connectorsOf(adj, ["P1", "P2", "P3"], { minSeeds: 2 });
    const byId = new Map(cs.map((c) => [c.id, c]));
    expect(byId.get("C")!.seedsReached).toBe(3);
    expect(byId.get("L")!.seedsReached).toBe(2);
    expect(cs.some((c) => c.id.startsWith("P"))).toBe(false); // no seed is its own connector
    // require all 3 → L (only 2) drops out
    expect(connectorsOf(adj, ["P1", "P2", "P3"], { minSeeds: 3 }).map((c) => c.id)).toEqual(["C"]);
  });

  it("ranks a RARE shared node above a popular hub at equal connection strength", () => {
    // RARE bridges exactly P1,P2 (degree 2). HUB bridges P1,P2 and also X1..X4 (degree 6). Same edge weights.
    const adj = buildAdjacency([
      e("P1", "RARE"), e("P2", "RARE"),
      e("P1", "HUB"), e("P2", "HUB"), e("HUB", "X1"), e("HUB", "X2"), e("HUB", "X3"), e("HUB", "X4"),
    ]);
    const cs = connectorsOf(adj, ["P1", "P2"]);
    const rare = cs.find((c) => c.id === "RARE")!;
    const hub = cs.find((c) => c.id === "HUB")!;
    expect(rare.strengthSum).toBe(hub.strengthSum); // same connection strength...
    expect(rare.degree).toBeLessThan(hub.degree);
    expect(rare.bridgeScore).toBeGreaterThan(hub.bridgeScore); // ...but the rare bridge wins on distinctiveness
    expect(cs[0]!.id).toBe("RARE");
  });

  it("returns [] for fewer than two resolvable seeds", () => {
    const adj = buildAdjacency([e("P1", "C"), e("P2", "C")]);
    expect(connectorsOf(adj, ["P1"])).toEqual([]);
    expect(connectorsOf(adj, ["P1", "GHOST"])).toEqual([]); // GHOST not in graph → only 1 real seed
  });
});

describe("affinity — pairwise 'strongly connected' scalar", () => {
  const adj = buildAdjacency([
    e("A", "B", "RELATED", 1),
    e("A", "C1", "RELATED", 1), e("C1", "B", "RELATED", 1),
    e("A", "C2", "RELATED", 5), e("C2", "B", "RELATED", 5),
    e("W", "Z", "RELATED", 1), // isolated pair for the zero case
  ]);

  it("is symmetric, positive for connected nodes, and zero for disconnected ones", () => {
    expect(affinity(adj, "A", "B")).toBeCloseTo(affinity(adj, "B", "A"), 10);
    expect(affinity(adj, "A", "B")).toBeGreaterThan(0);
    expect(affinity(adj, "A", "W")).toBe(0);
  });

  it("rewards more and stronger connecting paths (a richly-linked pair beats a thinly-linked one)", () => {
    const thin = buildAdjacency([e("A", "B", "RELATED", 1)]); // one weak direct edge
    expect(affinity(adj, "A", "B")).toBeGreaterThan(affinity(thin, "A", "B"));
  });
});

describe("GraphStore integration — hydrated intersection queries end to end", () => {
  let store: GraphStore;
  const meta = { actor: "test", cause: "unit" };
  beforeEach(() => { store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) }); });
  afterEach(() => store.close());

  it("pathsBetween/connectorsOf resolve ids to node records and skip provenance edges", async () => {
    const mk = async (text: string, type: any = "PERSON"): Promise<string> => (await store.putNode({ type, origin: "user", text, name: text }, meta)).id;
    const p1 = await mk("Griet Kruiper");
    const p2 = await mk("Dawid Afrika");
    const concept = await mk("De Doorns grape harvest", "CONCEPT");
    const chunk = await mk("chunk text", "SOURCE");
    await store.putEdge({ from: p1, to: concept, kind: "RELATED", reason: "works the harvest there", origin: "connector" }, meta);
    await store.putEdge({ from: p2, to: concept, kind: "RELATED", reason: "grew up on that harvest", origin: "connector" }, meta);
    await store.putEdge({ from: p1, to: chunk, kind: "APPEARED_IN", reason: "provenance", origin: "ingest" }, meta); // must NOT connect

    const paths = store.pathsBetween(p1, p2);
    expect(paths.length).toBe(1);
    expect(paths[0]!.path.map((n) => n.name)).toEqual(["Griet Kruiper", "De Doorns grape harvest", "Dawid Afrika"]);

    const connectors = store.connectorsOf([p1, p2]);
    expect(connectors.length).toBe(1);
    expect(connectors[0]!.node!.name).toBe("De Doorns grape harvest");
    expect(store.affinity(p1, p2)).toBeGreaterThan(0);
  });

  it("reinforced edges raise the bottleneck strength of the path they lie on", async () => {
    const mk = async (t: string): Promise<string> => (await store.putNode({ type: "CONCEPT", origin: "user", text: t }, meta)).id;
    const a = await mk("A"), c = await mk("C"), b = await mk("B");
    // reinforce A–C three times (hebbianWeight 3), C–B once (weight 1) → bottleneck is 1
    for (let i = 0; i < 3; i++) await store.putEdge({ from: a, to: c, kind: "RELATED", reason: `assertion ${i}`, origin: "connector" }, meta);
    await store.putEdge({ from: c, to: b, kind: "RELATED", reason: "single link", origin: "connector" }, meta);
    const [p] = store.pathsBetween(a, b);
    expect(p!.edges.sort()).toEqual([1, 3]);
    expect(p!.strength).toBe(1); // weakest link governs
  });
});

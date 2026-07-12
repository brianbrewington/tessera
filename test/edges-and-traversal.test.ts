// Phase 2 (spec §4 edges + §7 edge-idempotency): the graph becomes walkable.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const meta = { actor: "test", cause: "unit" };

async function seedNodes(store: GraphStore, texts: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const t of texts) ids.push((await store.putNode({ type: "CONCEPT", origin: "user", text: t }, meta)).id);
  return ids;
}

describe("edges + traversal", () => {
  let store: GraphStore;
  beforeEach(() => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
  });
  afterEach(() => store.close());

  it("edge-idempotency: putEdge twice = one edge, one hebbian bump, two assertions", async () => {
    const [a, b] = await seedNodes(store, ["alpha idea", "beta idea"]);
    const e1 = await store.putEdge({ from: a!, to: b!, kind: "RELATED", reason: "a relates to b", origin: "connector" }, meta);
    const e2 = await store.putEdge(
      { from: a!, to: b!, kind: "RELATED", reason: "a also relates to b differently", origin: "connector" },
      meta,
    );

    expect(e1.created).toBe(true);
    expect(e2.created).toBe(false);
    expect(e2.edgeId).toBe(e1.edgeId);
    expect(store.countEdges()).toBe(1);
    expect(store.getEdge(e1.edgeId)!.hebbianWeight).toBe(2);
    expect(store.countAssertions(e1.edgeId)).toBe(2);
  });

  it("a different polarity is a distinct edge", async () => {
    const [a, b] = await seedNodes(store, ["x", "y"]);
    await store.putEdge({ from: a!, to: b!, kind: "RELATED", polarity: "supports", reason: "x supports y", origin: "connector" }, meta);
    await store.putEdge({ from: a!, to: b!, kind: "RELATED", polarity: "contradicts", reason: "x contradicts y", origin: "connector" }, meta);
    expect(store.countEdges()).toBe(2);
  });

  it("expert_surprise is Store-computed (0..3), not caller-settable", async () => {
    // PutEdgeInput has no `expert_surprise` field, so a caller cannot launder it in.
    const [a, b] = await seedNodes(store, ["the color blue", "an unrelated tax statute clause"]);
    const e = await store.putEdge({ from: a!, to: b!, kind: "RELATED", reason: "a surprising bridge", origin: "connector" }, meta);
    const surprise = store.assertionSurprise(e.assertionId);
    expect(surprise).not.toBeNull();
    expect(surprise!).toBeGreaterThanOrEqual(0);
    expect(surprise!).toBeLessThanOrEqual(3);
  });

  it("strict inputs reject laundered fields (no caller-set surprise/strength)", async () => {
    const [a, b] = await seedNodes(store, ["p", "q"]);
    await expect(
      store.putEdge({ from: a!, to: b!, kind: "RELATED", reason: "r", origin: "connector", expert_surprise: 3 } as any, meta),
    ).rejects.toThrow();
    await expect(store.putNode({ type: "CONCEPT", origin: "user", text: "z", strength: 999 } as any, meta)).rejects.toThrow();
  });

  it("traversal: getNeighbors and getSubgraph walk the graph (induced edges only)", async () => {
    const [a, b, c, d] = await seedNodes(store, ["A", "B", "C", "D"]);
    await store.putEdge({ from: a!, to: b!, kind: "RELATED", reason: "a-b", origin: "connector" }, meta);
    await store.putEdge({ from: b!, to: c!, kind: "RELATED", reason: "b-c", origin: "connector" }, meta);
    await store.putEdge({ from: c!, to: d!, kind: "RELATED", reason: "c-d", origin: "connector" }, meta);

    const nb = store.getNeighbors(b!).map((n) => n.id).sort();
    expect(nb).toEqual([a, c].sort());

    // 2 hops from A reaches A,B,C (not D); edges are induced (c->d excluded, d outside set)
    const sg = store.getSubgraph([a!], 2);
    expect(sg.nodes.map((n) => n.id).sort()).toEqual([a, b, c].sort());
    const edgeKeys = sg.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edgeKeys).toEqual([`${a}->${b}`, `${b}->${c}`].sort());
  });
});

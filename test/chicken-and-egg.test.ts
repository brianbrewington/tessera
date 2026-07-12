// The load-bearing slice-1 test (spec §7). "Not embedded" means "not in the SHARED
// index" — a fresh node is visible to quarantine (dedup/Connector can ground it) but
// invisible to retrieval until promoted. Also asserts: NO user-origin durable shortcut.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const TEXT = "attention is a scarce resource";

describe("chicken-and-egg (two-tier index)", () => {
  let store: GraphStore;
  const embedder = new StubEmbedder(64);
  const q = () => embedder.embed(TEXT);

  beforeEach(() => {
    store = new GraphStore({ path: ":memory:", embedder });
  });
  afterEach(() => store.close());

  it("putNode lands in quarantine, not shared; promoteNode copies it to shared", async () => {
    const { id, reinforced } = await store.putNode(
      { type: "CONCEPT", origin: "user", text: TEXT },
      { actor: "test", cause: "unit" },
    );
    expect(reinforced).toBe(false);

    const inQuarantine = await store.querySimilar(await q(), 5, { index: "quarantine" });
    expect(inQuarantine.map((h) => h.node.id)).toContain(id);

    const beforePromote = await store.querySimilar(await q(), 5, { index: "shared" });
    expect(beforePromote.map((h) => h.node.id)).not.toContain(id);

    store.promoteNode(id, { citation: "test" }, { actor: "test", cause: "promote" });

    const afterPromote = await store.querySimilar(await q(), 5, { index: "shared" });
    expect(afterPromote.map((h) => h.node.id)).toContain(id);
    expect(store.getNode(id)!.status).toBe("durable");
  });

  it("user-origin node has NO durable shortcut — still proposed, still out of shared until promoted", async () => {
    const { id } = await store.putNode(
      { type: "MEMORY", origin: "user", text: "a private note only I wrote" },
      { actor: "test", cause: "unit" },
    );
    expect(store.getNode(id)!.status).toBe("proposed");
    const shared = await store.querySimilar(await embedder.embed("a private note only I wrote"), 5, {
      index: "shared",
    });
    expect(shared.map((h) => h.node.id)).not.toContain(id);
  });

  it("querySimilar on an empty index returns [] (never crashes)", async () => {
    const hits = await store.querySimilar(await q(), 5, { index: "shared" });
    expect(hits).toEqual([]);
  });

  it("a durable node's vector identity is one — shared copy equals the quarantine vector", async () => {
    const { id } = await store.putNode(
      { type: "CONCEPT", origin: "user", text: TEXT },
      { actor: "test", cause: "unit" },
    );
    store.promoteNode(id, {}, { actor: "test", cause: "promote" });
    const vq = store.vectorOf(id, "quarantine")!;
    const vs = store.vectorOf(id, "shared")!;
    expect(Array.from(vs)).toEqual(Array.from(vq));
  });
});

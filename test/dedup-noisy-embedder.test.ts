// Guards against cosine-drift-below-0.99 (spec §7): dedup must key on content identity,
// not a float threshold. A noisy/upgraded embedder must NOT create a duplicate of the
// same note (which would double its prominence).
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder, NoisyEmbedder, cosine } from "../src/embedder.js";

const TEXT = "the map is not the territory";

describe("dedup-noisy-embedder", () => {
  let store: GraphStore;
  afterEach(() => store?.close());

  it("re-ingesting identical text dedups on content_hash despite embedding noise", async () => {
    const embedder = new NoisyEmbedder(new StubEmbedder(64), 0.25);
    store = new GraphStore({ path: ":memory:", embedder });

    const a = await store.putNode({ type: "CONCEPT", origin: "ingest", text: TEXT }, { actor: "t", cause: "ingest" });
    const b = await store.putNode({ type: "CONCEPT", origin: "ingest", text: TEXT }, { actor: "t", cause: "ingest" });

    // Sanity: the noise really did push the two embeddings apart (below the 0.99 secondary
    // threshold), so content_hash is what caught the dup — not cosine.
    const v1 = await embedder.embed(TEXT);
    const v2 = await embedder.embed(TEXT);
    expect(cosine(v1, v2)).toBeLessThan(0.99);

    expect(b.reinforced).toBe(true);
    expect(b.id).toBe(a.id);
    expect(store.countNodes()).toBe(1);
    expect(store.getNode(a.id)!.strength).toBeGreaterThan(1);
  });

  it("different text does NOT dedup", async () => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    const a = await store.putNode({ type: "CONCEPT", origin: "ingest", text: "alpha beta" }, { actor: "t", cause: "i" });
    const b = await store.putNode({ type: "CONCEPT", origin: "ingest", text: "gamma delta" }, { actor: "t", cause: "i" });
    expect(b.reinforced).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(store.countNodes()).toBe(2);
  });
});

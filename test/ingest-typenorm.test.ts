// D4 stage 1b (channel 0079/0080, approved 0085): constrained type-vocabulary normalization at map
// time. An incoming entity typed OTHER/CODE/PROJECT folds to its name-group's strict-majority
// existing type (weighted by node strength — a group holds one node PER type, so node-count always
// ties); PERSON<->TECHNOLOGY is never auto-collapsed, which holds by construction because neither
// is in the foldable set. Grok-seat's 0080 hazard pinned as a test: the cheapest identity fix must
// not manufacture the handle-vs-product collision injection was barred for.
import { describe, it, expect } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { mapExtraction } from "../src/ingest/mapper.js";
import { foldEntityType } from "../src/ingest/typenorm.js";
import type { Meta } from "../src/schema.js";

const meta: Meta = { actor: "test", cause: "typenorm-test" };
const emb = new StubEmbedder();

async function seed(store: GraphStore, type: string, name: string, times: number): Promise<string> {
  let id = "";
  for (let i = 0; i < times; i++) {
    const put = await store.putNode(
      { type: "CONCEPT", subtype: "seed", origin: "ingest", text: `${type.toLowerCase()}\t${name.toLowerCase()}`, name, description: `${name} seeded` },
      meta, await emb.embed(name),
    );
    id = put.id;
  }
  return id;
}

describe("foldEntityType", () => {
  it("folds OTHER to the group's strict-majority type", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "TECHNOLOGY", "claude-code", 3);
    await seed(store, "CONCEPT", "claude-code", 1);
    expect(foldEntityType(store, "OTHER", "claude-code")).toBe("TECHNOLOGY");
    store.close();
  });
  it("does not fold on a strength tie", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "PERSON", "claude-code", 2);
    await seed(store, "TECHNOLOGY", "claude-code", 2);
    expect(foldEntityType(store, "OTHER", "claude-code")).toBe("OTHER");
    store.close();
  });
  it("never folds types outside OTHER/CODE/PROJECT (the PERSON<->TECHNOLOGY guard)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "PERSON", "claude-code", 5);
    expect(foldEntityType(store, "TECHNOLOGY", "claude-code")).toBe("TECHNOLOGY");
    expect(foldEntityType(store, "PERSON", "claude-code")).toBe("PERSON");
    store.close();
  });
  it("returns the input type when the group is empty", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    expect(foldEntityType(store, "OTHER", "brand-new")).toBe("OTHER");
    store.close();
  });
  it("consolidates weak types onto a dominant weak-typed node (post-review rule: all types are attractors)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "OTHER", "loose-thing", 4);
    expect(foldEntityType(store, "CODE", "loose-thing")).toBe("OTHER");
    store.close();
  });
  it("PROJECT can attract jitter (Grok review: the first version made this impossible)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "PROJECT", "tessera", 5);
    await seed(store, "TECHNOLOGY", "tessera", 2);
    expect(foldEntityType(store, "OTHER", "tessera")).toBe("PROJECT");
    store.close();
  });
  it("CODE is genuinely foldable (Composer review: narrowing FOLDABLE to OTHER-only must fail a test)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "TECHNOLOGY", "streaming fft", 3);
    expect(foldEntityType(store, "CODE", "streaming fft")).toBe("TECHNOLOGY");
    store.close();
  });
  it("ignores non-entity and unknown-prefix rows sharing the name suffix (review: SQL scoping)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    // A one-tab row whose prefix is NOT an extractor type must not become a fold target.
    await store.putNode(
      { type: "SOURCE", subtype: "doc", origin: "ingest", text: "source\tclaude-code", name: "claude-code", description: "doc row" },
      meta, await emb.embed("doc"),
    );
    for (let i = 0; i < 9; i++) {
      await store.putNode(
        { type: "SOURCE", subtype: "doc", origin: "ingest", text: "source\tclaude-code", name: "claude-code", description: "doc row" },
        meta, await emb.embed("doc"),
      );
    }
    expect(foldEntityType(store, "OTHER", "claude-code")).toBe("OTHER"); // strength-10 SOURCE row invisible
    await seed(store, "TECHNOLOGY", "claude-code", 2);
    expect(foldEntityType(store, "OTHER", "claude-code")).toBe("TECHNOLOGY"); // real entity row wins instead
    store.close();
  });
});

describe("mapExtraction applies the fold", () => {
  it("an OTHER mention of an established TECHNOLOGY name reinforces the existing node instead of minting a twin", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const techId = await seed(store, "TECHNOLOGY", "claude-code", 3);
    const chunk = await store.putNode(
      { type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\tabc\t123", name: "c1", description: "" },
      meta, await emb.embed("c1"),
    );
    const before = store.countNodes();
    const strengthBefore = store.getNode(techId)!.strength;
    const r = await mapExtraction(
      store, emb, meta,
      { entities: [{ name: "claude-code", type: "OTHER", description: "the seat" }], relations: [] },
      new Map(), { id: chunk.id, label: "c1" },
    );
    expect(r.entityCount).toBe(0); // reinforced, not created
    expect(store.countNodes()).toBe(before); // no twin
    expect(store.getNode(techId)!.strength).toBeGreaterThan(strengthBefore);
    store.close();
  });
  it("a PERSON-majority group still splits an incoming TECHNOLOGY mention (guard end to end)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    await seed(store, "PERSON", "claude-code", 5);
    const chunk = await store.putNode(
      { type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\tabc\t456", name: "c2", description: "" },
      meta, await emb.embed("c2"),
    );
    const before = store.countNodes();
    await mapExtraction(
      store, emb, meta,
      { entities: [{ name: "claude-code", type: "TECHNOLOGY", description: "the product" }], relations: [] },
      new Map(), { id: chunk.id, label: "c2" },
    );
    expect(store.countNodes()).toBe(before + 1); // distinct node minted — no auto-collapse
    store.close();
  });
});

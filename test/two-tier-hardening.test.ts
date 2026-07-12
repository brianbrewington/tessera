// Tests closing the two gaps the Phase-1 review gate surfaced:
//  (1) the sqlite-vec distance -> cosine conversion was never actually exercised;
//  (2) the dedup TOCTOU under a second writer connection.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";

const meta = { actor: "test", cause: "unit" };

describe("cosine conversion (pins sqlite-vec L2 -> cosine)", () => {
  let store: GraphStore;
  afterEach(() => store?.close());

  it("querySimilar cosine matches the true dot product for unit vectors", async () => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(3) });
    const A = await store.putNode({ type: "CONCEPT", origin: "user", text: "A" }, meta, Float32Array.from([1, 0, 0]));
    const B = await store.putNode({ type: "CONCEPT", origin: "user", text: "B" }, meta, Float32Array.from([0, 1, 0]));
    const C = await store.putNode(
      { type: "CONCEPT", origin: "user", text: "C" },
      meta,
      Float32Array.from([0.5, Math.sqrt(3) / 2, 0]), // 60° from A -> cos 0.5
    );

    const hits = await store.querySimilar(Float32Array.from([1, 0, 0]), 5, { index: "quarantine" });
    const cos = new Map(hits.map((h) => [h.node.id, h.cosine]));
    expect(cos.get(A.id)!).toBeCloseTo(1.0, 5); // identical
    expect(cos.get(B.id)!).toBeCloseTo(0.0, 5); // orthogonal
    expect(cos.get(C.id)!).toBeCloseTo(0.5, 4); // 60°
  });
});

describe("cross-connection dedup (the TOCTOU fix)", () => {
  it("a second Store on the same file reinforces, does not duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-"));
    const path = join(dir, "g.db");
    const embedder = new StubEmbedder(64);
    const a = new GraphStore({ path, embedder });
    const b = new GraphStore({ path, embedder });
    try {
      const r1 = await a.putNode({ type: "CONCEPT", origin: "ingest", text: "a shared fact" }, meta);
      // b is a *separate connection* to the same DB file; its dedup read runs inside a
      // BEGIN IMMEDIATE txn and sees a's committed node -> reinforces instead of splitting.
      const r2 = await b.putNode({ type: "CONCEPT", origin: "ingest", text: "a shared fact" }, meta);
      expect(r2.reinforced).toBe(true);
      expect(r2.id).toBe(r1.id);
      expect(b.countNodes()).toBe(1);
      expect(a.getNode(r1.id)!.strength).toBeGreaterThan(1);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Phase 3: ingest + analytic connect, with the deterministic StubEmbedder (no network).
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { parseNote, ingestNotes, type Note } from "../src/ingest/markdown.js";
import { connect } from "../src/connect/connector.js";

const meta = { actor: "test", cause: "unit" };

describe("markdown parse", () => {
  it("strips frontmatter, title from heading, drops suggested-connections block", () => {
    const raw = `---
type: chapter
source: Book
---

# The Guardian

The guardian is the chief-of-staff agent.

<!-- suggested-connections:start -->
- [[Something]] · 0.58
<!-- suggested-connections:end -->
`;
    const n = parseNote("/x/guardian.md", raw);
    expect(n.title).toBe("The Guardian");
    expect(n.noteType).toBe("chapter");
    expect(n.body).toContain("chief-of-staff");
    expect(n.body).not.toContain("suggested-connections");
    expect(n.body).not.toContain("type: chapter");
  });

  it("falls back to filename when there is no heading", () => {
    const n = parseNote("/x/my-note.md", "just some body text, no heading");
    expect(n.title).toBe("my-note");
  });
});

describe("ingest + connect", () => {
  let store: GraphStore;
  afterEach(() => store.close());

  it("ingests notes as proposed CONCEPT nodes and connects near ones", async () => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    // two clusters: cats vs finance — within-cluster should link, across should not.
    const notes: Note[] = [
      { path: "/a.md", title: "cats", noteType: null, body: "cats felines whiskers purring kittens" },
      { path: "/b.md", title: "cats2", noteType: null, body: "cats felines whiskers purring tabby" },
      { path: "/c.md", title: "bonds", noteType: null, body: "bonds yield treasury coupon maturity" },
    ];
    const ids = await ingestNotes(store, notes, meta);
    expect(store.countNodes()).toBe(3);
    expect(store.getNode(ids[0]!)!.status).toBe("proposed");
    expect(store.getNode(ids[0]!)!.origin).toBe("ingest");

    await connect(store, { k: 4, threshold: 0.3 });
    // the two cat notes share 4/5 tokens -> high cosine -> linked; bonds is disjoint.
    const catEdges = store.getEdges(ids[0]!);
    expect(catEdges.length).toBeGreaterThanOrEqual(1);
    const neighborIds = new Set(store.getNeighbors(ids[0]!).map((n) => n.id));
    expect(neighborIds.has(ids[1]!)).toBe(true); // cats ~ cats2
    expect(neighborIds.has(ids[2]!)).toBe(false); // cats !~ bonds
  });

  it("connect is idempotent — a second pass adds no new edges", async () => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    const notes: Note[] = [
      { path: "/a.md", title: "a", noteType: null, body: "shared alpha beta gamma" },
      { path: "/b.md", title: "b", noteType: null, body: "shared alpha beta delta" },
    ];
    await ingestNotes(store, notes, meta);
    await connect(store, { k: 4, threshold: 0.3 });
    const after1 = store.countEdges();
    await connect(store, { k: 4, threshold: 0.3 });
    expect(store.countEdges()).toBe(after1);
  });
});

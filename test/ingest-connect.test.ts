// Phase 3: markdown ingest, with the deterministic StubEmbedder (no network). The naive analytic
// `connect` this file used to exercise was removed (it eager-auto-linked at cosine>=0.55 — the hairball
// the mining sketch §3.3 replaces); the hardened Connector's propose/evaluate machinery is covered in
// test/connector.test.ts. Here we keep the markdown-parse + proposed-node coverage.
import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { parseNote, ingestNotes, type Note } from "../src/ingest/markdown.js";

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

describe("markdown ingest", () => {
  let store: GraphStore;
  afterEach(() => store.close());

  it("ingests notes as proposed CONCEPT nodes with origin:ingest", async () => {
    store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    const notes: Note[] = [
      { path: "/a.md", title: "cats", noteType: null, body: "cats felines whiskers purring kittens" },
      { path: "/b.md", title: "cats2", noteType: null, body: "cats felines whiskers purring tabby" },
      { path: "/c.md", title: "bonds", noteType: null, body: "bonds yield treasury coupon maturity" },
    ];
    const ids = await ingestNotes(store, notes, meta);
    expect(store.countNodes()).toBe(3);
    expect(store.getNode(ids[0]!)!.status).toBe("proposed");
    expect(store.getNode(ids[0]!)!.origin).toBe("ingest");
  });
});

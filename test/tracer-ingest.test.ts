// Tracer ingest — the reviewers' missing coverage: identity policy, provenance, edge canonicalization,
// cross-doc dedup + reinforce-merge, assertion idempotency, and the full ingestFile spine. All deterministic
// (StubEmbedder + StubChat), no network/LLM.
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { StubChat } from "../src/llm.js";
import { LlmExtractor, type Extraction } from "../src/extract/extractor.js";
import { mapExtraction } from "../src/ingest/mapper.js";
import { entityIdentity, chunkIdentity, canonical } from "../src/extract/identity.js";
import { Graph } from "../src/graph.js";
import { ingestFile } from "../src/ingest/ingest.js";

const meta = { actor: "test", cause: "unit" };
const emb = new StubEmbedder(64);
const mkChunk = async (s: GraphStore, id = "c1"): Promise<string> =>
  (await s.putNode({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: `chunk\t${id}`, name: id, description: "raw" }, meta)).id;

describe("identity strings", () => {
  it("hubs merge by type+name; PERSON is source-qualified; type is part of identity", () => {
    expect(entityIdentity("PLACE", "De Doorns", "a.md")).toBe(entityIdentity("PLACE", "de doorns", "b.md"));
    expect(entityIdentity("PERSON", "Anele Sotashe", "a.md")).not.toBe(entityIdentity("PERSON", "Anele Sotashe", "b.md"));
    expect(entityIdentity("PLACE", "Java", "a.md")).not.toBe(entityIdentity("CONCEPT", "Java", "a.md"));
  });
  it("chunk identity is source+text keyed; canonical orders endpoints", () => {
    expect(chunkIdentity("a.md", "hello")).toBe(chunkIdentity("a.md", "hello"));
    expect(chunkIdentity("a.md", "hello")).not.toBe(chunkIdentity("b.md", "hello"));
    expect(canonical("z", "a")).toEqual(["a", "z"]);
  });
});

describe("mapExtraction", () => {
  let store: GraphStore;
  afterEach(() => store.close());

  it("typed nodes with first-class name/description, APPEARED_IN provenance, canonical RELATED", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    const ex: Extraction = {
      entities: [
        { name: "De Doorns", type: "PLACE", description: "a town in the Western Cape" },
        { name: "Klipgat Farm", type: "PLACE", description: "a farm near De Doorns" },
      ],
      relations: [{ source: "Klipgat Farm", target: "De Doorns", reason: "Klipgat Farm is near De Doorns" }],
    };
    const r = await mapExtraction(store, emb, meta, ex, "doc.md", new Map(), { id: ch, label: "chunk 1" });
    expect(r.entityCount).toBe(2);
    expect(store.allNodes().filter((n) => n.type !== "SOURCE").length).toBe(2); // 2 entities (chunk is SOURCE)
    const dd = store.allNodes().find((n) => n.name === "De Doorns")!;
    expect(dd.description).toContain("Western Cape"); // first-class description
    expect(store.allEdges().filter((e) => e.kind === "APPEARED_IN").length).toBe(2); // each entity -> chunk
    const rel = store.allEdges().find((e) => e.kind === "RELATED")!;
    expect(rel.from < rel.to).toBe(true); // canonical endpoint order
  });

  it("undirected A->B and B->A collapse to ONE canonical RELATED edge", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    const known = new Map<string, string>();
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "A", type: "CONCEPT", description: "" }, { name: "B", type: "CONCEPT", description: "" }],
        relations: [{ source: "A", target: "B", reason: "A links B" }] },
      "doc.md", known, { id: ch, label: "c1" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "A", type: "CONCEPT", description: "" }, { name: "B", type: "CONCEPT", description: "" }],
        relations: [{ source: "B", target: "A", reason: "B links A" }] },
      "doc.md", known, { id: ch, label: "c2" });
    expect(store.allEdges().filter((e) => e.kind === "RELATED").length).toBe(1);
  });

  it("same hub across docs dedups and reinforce keeps the RICHER description", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a town" }], relations: [] },
      "docA.md", new Map(), { id: ch, label: "cA" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a farming town in the Hex River Valley, Western Cape" }], relations: [] },
      "docB.md", new Map(), { id: ch, label: "cB" });
    const places = store.allNodes().filter((n) => n.name === "De Doorns");
    expect(places.length).toBe(1); // one shared hub across docs
    expect(places[0]!.description).toContain("Hex River Valley"); // richer won
    expect(places[0]!.strength).toBe(2); // reinforced
  });

  it("PERSON with the same name but distinct lives from two sources stays two nodes", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    const p = (desc: string): Extraction => ({ entities: [{ name: "Anele Sotashe", type: "PERSON", description: desc }], relations: [] });
    // distinct people share a name but not a life — source-qualified identity AND distinct content keep them apart.
    await mapExtraction(store, emb, meta, p("a grape farmer in the Boland near Paarl"), "docA.md", new Map(), { id: ch, label: "cA" });
    await mapExtraction(store, emb, meta, p("a fisherman mending nets in Lambert's Bay"), "docB.md", new Map(), { id: ch, label: "cB" });
    expect(store.allNodes().filter((n) => n.type === "PERSON").length).toBe(2);
  });

  it("type-blind homographs split: PLACE Java and CONCEPT Java become two nodes", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    // Same name, different types, IDENTICAL descriptions — only the type-in-identity + nearDupMerge:false
    // keep them apart (a cosine near-dup merge would have collapsed them).
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "Java", type: "PLACE", description: "an island" }, { name: "Java", type: "CONCEPT", description: "an island" }], relations: [] },
      "doc.md", new Map(), { id: ch, label: "c1" });
    const javas = store.allNodes().filter((n) => n.name === "Java");
    expect(javas.length).toBe(2); // NOT collapsed by cosine near-dup
    expect(new Set(javas.map((n) => n.subtype)).size).toBe(2); // place + concept — the type-in-identity split
  });

  it("within a doc, a later richer mention upgrades the description (node-reuse via known)", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const known = new Map<string, string>();
    const c1 = await mkChunk(store, "c1");
    const c2 = await mkChunk(store, "c2");
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a town" }], relations: [] },
      "doc.md", known, { id: c1, label: "c1" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a farming town in the Hex River Valley" }], relations: [] },
      "doc.md", known, { id: c2, label: "c2" });
    const places = store.allNodes().filter((n) => n.name === "De Doorns");
    expect(places.length).toBe(1); // reused across chunks in one doc
    expect(places[0]!.description).toContain("Hex River Valley"); // richer won within the doc
  });

  it("type-conflict guard: a colliding-identity node of a different type never clobbers name/description", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    // Force an identity collision (same `text`) across store types — the store must keep the original, not overwrite.
    await store.putNode({ type: "CONCEPT", origin: "ingest", text: "collide", name: "Original", description: "the good description" }, meta);
    await store.putNode({ type: "PERSON", origin: "ingest", text: "collide", name: "Impostor", description: "" }, meta);
    const nodes = store.allNodes().filter((n) => n.text === "collide");
    expect(nodes.length).toBe(1); // deduped on identity
    expect(nodes[0]!.type).toBe("CONCEPT"); // original type preserved
    expect(nodes[0]!.name).toBe("Original"); // not clobbered
    expect(nodes[0]!.description).toBe("the good description");
  });

  it("assertion idempotency: same edge+reason inserts one assertion", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const a = (await store.putNode({ type: "CONCEPT", origin: "ingest", text: "a", name: "A", description: "" }, meta)).id;
    const b = (await store.putNode({ type: "CONCEPT", origin: "ingest", text: "b", name: "B", description: "" }, meta)).id;
    const e = await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "A relates to B", origin: "ingest" }, meta);
    await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "A relates to B", origin: "ingest" }, meta); // dup reason
    expect(store.countAssertions(e.edgeId)).toBe(1);
    await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "A also feeds B", origin: "ingest" }, meta); // new reason
    expect(store.countAssertions(e.edgeId)).toBe(2);
  });
});

describe("ingestFile (full spine, stub LLM)", () => {
  it("creates SOURCE + CHUNK nodes with provenance; re-ingest is idempotent", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const canned = JSON.stringify({ entities: [{ name: "Test Entity", type: "CONCEPT", description: "a thing" }], relations: [] });
    const extractor = new LlmExtractor(new StubChat(canned));
    const dir = mkdtempSync(join(tmpdir(), "tessera-test-"));
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Title\n\nFirst paragraph mentioning a Test Entity.\n");

    const r1 = await ingestFile(g, extractor, docPath);
    expect(r1.chunks).toBeGreaterThanOrEqual(1);
    expect(store.allNodes().some((n) => n.subtype === "document")).toBe(true);
    expect(store.allNodes().some((n) => n.subtype === "chunk")).toBe(true);
    expect(store.allNodes().some((n) => n.name === "Test Entity")).toBe(true);
    expect(store.allEdges().some((e) => e.kind === "ORIGINATED_FROM")).toBe(true); // chunk -> source
    expect(store.allEdges().some((e) => e.kind === "APPEARED_IN")).toBe(true); // entity -> chunk

    const n1 = store.allNodes().length, e1 = store.countEdges();
    await ingestFile(g, extractor, docPath); // re-ingest same doc
    expect(store.allNodes().length).toBe(n1); // no new nodes
    expect(store.countEdges()).toBe(e1); // no new edges
    store.close();
  });
});

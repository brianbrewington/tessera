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
import { LlmExtractor, parseExtraction, subjectClause, type Extraction } from "../src/extract/extractor.js";
import { mapExtraction } from "../src/ingest/mapper.js";
import { entityIdentity, chunkIdentity, canonical } from "../src/extract/identity.js";
import { Graph } from "../src/graph.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { readDoc } from "../src/ingest/adapters.js";
import { resolve } from "node:path";

const meta = { actor: "test", cause: "unit" };
const emb = new StubEmbedder(64);
const mkChunk = async (s: GraphStore, id = "c1"): Promise<string> =>
  (await s.putNode({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: `chunk\t${id}`, name: id, description: "raw" }, meta)).id;

describe("identity strings", () => {
  it("hubs merge by type+name — INCLUDING person (no source/path qualifier); type is part of identity", () => {
    expect(entityIdentity("PLACE", "De Doorns")).toBe(entityIdentity("PLACE", "de doorns"));
    // content-addressed: the same-named person is ONE node regardless of source — path is not an identity
    // qualifier anymore (genuine same-name-different-person collisions are the dedup/disambiguation layer's job).
    expect(entityIdentity("PERSON", "Anele Sotashe")).toBe(entityIdentity("PERSON", "anele sotashe"));
    expect(entityIdentity("PLACE", "Java")).not.toBe(entityIdentity("CONCEPT", "Java"));
  });
  it("chunk identity is source-content-hash + text keyed; canonical orders endpoints", () => {
    expect(chunkIdentity("srcH1", "hello")).toBe(chunkIdentity("srcH1", "hello"));
    expect(chunkIdentity("srcH1", "hello")).not.toBe(chunkIdentity("srcH2", "hello")); // different SOURCE content
    expect(chunkIdentity("srcH1", "hello")).not.toBe(chunkIdentity("srcH1", "world")); // different chunk text
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
    const r = await mapExtraction(store, emb, meta, ex, new Map(), { id: ch, label: "chunk 1" });
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
      known, { id: ch, label: "c1" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "A", type: "CONCEPT", description: "" }, { name: "B", type: "CONCEPT", description: "" }],
        relations: [{ source: "B", target: "A", reason: "B links A" }] },
      known, { id: ch, label: "c2" });
    expect(store.allEdges().filter((e) => e.kind === "RELATED").length).toBe(1);
  });

  it("same hub across docs dedups and reinforce keeps the RICHER description", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a town" }], relations: [] },
      new Map(), { id: ch, label: "cA" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a farming town in the Hex River Valley, Western Cape" }], relations: [] },
      new Map(), { id: ch, label: "cB" });
    const places = store.allNodes().filter((n) => n.name === "De Doorns");
    expect(places.length).toBe(1); // one shared hub across docs
    expect(places[0]!.description).toContain("Hex River Valley"); // richer won
    expect(places[0]!.strength).toBe(2); // reinforced
  });

  it("same-named PERSON from two docs now MERGES to one node spanning both chunks (content-addressed identity)", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const chA = await mkChunk(store, "cA"); // two DISTINCT chunks — genuinely different "documents"
    const chB = await mkChunk(store, "cB");
    const p = (desc: string): Extraction => ({ entities: [{ name: "Anele Sotashe", type: "PERSON", description: desc }], relations: [] });
    // Path is no longer an identity qualifier: a real person appearing in two docs is ONE node (the whole point
    // of a cross-document graph). The cost is that two GENUINELY-different same-named people also merge — v1's
    // PERSON-merge audit (a person whose APPEARED_IN chunks span >1 source) surfaces that, so it's visible not silent.
    await mapExtraction(store, emb, meta, p("a grape farmer in the Boland near Paarl"), new Map(), { id: chA, label: "cA" });
    await mapExtraction(store, emb, meta, p("a fisherman mending nets in Lambert's Bay"), new Map(), { id: chB, label: "cB" });
    const people = store.allNodes().filter((n) => n.type === "PERSON");
    expect(people.length).toBe(1); // ONE merged node...
    const appearances = store.getEdges(people[0]!.id).filter((e) => e.kind === "APPEARED_IN");
    expect(appearances.length).toBe(2); // ...that genuinely spans BOTH chunks (this is the audit signal for slice 3)
  });

  it("type-blind homographs split: PLACE Java and CONCEPT Java become two nodes", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    // Same name, different types, IDENTICAL descriptions — only the type-in-identity + nearDupMerge:false
    // keep them apart (a cosine near-dup merge would have collapsed them).
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "Java", type: "PLACE", description: "an island" }, { name: "Java", type: "CONCEPT", description: "an island" }], relations: [] },
      new Map(), { id: ch, label: "c1" });
    const javas = store.allNodes().filter((n) => n.name === "Java");
    expect(javas.length).toBe(2); // NOT collapsed by cosine near-dup
    expect(new Set(javas.map((n) => n.subtype)).size).toBe(2); // place + concept — the type-in-identity split
  });

  it("a relation naming a type-split homograph is dropped, not miswired to an arbitrary node", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const ch = await mkChunk(store);
    // "Java" splits into PLACE + CONCEPT; the relation names "Java" — unresolvable to one node, so skip it
    // rather than bind the wrong (last-written) Java. "Bali -> Indonesia" is unambiguous and must still wire.
    const ex: Extraction = {
      entities: [
        { name: "Java", type: "PLACE", description: "an island" },
        { name: "Java", type: "CONCEPT", description: "a programming language" },
        { name: "Bali", type: "PLACE", description: "an island" },
        { name: "Indonesia", type: "PLACE", description: "a country" },
      ],
      relations: [
        { source: "Indonesia", target: "Java", reason: "Java is an island of Indonesia" }, // ambiguous -> drop
        { source: "Bali", target: "Indonesia", reason: "Bali is an island of Indonesia" }, // clean -> wire
      ],
    };
    const r = await mapExtraction(store, emb, meta, ex, new Map(), { id: ch, label: "c1" });
    expect(store.allNodes().filter((n) => n.name === "Java").length).toBe(2); // both Javas exist
    expect(r.edgeCount).toBe(1); // only the unambiguous Bali->Indonesia edge
    const rels = store.allEdges().filter((e) => e.kind === "RELATED");
    expect(rels.length).toBe(1);
    const ends = new Set([rels[0]!.from, rels[0]!.to]);
    for (const j of store.allNodes().filter((n) => n.name === "Java")) expect(ends.has(j.id)).toBe(false); // no Java edge
  });

  it("reinforce refreshes the stored embedding when the description upgrades (no stale RAG vector)", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const id = "concept\tx";
    const put1 = await store.putNode({ type: "CONCEPT", origin: "ingest", text: id, name: "X", description: "short" }, meta, await emb.embed("X. short"));
    const rich = "X. a much longer, richer description of X in the Hex River Valley";
    await store.putNode({ type: "CONCEPT", origin: "ingest", text: id, name: "X", description: rich.slice(3) }, meta, await emb.embed(rich));
    // The node is now retrieved by the NEW content's embedding (~1.0), not the stale first-mention one.
    const hits = await store.querySimilar(await emb.embed(rich), 1, { index: "quarantine" });
    expect(hits[0]!.node.id).toBe(put1.id);
    expect(hits[0]!.cosine).toBeGreaterThan(0.999);
  });

  it("within a doc, a later richer mention upgrades the description (node-reuse via known)", async () => {
    store = new GraphStore({ path: ":memory:", embedder: emb });
    const known = new Map<string, string>();
    const c1 = await mkChunk(store, "c1");
    const c2 = await mkChunk(store, "c2");
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a town" }], relations: [] },
      known, { id: c1, label: "c1" });
    await mapExtraction(store, emb, meta,
      { entities: [{ name: "De Doorns", type: "PLACE", description: "a farming town in the Hex River Valley" }], relations: [] },
      known, { id: c2, label: "c2" });
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

  it("chunk memo: re-ingest reuses already-extracted chunks and does NOT call the extractor again", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    let calls = 0;
    const canned = JSON.stringify({ entities: [{ name: "Kilo", type: "CONCEPT", description: "k" }], relations: [] });
    const extractor = new LlmExtractor(new StubChat(() => { calls++; return canned; }));
    const dir = mkdtempSync(join(tmpdir(), "tessera-memo-"));
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\nMentions Kilo once.\n");

    const r1 = await ingestFile(g, extractor, docPath);
    expect(r1.reused).toBe(0);
    expect(calls).toBe(r1.chunks); // extracted every chunk on the first pass
    const callsAfterFirst = calls;

    const r2 = await ingestFile(g, extractor, docPath); // re-ingest, same content
    expect(r2.reused).toBe(r2.chunks); // every chunk reused
    expect(r2.entities).toBe(0); // nothing newly created
    expect(calls).toBe(callsAfterFirst); // extractor NEVER called again — the LLM cost is skipped

    const r3 = await ingestFile(g, extractor, docPath, { reextract: true }); // force re-extraction
    expect(r3.reused).toBe(0);
    expect(calls).toBeGreaterThan(callsAfterFirst); // reextract bypasses the memo
    store.close();
  });

  it("memo does NOT freeze a chunk whose extraction failed to parse — it retries on re-ingest", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    let call = 0;
    // first call: unparseable (parse failure); subsequent calls: a valid extraction
    const chat = new StubChat(() => (++call === 1 ? "sorry, prose only, no JSON here" : JSON.stringify({ entities: [{ name: "Kilo", type: "CONCEPT", description: "k" }], relations: [] })));
    const extractor = new LlmExtractor(chat);
    const dir = mkdtempSync(join(tmpdir(), "tessera-retry-"));
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\nMentions Kilo.\n"); // one chunk

    const r1 = await ingestFile(g, extractor, docPath);
    expect(r1.parseFailures).toBeGreaterThanOrEqual(1);
    expect(store.allNodes().some((n) => n.name === "Kilo")).toBe(false); // parse failed -> nothing extracted yet

    const r2 = await ingestFile(g, extractor, docPath); // the failed chunk must RETRY, not be memoized as done
    expect(r2.reused).toBe(0); // not skipped — it never completed
    expect(store.allNodes().some((n) => n.name === "Kilo")).toBe(true); // now successfully extracted
    store.close();
  });

  it("an empty document creates a SOURCE but zero chunks (no junk empty chunk, no embed of '')", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const extractor = new LlmExtractor(new StubChat(JSON.stringify({ entities: [], relations: [] })));
    const dir = mkdtempSync(join(tmpdir(), "tessera-empty-"));
    const docPath = join(dir, "empty.md");
    writeFileSync(docPath, "   \n\n  \n"); // whitespace only
    const r = await ingestFile(g, extractor, docPath);
    expect(r.chunks).toBe(0);
    expect(store.allNodes().some((n) => n.subtype === "document")).toBe(true); // the SOURCE still exists
    expect(store.allNodes().some((n) => n.subtype === "chunk")).toBe(false); // but no junk chunk node
    store.close();
  });

  it("re-ingesting the same file under a different path spelling does not duplicate the SOURCE", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const extractor = new LlmExtractor(new StubChat(JSON.stringify({ entities: [{ name: "Kilo", type: "CONCEPT", description: "k" }], relations: [] })));
    const dir = mkdtempSync(join(tmpdir(), "tessera-path-"));
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\nMentions Kilo.\n");
    await ingestFile(g, extractor, docPath);
    const n1 = store.allNodes().length;
    await ingestFile(g, extractor, `${dir}/./doc.md`); // same file, non-canonical spelling
    expect(store.allNodes().length).toBe(n1); // resolve() canonicalized -> reinforced, not duplicated
    store.close();
  });
});

describe("parseExtraction (fail-loud + element salvage)", () => {
  it("keeps the valid rows when one entity is malformed; parsed stays true (not a parse failure)", () => {
    const raw = JSON.stringify({
      entities: [
        { name: "De Doorns", type: "PLACE", description: "a town" },
        { name: "", type: "CONCEPT", description: "nameless — invalid, must be dropped" },
      ],
      relations: [{ source: "Ghost", target: "De Doorns", reason: "dangling endpoint" }],
    });
    const { extraction, parsed } = parseExtraction(raw);
    expect(parsed).toBe(true); // valid JSON that failed on ONE row is NOT a parse failure
    expect(extraction.entities.map((e) => e.name)).toEqual(["De Doorns"]); // empty-name row salvaged out
    expect(extraction.relations.length).toBe(0); // "Ghost" endpoint never extracted -> dropped
  });

  it("relation endpoints match case-insensitively against extracted names", () => {
    const raw = JSON.stringify({
      entities: [{ name: "De Doorns", type: "PLACE", description: "a town" }, { name: "Klipgat Farm", type: "PLACE", description: "a farm" }],
      relations: [{ source: "de doorns", target: "KLIPGAT FARM", reason: "De Doorns is near Klipgat Farm" }],
    });
    expect(parseExtraction(raw).extraction.relations.length).toBe(1); // survives the case mismatch
  });

  it("unparseable reply -> parsed:false, empty extraction", () => {
    expect(parseExtraction("the model refused and just wrote prose").parsed).toBe(false);
  });

  it("finds the real payload past a decoy JSON object (chatty model)", () => {
    const raw = 'I found {"count": 2} things: {"entities":[{"name":"Klipgat Farm","type":"PLACE","description":"a farm"}],"relations":[]}';
    const { extraction, parsed } = parseExtraction(raw);
    expect(parsed).toBe(true);
    expect(extraction.entities.map((e) => e.name)).toEqual(["Klipgat Farm"]); // not the {"count":2} decoy
  });
});

describe("subject-aware extraction (KI-1/KI-2: persona linked + named, not floating)", () => {
  // The LLM's actual output is non-deterministic (a Tier-2 acceptance concern); these test the DETERMINISTIC
  // plumbing — the prompt clause and the mapping — that turn a subject-anchored extraction into a traversable edge.
  it("subjectClause is empty without a subject, and anchors relational people with one", () => {
    expect(subjectClause()).toBe("");
    expect(subjectClause("   ")).toBe("");
    const c = subjectClause("Anele Sotashe");
    expect(c).toContain("Anele Sotashe");
    expect(c).toContain("Anele Sotashe's <Relation>"); // the anchored-naming rule (KI-2)
    expect(c.toLowerCase()).toContain("both endpoints");
  });

  it("LlmExtractor injects the subject clause into the system prompt only when a subject is given", async () => {
    let seen = "";
    const chat = { complete: async (system: string) => { seen = system; return JSON.stringify({ entities: [], relations: [] }); } };
    const ex = new LlmExtractor(chat);
    await ex.extract("text", { subject: "Anele Sotashe" });
    expect(seen).toContain("SUBJECT OF THIS DOCUMENT");
    expect(seen).toContain("Anele Sotashe");
    await ex.extract("text"); // no subject → base prompt only
    expect(seen).not.toContain("SUBJECT OF THIS DOCUMENT");
  });

  it("threads the derived subject adapter→ingest→extractor, and the mapping makes the persona reachable", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const cannedEx: Extraction = {
      entities: [
        { name: "Anele Sotashe", type: "PERSON", description: "a community organizer" },
        { name: "Anele Sotashe's Father", type: "PERSON", description: "the persona's father, died at 31" },
      ],
      relations: [{ source: "Anele Sotashe's Father", target: "Anele Sotashe", reason: "is the father of" }],
    };
    // A RECORDING extractor: captures the subject it was handed (StubChat would ignore it — the tautology the
    // reviewers caught) AND returns the canned extraction so the mapping can be checked in the same test.
    let seenSubject: string | undefined = "UNSET";
    const recExtractor = { extract: async (_t: string, opts?: { subject?: string }) => { seenSubject = opts?.subject; return { extraction: cannedEx, parsed: true }; } };
    const dir = mkdtempSync(join(tmpdir(), "tessera-subj-"));
    const p = join(dir, "anele.txt");
    writeFileSync(p, "PROFILE: Anele Sotashe\n\nHis father died young.\n");

    expect(readDoc(p).subject).toBe("Anele Sotashe"); // the adapter derives it from the PROFILE header
    await ingestFile(g, recExtractor, p);
    expect(seenSubject).toBe("Anele Sotashe"); // ingest THREADED it to extract() — the previously-untested link

    const father = store.allNodes().find((n) => n.name === "Anele Sotashe's Father");
    const anele = store.allNodes().find((n) => n.name === "Anele Sotashe" && n.type === "PERSON");
    expect(!!(father && anele)).toBe(true);
    const linked = store.allEdges().some((e) => e.kind === "RELATED" &&
      ((e.from === father!.id && e.to === anele!.id) || (e.from === anele!.id && e.to === father!.id)));
    expect(linked).toBe(true); // traversable from the father — not merely co-located in a chunk
    store.close();
  });
});

describe("adapter path canonicalization", () => {
  it("readDoc returns an absolute, resolved source for a non-canonical path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-adapt-"));
    const docPath = join(dir, "d.md");
    writeFileSync(docPath, "# D\n\nbody\n");
    const doc = readDoc(`${dir}/./d.md`);
    expect(doc.source).toBe(resolve(docPath)); // canonicalized identity, not the raw spelling
  });
});

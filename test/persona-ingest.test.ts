// Persona ingest: (a) markdown parser, (b) graph mapping (node/edge counts + types +
// shared hubs), (c) RESONATES_WITH fires for near-identical personas, not for distinct ones.
// All deterministic via StubEmbedder — no network, no LLM.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import {
  parsePersona,
  ingestPersona,
  connectResonance,
  KeywordMotifExtractor,
  type PersonaDoc,
} from "../src/ingest/persona.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "personas");
const meta = { actor: "test", cause: "unit" };
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

describe("persona parser", () => {
  it("parses header fields, bio, and Q/A pairs from a real fixture", () => {
    const doc = parsePersona(read("andries_koki_0dc0ce88.txt"));
    expect(doc.name).toBe("Andries Koki");
    expect(doc.personaType).toBe("Oral Historian");
    expect(doc.age).toBe(43);
    expect(doc.country).toBe("South Africa");
    expect(doc.gender).toBe("Male");
    expect(doc.bio).toContain("Zoom H5");
    expect(doc.answers.length).toBe(22); // matches the 22 `Q:` lines in the fixture
    expect(doc.answers[0]!.q).toBe("How would your friends describe you?");
    expect(doc.answers[0]!.a).toContain("too many questions");
  });

  it("throws on a malformed doc (missing AGE)", () => {
    expect(() => parsePersona("PROFILE: X\nTYPE: Y\nCOUNTRY: Z\nGENDER: M\n\nBIO:\nhi\n\nANSWERS:\n")).toThrow();
  });

  it("parses CONSECUTIVE Q/A (no blank lines) and multi-line answers — the cohort_expand format", () => {
    // cohort_expand emits pairs back-to-back, answers spanning multiple lines/paragraphs. The old
    // blank-line split + `$`-anchored regex collapsed all of these into a SINGLE answer. Regression guard.
    const raw = [
      "PROFILE: Test Person", "TYPE: Farmer", "AGE: 40", "COUNTRY: South Africa", "GENDER: Female",
      "", "BIO:", "A short bio paragraph about a life.", "", "ANSWERS:", "",
      "Q: First question?", "A: First answer, line one.", "still part of the first answer.",
      "Q: Second question?", "A: Second answer.",
      "Q: Third question?", "A: Third answer with a", "", "paragraph break inside it.",
    ].join("\n");
    const doc = parsePersona(raw);
    expect(doc.answers.length).toBe(3); // NOT 1
    expect(doc.answers[0]!.a).toContain("still part of the first answer");
    expect(doc.answers[1]!.q).toBe("Second question?");
    expect(doc.answers[2]!.a).toContain("paragraph break inside it");
  });

  it("parses answers written WITHOUT an A: prefix (a real corpus variant)", () => {
    const raw = [
      "PROFILE: Xolani Test", "TYPE: Farmer", "AGE: 70", "COUNTRY: South Africa", "GENDER: Female",
      "", "BIO:", "A life on the land.", "", "ANSWERS:", "",
      "Q: First question?", "The answer with no A prefix, several words.", "",
      "Q: Second question?", "Another bare answer here.",
    ].join("\n");
    const doc = parsePersona(raw);
    expect(doc.answers.length).toBe(2);
    expect(doc.answers[0]!.a).toContain("no A prefix");
    expect(doc.answers[1]!.q).toBe("Second question?");
  });

  it("rejects a doc that parses to zero answers (hollow node)", () => {
    const raw = "PROFILE: X\nTYPE: Y\nAGE: 5\nCOUNTRY: Z\nGENDER: M\n\nBIO:\nhi there\n\nANSWERS:\nnothing parseable here";
    expect(() => parsePersona(raw)).toThrow(); // answers.min(1)
  });
});

describe("persona -> graph mapping", () => {
  let store: GraphStore;
  const embedder = new StubEmbedder(64);
  afterEach(() => store.close());

  it("creates one PERSON node + attribute/motif CONCEPT hubs + PERSON->concept edges", async () => {
    store = new GraphStore({ path: ":memory:", embedder });
    const doc = parsePersona(read("andries_koki_0dc0ce88.txt"));
    const res = await ingestPersona(store, embedder, doc, "andries.txt", meta, { maxMotifs: 6 });

    const person = store.getNode(res.personId)!;
    expect(person.type).toBe("PERSON");
    expect(person.origin).toBe("ingest");
    expect(person.text).toContain("Andries Koki"); // display name preserved in text
    expect(person.metadata!.name).toBe("Andries Koki");
    expect(person.metadata!.age).toBe(43);
    expect(person.metadata!.country).toBe("South Africa");

    // type + country + up to 6 motifs = 2..8 concepts; exactly one PERSON node.
    const nodes = store.allNodes();
    expect(nodes.filter((n) => n.type === "PERSON").length).toBe(1);
    const concepts = nodes.filter((n) => n.type === "CONCEPT");
    expect(concepts.length).toBe(res.conceptIds.length);
    expect(concepts.length).toBeGreaterThanOrEqual(2 + 1); // at least type+country+1 motif

    // structured attribute hubs exist with the right subtype.
    const country = concepts.find((c) => c.subtype === "country");
    expect(country!.text).toBe("South Africa");
    expect(concepts.some((c) => c.subtype === "persona_type" && c.text === "Oral Historian")).toBe(true);
    expect(concepts.some((c) => c.subtype === "motif")).toBe(true);

    // edges: PERSON->concept, one per concept, correct kinds.
    const edges = store.getEdges(res.personId);
    expect(edges.length).toBe(res.edgeCount);
    expect(edges.length).toBe(concepts.length);
    const related = edges.filter((e) => e.kind === "RELATED");
    const appeared = edges.filter((e) => e.kind === "APPEARED_IN");
    expect(related.length).toBe(2); // type + country
    expect(appeared.length).toBe(concepts.length - 2); // motifs
    // the country edge runs PERSON -> country hub.
    expect(store.getEdge(related[0]!.id)!.from).toBe(res.personId);
  });

  it("shares attribute hubs across personas (an over-connected hub = a trope signal)", async () => {
    store = new GraphStore({ path: ":memory:", embedder });
    const a = parsePersona(read("andries_koki_0dc0ce88.txt")); // South Africa
    const b = parsePersona(read("aviwe_jama_0522a9cd.txt")); // South Africa
    const ra = await ingestPersona(store, embedder, a, "a.txt", meta);
    const rb = await ingestPersona(store, embedder, b, "b.txt", meta);

    // two distinct PERSON nodes (same country, different personas — NOT collapsed).
    expect(store.allNodes().filter((n) => n.type === "PERSON").length).toBe(2);

    // "South Africa" is ONE shared hub reached by BOTH persons (degree 2).
    const country = store.allNodes().find((n) => n.subtype === "country" && n.text === "South Africa")!;
    const neighborIds = new Set(store.getNeighbors(country.id).map((n) => n.id));
    expect(neighborIds.has(ra.personId)).toBe(true);
    expect(neighborIds.has(rb.personId)).toBe(true);
    expect(store.getEdges(country.id).length).toBe(2);
  });
});

describe("RESONATES_WITH", () => {
  let store: GraphStore;
  const embedder = new StubEmbedder(64);
  afterEach(() => store.close());

  // Build a persona whose bio+answers is a controlled bag of tokens.
  const makeDoc = (name: string, words: string[]): PersonaDoc => ({
    name,
    personaType: "Tester",
    age: 30,
    country: "Testland",
    gender: "X",
    bio: words.join(" "),
    answers: [{ q: "q?", a: words.join(" ") }],
  });

  const base = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");

  it("fires for near-identical personas and not for a distinct one", async () => {
    store = new GraphStore({ path: ":memory:", embedder });
    const A = makeDoc("A", base);
    const B = makeDoc("B", [...base, "quebec", "romeo"]); // ~same tokens, cosine high but < 0.99
    const C = makeDoc("C", "zulu yankee xray whiskey victor uniform tango sierra".split(" ")); // disjoint

    const ra = await ingestPersona(store, embedder, A, "A", meta);
    const rb = await ingestPersona(store, embedder, B, "B", meta);
    const rc = await ingestPersona(store, embedder, C, "C", meta);
    expect(store.allNodes().filter((n) => n.type === "PERSON").length).toBe(3); // none collapsed

    const created = await connectResonance(store, meta, { threshold: 0.85 });
    expect(created).toBe(1);

    const res = store.allEdges().filter((e) => e.kind === "RESONATES_WITH");
    expect(res.length).toBe(1);
    const endpoints = new Set([res[0]!.from, res[0]!.to]);
    expect(endpoints).toEqual(new Set([ra.personId, rb.personId]));
    expect(endpoints.has(rc.personId)).toBe(false);
  });

  it("is idempotent — a second resonance pass adds no new edges", async () => {
    store = new GraphStore({ path: ":memory:", embedder });
    await ingestPersona(store, embedder, makeDoc("A", base), "A", meta);
    await ingestPersona(store, embedder, makeDoc("B", [...base, "quebec"]), "B", meta);
    await connectResonance(store, meta, { threshold: 0.85 });
    const n1 = store.countEdges();
    await connectResonance(store, meta, { threshold: 0.85 });
    expect(store.countEdges()).toBe(n1);
  });
});

describe("KeywordMotifExtractor", () => {
  it("is deterministic and drops stopwords/short tokens", () => {
    const ex = new KeywordMotifExtractor();
    const text = "language language language recorder recorder the the the a of to it is at";
    const out = ex.extract(text, 6);
    expect(out).toEqual(["language", "recorder"]); // count>=2, len>=4, no stopwords, count-desc
    expect(ex.extract(text, 6)).toEqual(out); // stable
  });
});

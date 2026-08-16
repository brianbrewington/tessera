// Coverage for the part of E7 that decides WHO GETS ASKED WHAT. Two independent cross-agent reviews
// (Grok 4.6 and Composer 2.5, 2026-08-16) both ranked this the biggest hole: the parser and scorer were
// tested, and `buildTrials` — which constructs the controls the whole experiment rests on — was not tested at
// all. Every case below is a defect one of them found, pinned so it cannot come back.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildTrials, type Trial } from "../scripts/dedup/e7-merge-proposals.js";

let dir: string, dbPath: string;

// A miniature corpus with one of every case the controls care about.
const ENTITIES: [id: string, name: string, subtype: string][] = [
  // ceiling: strip-identical, raw names differ
  ["e01", "contentHash", "technology"], ["e02", "content_hash", "file"],
  ["e03", "GraphStore", "technology"], ["e04", "Graph Store", "product"],
  ["e05", "Dream Walker", "technology"], ["e06", "Dream-Walker", "memory"],
  // pure type jitter — byte-identical names. NOT a ceiling pair (the AGENT/AGENT precedent).
  ["e07", "AGENT", "other"], ["e08", "AGENT", "concept"],
  // containment
  ["e09", "Extractor", "concept"], ["e10", "LlmExtractor", "technology"],
  // token
  ["e11", "getLayout", "code"], ["e12", "putLayout", "code"],
  // disjoint, structurally linked
  ["e13", "HYPOTHESIS", "concept"], ["e14", "EVIDENCE", "concept"],
  // containment near-miss that must never reach the FLOOR
  ["e15", "x", "technology"], ["e16", "vx", "technology"],
  // filler so the floor has somewhere to draw from
  ...Array.from({ length: 40 }, (_, i) => [`f${i}`, `Filler${i}`, "concept"] as [string, string, string]),
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "e7-trials-"));
  dbPath = join(dir, "graph.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, text TEXT, subtype TEXT, description TEXT);
           CREATE TABLE edges (from_id TEXT, to_id TEXT, kind TEXT);`);
  const ins = db.prepare("INSERT INTO nodes (id,name,text,subtype,description) VALUES (?,?,?,?,?)");
  for (const [id, name, subtype] of ENTITIES) ins.run(id, name, name, subtype, `description of ${name}`);
  ins.run("c1", "chunk 1", "chunk 1", "chunk", "the chunk text for context");
  db.prepare("INSERT INTO edges (from_id,to_id,kind) VALUES (?,?,?)").run("e01", "c1", "APPEARED_IN");
  db.close();

  // E6's output, hand-written so the strata are unambiguous.
  writeFileSync(
    join(dir, "e6-candidates.json"),
    JSON.stringify({
      report: {},
      candidates: [
        { a: "e09", b: "e10", stratum: "containment", chunks: 1, neighbours: 0, related: false },
        { a: "e11", b: "e12", stratum: "token", chunks: 1, neighbours: 0, related: false },
        { a: "e13", b: "e14", stratum: "disjoint", chunks: 2, neighbours: 1, related: false },
        { a: "e01", b: "e13", stratum: "disjoint", chunks: 3, neighbours: 0, related: false },
      ],
    }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const build = (counts: Partial<Record<Trial["stratum"], number>> = {}, seed = 42) =>
  buildTrials({
    dbPath, dir, seed, contextChars: 100,
    counts: { ceiling: 2, containment: 1, token: 1, disjoint: 2, floor: 4, ...counts },
  });

describe("E7 buildTrials — the controls", () => {
  it("is reproducible from the seed alone", () => {
    // The claim the sidecar makes by recording a seed. Grok's finding was that it was not true: one shared
    // RNG stream meant the floor's rejection loop, whose draw count depends on the data, shifted every
    // stratum sampled after it. Same seed must mean the same 10 trials, in the same A/B order.
    const key = (t: Trial[]) => t.map((x) => `${x.stratum}:${x.a.id}:${x.b.id}:${x.swapped}`).join("|");
    expect(key(build().trials)).toBe(key(build().trials));
  });

  it("a different seed draws a different set", () => {
    // Guards the opposite mistake: a derivation that collapses every stream to a constant would also be
    // perfectly 'reproducible'.
    const key = (t: Trial[]) => t.map((x) => `${x.a.id}:${x.b.id}:${x.swapped}`).join("|");
    expect(key(build({}, 42).trials)).not.toBe(key(build({}, 20260816).trials));
  });

  it("changing ONE stratum's request does not disturb the others", () => {
    // The point of per-stratum RNG streams. With one shared stream, asking for a different number of floor
    // pairs silently re-drew ceiling, containment, token and disjoint too — so two runs that shared a seed
    // and differed only in a pilot-vs-scored count were not nested samples, and could not be compared.
    const a = build({ floor: 4 }).trials.filter((t) => t.stratum === "ceiling");
    const b = build({ floor: 8 }).trials.filter((t) => t.stratum === "ceiling");
    expect(a.map((t) => `${t.a.id}:${t.b.id}:${t.swapped}`)).toEqual(b.map((t) => `${t.a.id}:${t.b.id}:${t.swapped}`));
  });

  it("THROWS rather than silently underfilling a stratum", () => {
    // Both reviews ranked this top. `sample()` used to return the short pool, so a stratum whose population
    // had collapsed still produced a completed-looking run. The ≥2 structural bar really did leave four
    // containment pairs on the real fixture, so this is the measured failure, not a hypothetical one.
    expect(() => build({ containment: 99 })).toThrow(/containment.*pool has 1, need 99/);
  });

  it("never puts a lexically-related pair in the FLOOR control", () => {
    // Composer and Grok both found the floor filter diverging from `stratumOf`: it rejected strip-identical
    // names and shared multi-character tokens, but not CONTAINMENT. `x`/`vx` and `id`/`to_id` are real
    // testgraph pairs that are not the same thing but are obviously lexically related, and a model naming a
    // relation for them would have been charged with inventing edges on a random pair.
    const floor = build({ floor: 12 }).trials.filter((t) => t.stratum === "floor");
    for (const t of floor) {
      const names = [t.a.name, t.b.name].sort().join("/");
      expect(names, "floor pair must be lexically disjoint").not.toBe("vx/x");
      expect(t.a.name.toLowerCase()).not.toContain(t.b.name.toLowerCase());
      expect(t.b.name.toLowerCase()).not.toContain(t.a.name.toLowerCase());
    }
  });

  it("never draws the same FLOOR pair twice", () => {
    // The floor pool was built by rejection sampling with no dedup, so one pair could occupy two trial slots
    // and the label-free false-positive control would be averaged over fewer independent pairs than it claims.
    const floor = build({ floor: 12 }).trials.filter((t) => t.stratum === "floor");
    const keys = floor.map((t) => [t.a.id, t.b.id].sort().join("/"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never draws the same FLOOR pair twice even when the pool is nearly exhausted", () => {
    // The case above passes on a roomy corpus whether or not the dedup exists — 46 entities give 1035
    // candidate pairs and the rejection sampler rarely repeats itself, so it waved the mutation through.
    // This one uses a corpus with only ten possible floor pairs and asks for six, which is where a
    // duplicate-tolerant pool actually bites. Verified against the mutation.
    const tiny = mkdtempSync(join(tmpdir(), "e7-tiny-"));
    try {
      const p = join(tiny, "graph.db");
      const db = new Database(p);
      db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, text TEXT, subtype TEXT, description TEXT);
               CREATE TABLE edges (from_id TEXT, to_id TEXT, kind TEXT);`);
      const ins = db.prepare("INSERT INTO nodes (id,name,text,subtype,description) VALUES (?,?,?,?,?)");
      for (const n of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) ins.run(n, n, n, "concept", `d ${n}`);
      db.close();
      writeFileSync(join(tiny, "e6-candidates.json"), JSON.stringify({ report: {}, candidates: [] }));

      const { trials } = buildTrials({
        dbPath: p, dir: tiny, seed: 7, contextChars: 100,
        counts: { ceiling: 0, containment: 0, token: 0, disjoint: 0, floor: 6 },
      });
      const keys = trials.map((t) => [t.a.id, t.b.id].sort().join("/"));
      expect(keys).toHaveLength(6);
      expect(new Set(keys).size).toBe(6);
    } finally {
      rmSync(tiny, { recursive: true, force: true });
    }
  });

  it("never puts a structurally-connected pair in the FLOOR control", () => {
    const floor = build({ floor: 12 }).trials.filter((t) => t.stratum === "floor");
    const signalled = new Set(["e09/e10", "e11/e12", "e13/e14", "e01/e13"]);
    for (const t of floor) expect(signalled.has([t.a.id, t.b.id].sort().join("/"))).toBe(false);
  });

  it("excludes pure type jitter from the CEILING", () => {
    // AGENT (other) vs AGENT (concept) is the recorded case where Brian judged byte-identical names NOT the
    // same thing. Putting it in a control that asserts "any usable model calls these same" would bake a known
    // wrong answer into the bar every model is measured against.
    const ceiling = build({ ceiling: 3 }).trials.filter((t) => t.stratum === "ceiling");
    for (const t of ceiling) expect(t.a.name).not.toBe(t.b.name);
  });

  it("carries the originating chunk text through as source context", () => {
    const all = build({ ceiling: 3 }).trials;
    const withCtx = all.flatMap((t) => [t.a, t.b]).filter((s) => s.id === "e01");
    expect(withCtx.length).toBeGreaterThan(0);
    for (const s of withCtx) expect(s.context).toBe("the chunk text for context");
  });

  it("randomises A/B position so the bias control has something to measure", () => {
    const trials = build({ ceiling: 3, floor: 12, disjoint: 2 }).trials;
    const swapped = trials.filter((t) => t.swapped).length;
    expect(swapped).toBeGreaterThan(0);
    expect(swapped).toBeLessThan(trials.length);
  });
});

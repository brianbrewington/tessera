// Corpus ingest (slice 2): directory intake + the in-db ingest manifest (file-level skip / partial-retry).
// Deterministic — StubEmbedder + StubChat, no network. The CLI run-summary/exit-code is integration; here we
// test the reusable core (collectDocs walk + ingestFile's manifest gating).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { StubChat } from "../src/llm.js";
import { LlmExtractor } from "../src/extract/extractor.js";
import { ingestFile } from "../src/ingest/ingest.js";
import { collectDocs } from "../src/ingest/adapters.js";
import { Graph } from "../src/graph.js";

const emb = new StubEmbedder(64);

function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-corpus-"));
  writeFileSync(join(dir, "b.md"), "# B\n\nbee.\n");
  writeFileSync(join(dir, "a.txt"), "aardvark.\n");
  writeFileSync(join(dir, "image.png"), "not text");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.md"), "# C\n\ncee.\n");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "config.md"), "# should be skipped\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.md"), "# also skipped\n");
  return dir;
}

describe("collectDocs — corpus walk", () => {
  it("finds supported files recursively, sorted; skips unsupported, .git, node_modules", () => {
    const dir = corpus();
    const got = collectDocs([dir]).map((p) => p.replace(dir + "/", ""));
    expect(got).toEqual(["a.txt", "b.md", "sub/c.md"]); // sorted; .png / .git / node_modules excluded
  });

  it("--no-recursive stays out of subdirectories", () => {
    const dir = corpus();
    const got = collectDocs([dir], { recursive: false }).map((p) => p.replace(dir + "/", ""));
    expect(got).toEqual(["a.txt", "b.md"]); // sub/c.md not descended into
  });

  it("dedups a file reached two ways and follows symlinks without cycling", () => {
    const dir = corpus();
    try { symlinkSync(dir, join(dir, "sub", "loop"), "dir"); } catch { /* platforms w/o symlink perms: skip */ }
    const got = collectDocs([dir, join(dir, "a.txt")]); // a.txt named twice (dir + explicit)
    expect(got.filter((p) => p.endsWith("a.txt")).length).toBe(1); // deduped, and the symlink loop terminated
  });

  it("returns [] when nothing supported is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-empty-"));
    writeFileSync(join(dir, "x.png"), "binary");
    expect(collectDocs([dir])).toEqual([]);
  });
});

describe("ingestFile — the file-level manifest skip", () => {
  const canned = JSON.stringify({ entities: [{ name: "Kilo", type: "CONCEPT", description: "k" }], relations: [] });
  const mkDoc = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-manifest-"));
    const p = join(dir, "doc.md");
    writeFileSync(p, "# Doc\n\nMentions Kilo.\n");
    return p;
  };

  it("records a complete manifest row, then skips an unchanged re-ingest with zero writes", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    let calls = 0;
    const extractor = new LlmExtractor(new StubChat(() => { calls++; return canned; }));
    const p = mkDoc();

    const r1 = await ingestFile(g, extractor, p);
    expect(r1.skipped).toBe(false);
    const callsAfter1 = calls, nodes1 = store.allNodes().length;

    const r2 = await ingestFile(g, extractor, p); // unchanged content
    expect(r2.skipped).toBe(true);
    expect(calls).toBe(callsAfter1); // extractor NOT called again (file-level skip, before the chunk loop)
    expect(store.allNodes().length).toBe(nodes1); // zero new writes
    store.close();
  });

  it("--reextract bypasses the skip and re-runs", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    let calls = 0;
    const extractor = new LlmExtractor(new StubChat(() => { calls++; return canned; }));
    const p = mkDoc();
    await ingestFile(g, extractor, p);
    const after1 = calls;
    const r = await ingestFile(g, extractor, p, { reextract: true });
    expect(r.skipped).toBe(false);
    expect(calls).toBeGreaterThan(after1); // re-extracted
    store.close();
  });

  it("a parse-failure records 'partial' and a re-ingest is NOT frozen (re-enters — the F1 fix)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    let calls = 0;
    const extractor = new LlmExtractor(new StubChat(() => { calls++; return "not json at all"; })); // every chunk fails to parse
    const p = mkDoc();

    const r1 = await ingestFile(g, extractor, p);
    expect(r1.parseFailures).toBeGreaterThan(0);
    expect(r1.skipped).toBe(false);
    const after1 = calls;

    // Must NOT skip. The manifest row now says 'complete' (chunks are written), so what re-enters is the
    // per-chunk dirty state: an unparsed chunk has no extracted_chunks row and is still owed.
    const r2 = await ingestFile(g, extractor, p);
    expect(r2.skipped).toBe(false);
    expect(calls).toBeGreaterThan(after1); // the failed chunk retried
    store.close();
  });

  it("on partial re-ingest the GOOD chunk is a memo hit and only the failed chunk retries (C2 coverage)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const good = JSON.stringify({ entities: [{ name: "Zulu", type: "CONCEPT", description: "z" }], relations: [] });
    let calls = 0;
    // Only the very first extraction call parses; every later call in this store returns garbage. So chunk 1
    // completes+memoizes and the rest fail; on re-ingest chunk 1 is a memo hit (no call) and the failed
    // chunks retry — the file-level skip does not shadow this, because extraction is gated per chunk now.
    const extractor = new LlmExtractor(new StubChat(() => { calls++; return calls === 1 ? good : "not json"; }));
    const dir = mkdtempSync(join(tmpdir(), "tessera-memohit-"));
    const p = join(dir, "doc.md");
    const block = (w: string): string => `${w} `.repeat(400).trim(); // ~2k chars → forces a multi-chunk split
    writeFileSync(p, `# Doc\n\n${block("alpha")}\n\n${block("omega")}\n`);

    const r1 = await ingestFile(g, extractor, p);
    expect(r1.chunks).toBeGreaterThanOrEqual(2); // precondition: the doc split (else the test is moot)
    expect(r1.parseFailures).toBeGreaterThanOrEqual(1);
    const after1 = calls;

    const r2 = await ingestFile(g, extractor, p);
    expect(r2.skipped).toBe(false); // 'partial' → re-enters
    expect(r2.reused).toBe(1); // exactly the one good chunk was memoized and reused
    expect(calls - after1).toBe(r1.chunks - 1); // every NON-memoized chunk retried, and only those
    store.close();
  });

  it("a CHANGED file is never stale-skipped: new content hash = new source; old source remains (append-only)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: emb });
    const g = Graph.attach(store, emb);
    const extractor = new LlmExtractor(new StubChat(JSON.stringify({ entities: [{ name: "Q", type: "CONCEPT", description: "q" }], relations: [] })));
    const dir = mkdtempSync(join(tmpdir(), "tessera-changed-"));
    const p = join(dir, "doc.md");
    writeFileSync(p, "# V1\n\nfirst version mentioning Q.\n");
    expect((await ingestFile(g, extractor, p)).skipped).toBe(false);
    writeFileSync(p, "# V2\n\nSECOND, materially different version, still about Q.\n"); // edit in place
    const r2 = await ingestFile(g, extractor, p);
    expect(r2.skipped).toBe(false); // changed content = new hash → re-ingested, the core manifest property
    expect(store.allNodes().filter((n) => n.subtype === "document").length).toBe(2); // old + new coexist (v1 additive)
    store.close();
  });
});

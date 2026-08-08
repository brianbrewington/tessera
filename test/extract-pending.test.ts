// The ingest split: ingestChunks writes chunks with no LLM, extractPending finishes them later.
//
// The behaviour that matters most here is the one that motivated the split: a chunk whose SOURCE FILE IS
// GONE must still be extractable, because on graphs/big two chunks are in exactly that state and the
// documented cure (re-run ingest, which reads the file) cannot reach them.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { Graph } from "../src/graph.js";
import { StubEmbedder } from "../src/embedder.js";
import { StubChat } from "../src/llm.js";
import { LlmExtractor, PROMPT_VERSION, type Extractor, type ExtractResult } from "../src/extract/extractor.js";
import { ingestChunks, ingestFile } from "../src/ingest/ingest.js";
import { extractPending, FAILING_ATTEMPTS } from "../src/ingest/extract-pending.js";

const emb = new StubEmbedder(768);
const ok = (name: string): string =>
  JSON.stringify({ entities: [{ name, type: "CONCEPT", description: `${name} desc` }], relations: [] });

function fresh(): { store: GraphStore; g: Graph } {
  const store = new GraphStore({ path: ":memory:", embedder: emb });
  return { store, g: Graph.attach(store, emb) };
}
/** Reaching into the private handle, per the convention in layout-store.test.ts: these assertions are ABOUT
 *  raw rows (claims, mutation_log ops), and routing them through a public accessor would widen the store's
 *  writable surface purely for tests. */
function raw(s: GraphStore): { prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } } {
  // @ts-expect-error — deliberate private access, see above
  return s.db;
}
function mkDoc(body = "# Doc\n\nA passage mentioning Alpha.\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-split-"));
  const p = join(dir, "doc.md");
  writeFileSync(p, body);
  return p;
}
/** An extractor that counts calls and records the subject it was handed. */
function recorder(reply: () => string): Extractor & { calls: number; subjects: (string | undefined)[] } {
  const inner = new LlmExtractor(new StubChat(reply));
  return {
    calls: 0,
    subjects: [],
    async extract(text: string, opts: { subject?: string } = {}): Promise<ExtractResult> {
      this.calls++;
      this.subjects.push(opts.subject);
      return inner.extract(text, opts);
    },
  };
}

describe("ingestChunks — the fast half", () => {
  it("writes chunks and calls the extractor ZERO times", async () => {
    const { store, g } = fresh();
    const ex = recorder(() => ok("Alpha"));
    const r = await ingestChunks(g, mkDoc());
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.queued).toBe(r.chunks); // everything is owed
    expect(ex.calls).toBe(0); // the point: no LLM in this path at all
    expect(store.allNodes().filter((n) => n.subtype === "chunk").length).toBe(r.chunks);
    store.close();
  });

  it("leaves every chunk dirty, and dirtyCounts agrees with dirtyChunks", async () => {
    const { store, g } = fresh();
    const r = await ingestChunks(g, mkDoc());
    expect(store.dirtyChunks(PROMPT_VERSION).length).toBe(r.chunks);
    const c = store.dirtyCounts(PROMPT_VERSION);
    expect(c).toMatchObject({ chunks: r.chunks, dirty: r.chunks, never: r.chunks, stale: 0, failing: 0 });
    store.close();
  });

  it("persists the document subject on the SOURCE node so extraction stays subject-aware later", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc("PROFILE: Thandi Mokoena\n\nShe farms near De Doorns.\n"));
    const src = store.allNodes().find((n) => n.subtype === "document");
    expect(src?.provenance?.subject).toBe("Thandi Mokoena");
    store.close();
  });
});

describe("extractPending — the slow half", () => {
  it("extracts what ingestChunks queued, and a second run costs nothing", async () => {
    const { store, g } = fresh();
    const ex = recorder(() => ok("Alpha"));
    await ingestChunks(g, mkDoc());

    const d1 = await extractPending(g, ex);
    expect(d1.extracted).toBeGreaterThan(0);
    expect(store.allNodes().some((n) => n.name === "Alpha")).toBe(true);
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(0);

    const callsAfterFirst = ex.calls;
    const d2 = await extractPending(g, ex);
    expect(d2.considered).toBe(0);
    expect(ex.calls).toBe(callsAfterFirst); // zero LLM calls — the memo is doing its job
    store.close();
  });

  it("HEALS A CHUNK WHOSE SOURCE FILE IS GONE — the reason this split exists", async () => {
    const { store, g } = fresh();
    const p = mkDoc("PROFILE: Lindiwe Khumalo\n\nShe remembers the harvest at Klipgat Farm.\n");
    await ingestChunks(g, p);
    // Delete the source directory, reproducing graphs/big's two orphaned chunks: their scratchpad path no
    // longer resolves, so anything that re-reads the file can never finish them.
    rmSync(join(p, ".."), { recursive: true, force: true });

    const ex = recorder(() => ok("Klipgat Farm"));
    const d = await extractPending(g, ex);

    expect(d.extracted).toBeGreaterThan(0);
    expect(store.allNodes().some((n) => n.name === "Klipgat Farm")).toBe(true);
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(0);
    // And it stayed subject-aware without the file.
    expect(ex.subjects[0]).toBe("Lindiwe Khumalo");
    store.close();
  });

  it("recovers the subject from chunk zero when the SOURCE predates subject persistence", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc("PROFILE: Boitumelo Sebola\n\nHe drove the bakkie to market.\n"));
    // Simulate an older graph: strip the persisted subject, leaving only the PROFILE: header in chunk zero.
    const src = store.allNodes().find((n) => n.subtype === "document")!;
    raw(store).prepare("UPDATE nodes SET provenance = ? WHERE id = ?")
      .run(JSON.stringify({ path: "/gone/doc.md" }), src.id);

    const ex = recorder(() => ok("Bakkie"));
    await extractPending(g, ex);
    expect(ex.subjects[0]).toBe("Boitumelo Sebola");
    store.close();
  });
});

describe("failure is visible, not silent", () => {
  it("an unparseable reply stays dirty and records an attempt with a reason", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const ex = recorder(() => "prose, no JSON");

    const d = await extractPending(g, ex);
    expect(d.parseFailures).toBeGreaterThan(0);
    expect(d.extracted).toBe(0);

    const dirty = store.dirtyChunks(PROMPT_VERSION);
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty[0]!.attempts).toBe(1);
    expect(dirty[0]!.lastError).toMatch(/not parseable/i);
    store.close();
  });

  it("attempts accumulate, and a background drain stops retrying a poison chunk", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const ex = recorder(() => "still not JSON");

    for (let i = 0; i < FAILING_ATTEMPTS; i++) await extractPending(g, ex);
    expect(store.dirtyChunks(PROMPT_VERSION)[0]!.attempts).toBe(FAILING_ATTEMPTS);
    expect(store.dirtyCounts(PROMPT_VERSION).failing).toBeGreaterThan(0);

    // A drain that respects the poison guard now declines to burn the GPU on it.
    const callsBefore = ex.calls;
    const drained = await extractPending(g, ex, { maxAttempts: FAILING_ATTEMPTS });
    expect(drained.considered).toBe(0);
    expect(ex.calls).toBe(callsBefore);

    // ...but an explicit retry still can, and succeeds once the model behaves.
    store.clearExtractionFailures();
    const good = recorder(() => ok("Recovered"));
    const after = await extractPending(g, good, { maxAttempts: FAILING_ATTEMPTS });
    expect(after.extracted).toBeGreaterThan(0);
    expect(store.allNodes().some((n) => n.name === "Recovered")).toBe(true);
    store.close();
  });

  it("a transport throw is caught per chunk, so earlier paid-for chunks survive", async () => {
    const { store, g } = fresh();
    const chunked = await ingestChunks(g, mkDoc(`# Doc\n\n${"alpha ".repeat(400)}\n\n${"omega ".repeat(400)}\n`));
    expect(chunked.chunks).toBeGreaterThanOrEqual(2); // precondition, else the test proves nothing
    let n = 0;
    const flaky: Extractor = {
      async extract(): Promise<ExtractResult> {
        n++;
        if (n === 2) throw new Error("ECONNRESET talking to Ollama");
        return new LlmExtractor(new StubChat(ok("Survivor"))).extract("x");
      },
    };
    const d = await extractPending(g, flaky);
    expect(d.extracted).toBe(chunked.chunks - 1); // every chunk but the flaky one was kept
    expect(d.errors).toBe(1); // the throw was recorded, not fatal to the run
    expect(store.allNodes().some((n2) => n2.name === "Survivor")).toBe(true);
    const stillDirty = store.dirtyChunks(PROMPT_VERSION);
    expect(stillDirty.length).toBe(1);
    expect(stillDirty[0]!.lastError).toMatch(/ECONNRESET/);
    store.close();
  });
});

describe("the claim keeps two extractors off one chunk", () => {
  it("a second claimant is refused while a claim is live, and allowed once it expires", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const id = store.dirtyChunks(PROMPT_VERSION)[0]!.id;
    const t0 = 1_000_000;

    expect(store.claimChunk(id, "worker-a", t0, 1000)).toBe(true);
    expect(store.claimChunk(id, "worker-b", t0 + 500, 1000)).toBe(false); // still live
    expect(store.claimChunk(id, "worker-b", t0 + 2000, 1000)).toBe(true); // expired, reclaimable
    store.close();
  });

  it("extractPending skips a chunk another worker holds", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const id = store.dirtyChunks(PROMPT_VERSION)[0]!.id;
    store.claimChunk(id, "other-worker", 1_000_000, 60_000);

    const ex = recorder(() => ok("Alpha"));
    const d = await extractPending(g, ex, { now: () => 1_000_100 });
    expect(d.skippedClaimed).toBe(1);
    expect(d.attempted).toBe(0);
    expect(ex.calls).toBe(0);
    store.close();
  });

  // Found by a cross-agent review (Codex). The claim prevents two workers running the SAME chunk at the same
  // MOMENT, but the dirty list is snapshotted up front — so a chunk another worker finished after the
  // snapshot has its claim cleared by markExtracted, and this run would happily claim it and re-pay for it.
  // Check-then-act again, one layer up: the snapshot is the check, the claim is the act.
  it("does not re-extract a chunk another worker completed after the snapshot", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc(`# Doc\n\n${"alpha ".repeat(400)}\n\n${"omega ".repeat(400)}\n`));
    const ids = store.dirtyChunks(PROMPT_VERSION).map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    let calls = 0;
    const ex: Extractor = {
      async extract(): Promise<ExtractResult> {
        calls++;
        // On the first call, simulate a concurrent worker finishing the LAST chunk of this same snapshot.
        if (calls === 1) store.markExtracted(ids[ids.length - 1]!, PROMPT_VERSION, { actor: "other", cause: "other worker" });
        return new LlmExtractor(new StubChat(ok("Alpha"))).extract("x");
      },
    };
    const d = await extractPending(g, ex);
    expect(calls).toBe(ids.length - 1); // the chunk the other worker finished was NOT paid for twice
    expect(d.extracted).toBe(ids.length - 1);
    store.close();
  });

  it("force re-extraction does not steal a chunk another worker is actively running", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const id = store.dirtyChunks(PROMPT_VERSION)[0]!.id;
    store.claimChunk(id, "worker-a", 1_000_000, 60_000);

    const ex = recorder(() => ok("Alpha"));
    const d = await extractPending(g, ex, { force: true, now: () => 1_000_100 });

    expect(d.skippedClaimed).toBe(1);
    expect(ex.calls).toBe(0); // --reextract bypasses the CLEAN filter, not another worker's live claim
    const row = raw(store).prepare("SELECT claimed_by FROM chunk_extraction_state WHERE chunk_id = ?").get(id) as
      { claimed_by: string | null };
    expect(row.claimed_by).toBe("worker-a"); // and it did not clear someone else's claim on the way past
    store.close();
  });

  it("a successful extraction clears the claim and the attempt count", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const ex = recorder(() => ok("Alpha"));
    await extractPending(g, ex);
    const row = raw(store).prepare("SELECT claimed_by, claimed_at, attempts FROM chunk_extraction_state").get() as
      { claimed_by: string | null; claimed_at: number | null; attempts: number };
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.attempts).toBe(0);
    store.close();
  });
});

describe("reported counts mean what they say", () => {
  it("'reused' counts chunks already extracted, not chunks merely deferred by a claim", async () => {
    const { store, g } = fresh();
    const p = mkDoc(`# Doc\n\n${"alpha ".repeat(400)}\n\n${"omega ".repeat(400)}\n`);
    await ingestChunks(g, p);
    const ids = store.dirtyChunks(PROMPT_VERSION).map((c) => c.id);
    store.claimChunk(ids[ids.length - 1]!, "worker-a", Date.now(), 60_000); // held, not finished

    const r = await ingestFile(g, recorder(() => ok("Alpha")), p);
    // Nothing had been extracted before this run, so nothing was reused. The held chunk was postponed.
    expect(r.reused).toBe(0);
    store.close();
  });
});

describe("PROMPT_VERSION re-dirties an existing graph", () => {
  it("a version bump makes clean chunks dirty again, and extract heals them", async () => {
    const { store, g } = fresh();
    const ex = recorder(() => ok("Alpha"));
    await ingestFile(g, ex, mkDoc());
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(0);

    const next = `${PROMPT_VERSION}-next`;
    const counts = store.dirtyCounts(next);
    expect(counts.dirty).toBeGreaterThan(0);
    expect(counts.stale).toBe(counts.dirty); // stale, not never-extracted — the distinction serve relies on
    expect(counts.never).toBe(0);

    // A background drain must NOT re-pay for a whole corpus just because the prompt changed.
    const callsBefore = ex.calls;
    const drain = await extractPending(g, ex, { promptVersion: next, includeStale: false });
    expect(drain.considered).toBe(0);
    expect(ex.calls).toBe(callsBefore);

    // An explicit run does.
    const explicit = await extractPending(g, ex, { promptVersion: next });
    expect(explicit.extracted).toBeGreaterThan(0);
    expect(store.dirtyCounts(next).dirty).toBe(0);
    store.close();
  });
});

describe("the memo and the manifest are replayable (B23)", () => {
  it("markExtracted and recordIngestedSource both append to mutation_log", async () => {
    const { store, g } = fresh();
    await ingestFile(g, recorder(() => ok("Alpha")), mkDoc());
    const ops = (raw(store).prepare("SELECT op FROM mutation_log").all() as Array<{ op: string }>).map((r) => r.op);
    expect(ops).toContain("markExtracted");
    expect(ops).toContain("recordIngestedSource");
    store.close();
  });
});

describe("a chunk with more than one parent is still ONE unit of work", () => {
  // Found independently by two cross-agent reviewers, on two different features. The dirty-chunk query
  // LEFT JOINs edges on ORIGINATED_FROM with no dedup, so a node with N such edges comes back N times.
  // Latent today because ingest writes exactly one. Both queued features break it: an image manifested
  // once and referenced by 40 documents, and a conversation turn belonging to a session.
  //
  // DISTINCT would not save it — src.id/src.name/src.provenance are in the select list and differ per row.
  async function chunkWithTwoParents(store: GraphStore, g: Graph): Promise<string> {
    const meta = { actor: "test", cause: "multi-parent" };
    const vec = await g.embedder.embed("x");
    const a = await store.putNode({ type: "SOURCE", subtype: "document", origin: "ingest", text: "source\tA", name: "Doc A", description: "A" }, meta, vec);
    const b = await store.putNode({ type: "SOURCE", subtype: "document", origin: "ingest", text: "source\tB", name: "Doc B", description: "B" }, meta, vec);
    const c = await store.putNode({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\tshared", name: "shared chunk", description: "a body that two documents both contain" }, meta, vec);
    await store.putEdge({ from: c.id, to: a.id, kind: "ORIGINATED_FROM", reason: "in A", origin: "ingest" }, meta);
    await store.putEdge({ from: c.id, to: b.id, kind: "ORIGINATED_FROM", reason: "in B", origin: "ingest" }, meta);
    return c.id;
  }

  it("dirtyChunks returns it exactly once, with a deterministic parent", async () => {
    const { store, g } = fresh();
    const id = await chunkWithTwoParents(store, g);
    const rows = store.dirtyChunks(PROMPT_VERSION).filter((r) => r.id === id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceId).toBeTruthy();
    // Deterministic across calls, so progress reporting and subject recovery do not flip run to run.
    const again = store.dirtyChunks(PROMPT_VERSION).filter((r) => r.id === id);
    expect(again[0]!.sourceId).toBe(rows[0]!.sourceId);
    store.close();
  });

  it("is extracted once, and the run's counts do not double", async () => {
    const { store, g } = fresh();
    await chunkWithTwoParents(store, g);
    const ex = recorder(() => ok("Shared"));
    const d = await extractPending(g, ex);
    expect(d.considered).toBe(1);
    expect(ex.calls).toBe(1); // paid for once
    expect(d.attempted).toBe(1);
    expect(d.skippedClaimed).toBe(0); // the duplicate used to fail its own claim and be counted here
    store.close();
  });

  it("ingestFile's `reused` cannot go negative", async () => {
    // reused = chunks - attempted - skippedClaimed. Duplicate rows inflate the subtrahends past `chunks`.
    const { store, g } = fresh();
    await chunkWithTwoParents(store, g);
    const p = mkDoc();
    const r = await ingestFile(g, recorder(() => ok("Alpha")), p);
    expect(r.reused).toBeGreaterThanOrEqual(0);
    store.close();
  });
});

describe("extraction products can be marked with where they came from", () => {
  // The reviewer of the SESSION design flagged this CRITICAL, and the severity is about what CANNOT be
  // undone: mapExtraction hardcoded origin "ingest", there is no delete for nodes or edges anywhere in
  // this repo, and nothing filtered on origin for any purpose. So the first self-directed run (a dream,
  // a walk) would have written products permanently indistinguishable from ingested fact, into a graph
  // with no way to separate or remove them.
  it("defaults to ingest, so nothing about the ordinary path changes", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    await extractPending(g, recorder(() => ok("Alpha")));
    const alpha = store.allNodes().find((n) => n.name === "Alpha")!;
    expect(alpha.origin).toBe("ingest");
    store.close();
  });

  it("marks nodes AND edges with a caller-supplied origin", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const twoEntities = JSON.stringify({
      entities: [
        { name: "Seed", type: "CONCEPT", description: "one end" },
        { name: "Echo", type: "CONCEPT", description: "the other" },
      ],
      relations: [{ source: "Seed", target: "Echo", reason: "surfaced together in a wandering pass" }],
    });
    await extractPending(g, recorder(() => twoEntities), { origin: "dream" });

    const seed = store.allNodes().find((n) => n.name === "Seed")!;
    expect(seed.origin).toBe("dream");
    // Edges too: marking only the nodes would leave the assertions unattributable, and the assertions are
    // what a later reader would actually trust.
    const related = store.allEdges().filter((e) => e.kind === "RELATED");
    expect(related.length).toBeGreaterThan(0);
    // APPEARED_IN provenance edges are part of the same write and must carry it as well.
    const appeared = store.allEdges().filter((e) => e.kind === "APPEARED_IN");
    expect(appeared.length).toBeGreaterThan(0);
    store.close();
  });

  it("report counts products by origin, so marked work is visible and not merely marked", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    await extractPending(g, recorder(() => ok("Alpha")), { origin: "dream" });
    const byOrigin = store.countNodesByOrigin();
    expect(byOrigin.dream).toBeGreaterThan(0);
    expect(byOrigin.ingest).toBeGreaterThan(0); // the SOURCE and CHUNK nodes ingest wrote
    store.close();
  });
});

describe("media is MANIFESTED, not ingested", () => {
  // The adversarial reviewer's verdict on recursive image ingest: preserve the images, do not caption them.
  // Captions are the most generic text this pipeline would ever feed itself, and KI-3 (too many too-generic
  // entities) is the open headline defect. So: bytes durable, traceable to every parent, and nothing enters
  // the entity graph. It also measures the corpus before anyone decides about a vision model.
  const png = (kb: number): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(kb * 1024, 3)]);
  function docWithImage(body: string, files: Record<string, Buffer>): string {
    const dir = mkdtempSync(join(tmpdir(), "tessera-media-"));
    for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
    const p = join(dir, "doc.md");
    writeFileSync(p, body);
    return p;
  }

  it("stores the bytes and links the image to its document", async () => {
    const { store, g } = fresh();
    const r = await ingestChunks(g, docWithImage("# Doc\n\n![field](field.png)\n", { "field.png": png(8) }));
    expect(r.media).toBe(1);
    const node = store.allNodes().find((n) => n.subtype === "media")!;
    expect(node.name).toBe("field.png");
    const counts = store.mediaCounts();
    expect(counts).toMatchObject({ blobs: 1, nodes: 1 });
    expect(counts.bytes).toBe(8 * 1024 + 4);
    store.close();
  });

  it("NEVER becomes work: a manifested image is not a dirty chunk and costs no LLM call", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, docWithImage("# Doc\n\ntext ![a](a.png) more\n", { "a.png": png(8) }));
    const dirty = store.dirtyChunks(PROMPT_VERSION);
    expect(dirty.some((c) => c.name === "a.png")).toBe(false);

    const ex = recorder(() => ok("Alpha"));
    await extractPending(g, ex);
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(0);
    // The image contributed no entity, which is the entire point of manifesting rather than captioning.
    expect(store.allNodes().some((n) => n.name === "a.png" && n.subtype !== "media")).toBe(false);
    store.close();
  });

  it("the SAME image in two documents is ONE node with two parents", async () => {
    // The logo case. Byte-addressed identity makes this a merge rather than 40 near-duplicates, and it is
    // exactly the multi-parent shape that used to return duplicate rows from dirtyChunks.
    const { store, g } = fresh();
    const bytes = png(8);
    await ingestChunks(g, docWithImage("# One\n\n![logo](logo.png)\n", { "logo.png": bytes }));
    await ingestChunks(g, docWithImage("# Two\n\n![logo](logo.png)\n", { "logo.png": bytes }));

    const media = store.allNodes().filter((n) => n.subtype === "media");
    expect(media.length).toBe(1);
    expect(store.mediaCounts().blobs).toBe(1); // stored once, not twice
    const parents = store.allEdges().filter((e) => e.from === media[0]!.id && e.kind === "ORIGINATED_FROM");
    expect(parents.length).toBe(2); // honest provenance: this image appears in both
    store.close();
  });

  it("reports what it refused, so nothing is lost quietly", async () => {
    const { g } = fresh();
    const r = await ingestChunks(g, docWithImage(
      "![tiny](t.png)\n\n![remote](https://example.com/x.png)\n",
      { "t.png": png(0) },
    ));
    expect(r.media).toBe(0);
    expect(r.skippedParts.map((s) => s.reason).sort()).toEqual(["not a local file", "under 2048 bytes"]);
  });
});

describe("the two skip reasons are not the same thing", () => {
  // Brian read "1 chunk(s) claimed by another extractor" on a single-user run and reasonably took it as
  // concurrency. Two different states were being counted together: somebody HOLDS it (usually an
  // interrupted run of your own), versus somebody FINISHED it between the snapshot and the claim.
  it("a chunk finished by another run counts as done, not as contended", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc(`# Doc\n\n${"alpha ".repeat(400)}\n\n${"omega ".repeat(400)}\n`));
    const ids = store.dirtyChunks(PROMPT_VERSION).map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    let calls = 0;
    const ex: Extractor = {
      async extract(): Promise<ExtractResult> {
        calls++;
        if (calls === 1) store.markExtracted(ids[ids.length - 1]!, PROMPT_VERSION, { actor: "other", cause: "other run" });
        return new LlmExtractor(new StubChat(ok("Alpha"))).extract("x");
      },
    };
    const d = await extractPending(g, ex);
    expect(d.skippedDone).toBe(1);
    expect(d.skippedClaimed).toBe(0); // nobody was holding it; it was simply already done
  });

  it("a chunk somebody is holding counts as contended, not as done", async () => {
    const { store, g } = fresh();
    await ingestChunks(g, mkDoc());
    const id = store.dirtyChunks(PROMPT_VERSION)[0]!.id;
    store.claimChunk(id, "worker-a", 1_000_000, 60_000);
    const d = await extractPending(g, recorder(() => ok("Alpha")), { now: () => 1_000_100 });
    expect(d.skippedClaimed).toBe(1);
    expect(d.skippedDone).toBe(0);
  });
});

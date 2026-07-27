// Slice 3: set-valued assertion provenance (FD3) + the PERSON-merge audit in the scorecard. Deterministic.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { report } from "../scripts/ingest-report.js";

const meta = { actor: "test", cause: "unit" };

describe("assertion provenance (set-valued)", () => {
  it("records the grounding node, and ACCUMULATES across chunks even when the reason repeats", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    const mk = async (t: string): Promise<string> => (await store.putNode({ type: "CONCEPT", origin: "user", text: t, name: t }, meta)).id;
    const a = await mk("A"), b = await mk("B"), cA = await mk("chunkA"), cB = await mk("chunkB");

    // Same relationship asserted from two different chunks (same reason → one assertion, dedup path).
    const e1 = await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "co-founded the same lab", origin: "ingest" }, meta, undefined, cA);
    const e2 = await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "co-founded the same lab", origin: "ingest" }, meta, undefined, cB);
    expect(e2.assertionId).toBe(e1.assertionId); // same reason → one assertion...
    expect(store.assertionSources(e1.assertionId)).toEqual([cA, cB].sort()); // ...grounded by BOTH chunks (accumulated)

    // A different reason is a distinct assertion with its own grounding.
    const e3 = await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "attended the same college", origin: "ingest" }, meta, undefined, cA);
    expect(e3.assertionId).not.toBe(e1.assertionId);
    expect(store.assertionSources(e3.assertionId)).toEqual([cA]);
    store.close();
  });

  it("records nothing when no grounding is passed (a non-ingest caller may omit it)", async () => {
    const store = new GraphStore({ path: ":memory:", embedder: new StubEmbedder(64) });
    const mk = async (t: string): Promise<string> => (await store.putNode({ type: "CONCEPT", origin: "user", text: t, name: t }, meta)).id;
    const a = await mk("A"), b = await mk("B");
    const e = await store.putEdge({ from: a, to: b, kind: "RELATED", reason: "some link", origin: "connector" }, meta); // no grounding
    expect(store.assertionSources(e.assertionId)).toEqual([]);
    store.close();
  });
});

describe("PERSON-merge audit (scorecard)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("flags a PERSON whose chunks trace to >1 source doc, and leaves a single-source person alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "tessera-audit-"));
    const dbPath = join(dir, "g.db");
    const store = new GraphStore({ path: dbPath, embedder: new StubEmbedder(768) });
    const put = async (o: object): Promise<string> => (await store.putNode(o as any, meta)).id;
    // Two source docs, each with a chunk. "Thandi Nkosi" appears in BOTH (a merge); "Solo" only in docA.
    const docA = await put({ type: "SOURCE", subtype: "document", origin: "ingest", text: "source\thashA", name: "A" });
    const docB = await put({ type: "SOURCE", subtype: "document", origin: "ingest", text: "source\thashB", name: "B" });
    const cA = await put({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\thashA\t1", name: "cA", description: "x" });
    const cB = await put({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\thashB\t1", name: "cB", description: "y" });
    const thandi = await put({ type: "PERSON", origin: "ingest", text: "person\tthandi nkosi", name: "Thandi Nkosi" });
    const solo = await put({ type: "PERSON", origin: "ingest", text: "person\tsolo", name: "Solo" });
    const link = async (from: string, to: string, kind: any): Promise<void> => { await store.putEdge({ from, to, kind, reason: "r", origin: "ingest" }, meta); };
    await link(cA, docA, "ORIGINATED_FROM");
    await link(cB, docB, "ORIGINATED_FROM");
    await link(thandi, cA, "APPEARED_IN"); // Thandi in docA...
    await link(thandi, cB, "APPEARED_IN"); // ...and docB → spans 2 sources
    await link(solo, cA, "APPEARED_IN"); // Solo in docA only
    store.close();

    const sc = report(dbPath);
    expect(sc.mergedPersons.map((m) => m.name)).toEqual(["Thandi Nkosi"]); // flagged; Solo (1 source) is not
    expect(sc.mergedPersons[0]!.sources).toBe(2);
  });
});

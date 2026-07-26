// Scorecard logic, deterministic (no LLM): build a tiny known graph on a temp-file db, then assert report()
// computes the rubric metrics correctly — especially the token-based "names both endpoints" check, which a
// strict full-name match would badly under-count.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { report, namesEndpoint, tokenize } from "../scripts/ingest-report.js";

const meta = { actor: "test", cause: "unit" };

// The headline metric's matcher — the bug both reviewers flagged lived here.
const names = (reason: string, name: string, other: string): boolean =>
  namesEndpoint(new Set(tokenize(reason)), reason.toLowerCase(), name, new Set(tokenize(other)));

describe("namesEndpoint (both-endpoints matcher)", () => {
  it("matches a distinctive token as a whole word, not a substring", () => {
    expect(names("Charnel picks grapes at Klipgat Farm", "Charnel Cloete", "Klipgat Farm")).toBe(true);
    expect(names("farmworkers strike near De Doorns", "Klipgat Farm", "De Doorns")).toBe(false); // "farm" ⊄ farmworkers
  });
  it("does NOT count a family token shared with the other endpoint", () => {
    // "the Cloete family" names neither individual — "cloete" is shared, so it's not distinctive to either.
    expect(names("the Cloete family vineyard passed down", "Charnel Cloete", "Maria Cloete")).toBe(false);
    expect(names("Charnel and Maria Cloete argue", "Charnel Cloete", "Maria Cloete")).toBe(true); // "charnel" is distinctive
  });
});

describe("ingest scorecard", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("computes entities/doc, token-based both-endpoints, banned phrases, and buzzword leaks", async () => {
    dir = mkdtempSync(join(tmpdir(), "tessera-report-"));
    const dbPath = join(dir, "g.db");
    const emb = new StubEmbedder(768); // report() reopens with StubEmbedder(768) — dims must match
    const store = new GraphStore({ path: dbPath, embedder: emb });

    const doc = (await store.putNode({ type: "SOURCE", subtype: "document", origin: "ingest", text: "source\t/d.md", name: "D", description: "doc" }, meta)).id;
    const put = async (name: string, type: "PERSON" | "CONCEPT", subtype: string) =>
      (await store.putNode({ type, subtype, origin: "ingest", text: `${subtype}\t${name.toLowerCase()}`, name, description: `${name} desc` }, meta)).id;
    const charnel = await put("Charnel Cloete", "PERSON", "person");
    const farm = await put("Klipgat Farm", "CONCEPT", "place");
    const synergy = await put("Synergy", "CONCEPT", "concept"); // a NEGATIVE_CONSTRAINTS buzzword that leaked in
    // one provenance chunk (must be excluded from entity metrics)
    await store.putNode({ type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk\tk\t1", name: "c1", description: "raw" }, meta);

    // ANCHORED reason: restates both endpoint names (the old style we're moving away from) — not de-anchored.
    await store.putEdge({ from: charnel, to: farm, kind: "RELATED", reason: "Charnel picks grapes seasonally at Klipgat Farm", origin: "ingest" }, meta);
    // On a DISTINCT pair (second edge): names NEITHER endpoint, so de-anchored — but ALSO vague, so banned. The
    // two metrics are orthogonal: de-anchored doesn't imply good; you want de-anchored AND non-vague.
    await store.putEdge({ from: charnel, to: synergy, kind: "RELATED", reason: "the two are associated with each other", origin: "ingest" }, meta);
    store.close();

    const sc = report(dbPath);
    expect(sc.docs).toBe(1);
    expect(sc.chunks).toBe(1);
    expect(sc.entities).toBe(3); // charnel, farm, synergy — NOT the doc/chunk provenance nodes
    expect(sc.entitiesPerDoc).toBe(3);
    expect(sc.relatedReasons).toBe(2); // one assertion per edge
    expect(sc.reasonsPerEdge).toBe(1); // 2 reasons / 2 edges
    expect(sc.deAnchoredReasons).toBe(1); // the one naming neither endpoint (the anchored "Charnel…Klipgat" doesn't count)
    expect(sc.bannedPhraseReasons.length).toBe(1); // "associated with" — de-anchored yet still vague
    expect(sc.buzzwordHubs.map((h) => h.name)).toContain("Synergy");
  });
});

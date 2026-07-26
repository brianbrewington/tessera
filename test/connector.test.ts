// Hardened Connector (clustering-mining-sketch §3.3) — deterministic unit tests, no network.
// Covers: PROPOSE blocking (already-RELATED, same-document), the per-run cap, the cosine floor; and
// EVALUATE plumbing (verifier y/n -> de-anchored reason -> second-family vagueness screen) via StubChat.
import { describe, it, expect } from "vitest";
import { StubChat } from "../src/llm.js";
import {
  propose,
  evaluateCandidate,
  buildNodeContext,
  runConnector,
  type ConnectorStore,
  type NodeCtx,
} from "../src/connect/connector.js";
import type { NodeRecord, EdgeRecord, SimilarHit, PutEdgeInput } from "../src/schema.js";

// --- Minimal node/edge factories (only the fields the connector reads) ---------------------------
function node(id: string, over: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    type: "CONCEPT",
    subtype: null,
    origin: "ingest",
    text: id,
    name: id,
    description: `desc of ${id}`,
    contentHash: id,
    strength: 1,
    timestamp: 0,
    provenance: null,
    metadata: null,
    status: "proposed",
    pinned: false,
    frameDebt: 0,
    version: 1,
    ...over,
  };
}
function relEdge(from: string, to: string): EdgeRecord {
  return { id: `${from}-${to}`, from, to, kind: "RELATED", polarity: null, semanticWeight: 0, hebbianWeight: 1, status: "proposed", version: 1 };
}
function appearedIn(entity: string, chunk: string): EdgeRecord {
  return { id: `${entity}@${chunk}`, from: entity, to: chunk, kind: "APPEARED_IN", polarity: null, semanticWeight: 0, hebbianWeight: 1, status: "proposed", version: 1 };
}

// A stub store where geometry is fully controlled: each node's "vector" is a 1-element array carrying
// its index, and querySimilar returns a hand-authored neighbor list with exact cosines — so proposal
// blocking / cap / floor are tested without any real embedding math or Ollama.
class StubStore implements ConnectorStore {
  putEdgeCalls: PutEdgeInput[] = [];
  private idxToId: string[] = [];
  private vecs = new Map<string, Float32Array>();
  constructor(
    public nodes: NodeRecord[],
    public edges: EdgeRecord[],
    private neighbors: Map<string, { id: string; cosine: number }[]>,
  ) {
    for (const n of nodes) {
      const i = this.idxToId.length;
      this.idxToId.push(n.id);
      this.vecs.set(n.id, new Float32Array([i]));
    }
  }
  allNodes(): NodeRecord[] { return this.nodes; }
  allEdges(): EdgeRecord[] { return this.edges; }
  getNode(id: string): NodeRecord | null { return this.nodes.find((n) => n.id === id) ?? null; }
  vectorOf(id: string): Float32Array | null { return this.vecs.get(id) ?? null; }
  async querySimilar(vector: Float32Array, k: number): Promise<SimilarHit[]> {
    const srcId = this.idxToId[Math.round(vector[0]!)]!;
    const src = this.getNode(srcId)!;
    const hits: SimilarHit[] = [{ kind: "node", node: src, cosine: 1 }]; // self
    for (const nb of this.neighbors.get(srcId) ?? []) {
      const n = this.getNode(nb.id);
      if (n) hits.push({ kind: "node", node: n, cosine: nb.cosine });
    }
    return hits.slice(0, k);
  }
  async putEdge(input: PutEdgeInput): Promise<{ edgeId: string; assertionId: string; created: boolean }> {
    this.putEdgeCalls.push(input);
    return { edgeId: "e", assertionId: "a", created: true };
  }
}

// Fixture: 4 entities + 3 chunks. e1,e2 live in docX; e3 in docY; e4 in docZ. e1~e3 already RELATED.
function fixture(): StubStore {
  const nodes = [
    node("n1"), node("n2"), node("n3"), node("n4"),
    node("cX", { subtype: "chunk", description: "chunk about docX topics", provenance: { path: "docX" } }),
    node("cY", { subtype: "chunk", description: "chunk about docY topics", provenance: { path: "docY" } }),
    node("cZ", { subtype: "chunk", description: "chunk about docZ topics", provenance: { path: "docZ" } }),
  ];
  const edges = [
    appearedIn("n1", "cX"), appearedIn("n2", "cX"), appearedIn("n3", "cY"), appearedIn("n4", "cZ"),
    relEdge("n1", "n3"), // already-RELATED pair
  ];
  const neighbors = new Map<string, { id: string; cosine: number }[]>([
    ["n1", [{ id: "n2", cosine: 0.9 }, { id: "n3", cosine: 0.85 }, { id: "n4", cosine: 0.8 }]],
    ["n2", [{ id: "n1", cosine: 0.9 }, { id: "n4", cosine: 0.78 }, { id: "n3", cosine: 0.6 }]],
    ["n3", [{ id: "n1", cosine: 0.85 }, { id: "n4", cosine: 0.72 }]],
    ["n4", [{ id: "n1", cosine: 0.8 }, { id: "n2", cosine: 0.78 }, { id: "n3", cosine: 0.72 }]],
  ]);
  return new StubStore(nodes, edges, neighbors);
}

describe("Connector — propose (geometry proposes, never decides)", () => {
  it("blocks already-RELATED and same-document pairs; proposes only cross-doc unrelated pairs above the floor", async () => {
    const store = fixture();
    const ctx = buildNodeContext(store);
    const { candidates, stats } = await propose(store, ctx, { k: 6, floor: 0.75, cap: 50 });
    const keys = candidates.map((c) => `${c.fromName}|${c.toName}`);

    // n1~n2 share docX (blocked same-doc); n1~n3 already RELATED (blocked); n2~n3 & n3~n4 below 0.75.
    expect(keys).toContain("n1|n4"); // cross-doc (docX vs docZ), 0.80
    expect(keys).toContain("n2|n4"); // cross-doc (docX vs docZ), 0.78
    expect(keys).not.toContain("n1|n2"); // same doc
    expect(keys).not.toContain("n1|n3"); // already RELATED
    expect(candidates.length).toBe(2);
    expect(stats.blockedSameDoc).toBeGreaterThanOrEqual(1);
    expect(stats.blockedAlreadyRelated).toBeGreaterThanOrEqual(1);
    expect(stats.blockedBelowFloor).toBeGreaterThanOrEqual(2);
    // cosine is reported for the band curve but must never be presented as confidence.
    expect(candidates[0]!.cosine).toBeGreaterThanOrEqual(candidates[1]!.cosine); // sorted desc
  });

  it("honors the cosine floor (a candidate-rate knob, not a quality claim)", async () => {
    const store = fixture();
    const ctx = buildNodeContext(store);
    const { candidates } = await propose(store, ctx, { k: 6, floor: 0.79, cap: 50 });
    // At floor 0.79, n2~n4 (0.78) drops; only n1~n4 (0.80) remains.
    expect(candidates.map((c) => `${c.fromName}|${c.toName}`)).toEqual(["n1|n4"]);
  });

  it("enforces the per-run cap, keeping the strongest-cosine candidates", async () => {
    const store = fixture();
    const ctx = buildNodeContext(store);
    const { candidates, stats } = await propose(store, ctx, { k: 6, floor: 0.75, cap: 1 });
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.fromName).toBe("n1"); // n1~n4 @0.80 beats n2~n4 @0.78
    expect(candidates[0]!.toName).toBe("n4");
    expect(stats.cappedOut).toBe(1);
  });
});

describe("Connector — evaluate (two gates, diverse families; geometry discarded)", () => {
  const a = node("A", { name: "Klipgat Farm", description: "a wine farm in De Doorns" });
  const b = node("B", { name: "Cabernet Label", description: "a mid-tier wine brand" });
  const actx: NodeCtx = { docs: new Set(["docA"]), chunkText: "Klipgat Farm grows grapes." };
  const bctx: NodeCtx = { docs: new Set(["docB"]), chunkText: "The label sells wine in Johannesburg." };

  it("lands a pair only when the verifier says yes with a de-anchored reason AND the second family passes it", async () => {
    const v = new StubChat('{"related": true, "reason": "grows the grapes the other bottles and sells"}');
    const c = new StubChat('{"specific": true}');
    const verdict = await evaluateCandidate(a, actx, b, bctx, { verifier: v, checker: c });
    expect(verdict.related).toBe(true);
    expect(verdict.bannedPhrase).toBe(false);
    expect(verdict.checkerSpecific).toBe(true);
    expect(verdict.survived).toBe(true);
    expect(verdict.reason).toContain("grapes");
  });

  it("rejects when the verifier says no (no relationship)", async () => {
    const v = new StubChat('{"related": false, "reason": ""}');
    const c = new StubChat('{"specific": true}'); // would pass, but must not be consulted
    const verdict = await evaluateCandidate(a, actx, b, bctx, { verifier: v, checker: c });
    expect(verdict.related).toBe(false);
    expect(verdict.survived).toBe(false);
    expect(verdict.reason).toBe("");
  });

  it("rejects a banned-phrase reason mechanically (before the model checker)", async () => {
    const v = new StubChat('{"related": true, "reason": "the two are connected"}');
    const c = new StubChat('{"specific": true}');
    const verdict = await evaluateCandidate(a, actx, b, bctx, { verifier: v, checker: c });
    expect(verdict.bannedPhrase).toBe(true);
    expect(verdict.survived).toBe(false);
  });

  it("rejects when the second-family checker judges the reason vague", async () => {
    const v = new StubChat('{"related": true, "reason": "they have a meaningful overlap of interests"}');
    const c = new StubChat('{"specific": false}');
    const verdict = await evaluateCandidate(a, actx, b, bctx, { verifier: v, checker: c });
    expect(verdict.bannedPhrase).toBe(false);
    expect(verdict.checkerSpecific).toBe(false);
    expect(verdict.survived).toBe(false);
  });
});

describe("Connector — runConnector (dry-run vs commit)", () => {
  it("dry-run evaluates candidates and writes NO edges", async () => {
    const store = fixture();
    const v = new StubChat('{"related": true, "reason": "share a seasonal grape-harvest labour pool"}');
    const c = new StubChat('{"specific": true}');
    const run = await runConnector(store, { k: 6, floor: 0.75, cap: 50, commit: false, verifier: v, checker: c });
    expect(run.counts.evaluated).toBe(2);
    expect(run.counts.survived).toBe(2);
    expect(store.putEdgeCalls.length).toBe(0); // sidecar discipline: no writes without --commit
    expect(run.rejectRateByBand.length).toBeGreaterThanOrEqual(1);
  });

  it("commit writes survivors as origin:connector RELATED edges, never storing cosine as confidence", async () => {
    const store = fixture();
    const v = new StubChat('{"related": true, "reason": "share a seasonal grape-harvest labour pool"}');
    const c = new StubChat('{"specific": true}');
    const run = await runConnector(store, { k: 6, floor: 0.75, cap: 50, commit: true, verifier: v, checker: c });
    expect(store.putEdgeCalls.length).toBe(2);
    expect(run.counts.committed).toBe(2);
    for (const call of store.putEdgeCalls) {
      expect(call.origin).toBe("connector");
      expect(call.kind).toBe("RELATED");
      expect(call.reason).not.toMatch(/cos=/); // geometry discarded, not laundered into the reason
      expect(call.reason.length).toBeGreaterThan(0);
    }
  });
});

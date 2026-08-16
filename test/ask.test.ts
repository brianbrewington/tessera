// R1 (recall) and R2 (ask) offline tests — stub embedder, stub chat, in-memory store. The semantic quality
// of retrieval is R3's job (the QA eval, live); what THESE tests pin is the mechanics that could fail
// toward a clean-looking answer: the resolution view collapsing entity hits, citation verification being
// computed rather than trusted, and `grounded` never being claimable by an unverified answer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GraphStore } from "../src/store/graphStore.js";
import { StubEmbedder } from "../src/embedder.js";
import { StubChat } from "../src/llm.js";
import { recall, RECALL_TUNING } from "../src/ask/recall.js";
import { ask, parseAskReply, renderContext } from "../src/ask/ask.js";

const CHUNK_TEXT = "The decision queue was proposed by claude-code in message 0013 and approved by Brian.";
let store: GraphStore;
const embedder = new StubEmbedder(768);

beforeAll(async () => {
  store = new GraphStore({ path: ":memory:", embedder });
  const meta = { actor: "test", cause: "ask-test" };
  // one chunk holding the evidence
  const chunk = await store.putNode(
    { type: "SOURCE", subtype: "chunk", origin: "ingest", text: "chunk-1-identity", name: "chunk 1 of 0013-claude-code", description: CHUNK_TEXT },
    meta,
  );
  // the same concept extracted under two spellings — the resolution view must collapse them
  const a = await store.putNode({ type: "CONCEPT", subtype: "concept", origin: "ingest", text: "e-dq-1", name: "Decision Queue", description: "the approval mechanism" }, meta);
  const b = await store.putNode({ type: "CONCEPT", subtype: "concept", origin: "ingest", text: "e-dq-2", name: "decision_queue", description: "the approval mechanism, again" }, meta);
  // provenance: only the SECOND spelling links to the evidence chunk — reaching it requires the view
  await store.putEdge({ from: b.id, to: chunk.id, kind: "APPEARED_IN", reason: "extracted from this chunk", origin: "ingest" }, meta);
  await store.putEdge({ from: a.id, to: b.id, kind: "RELATED", reason: "same mechanism under two spellings", origin: "ingest" }, meta);
});
afterAll(() => store?.close());

describe("R1 recall", () => {
  it("collapses entity hits through the resolution view and reaches evidence via ANY member's provenance", async () => {
    const r = await recall(store, embedder, "who proposed the decision queue?");
    // both spellings must not appear as separate entities
    const names = r.entities.map((e) => e.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    expect(new Set(names).size).toBe(names.length);
    const dq = r.entities.find((e) => names.includes("decisionqueue"));
    expect(dq, "canonical decision-queue entity present").toBeTruthy();
    expect(dq!.collapsed.length).toBeGreaterThan(0); // it really is a collapse, not a lone node
    // the evidence chunk is reachable even though only ONE spelling carries the APPEARED_IN edge
    expect(r.chunks.some((c) => c.text === CHUNK_TEXT)).toBe(true);
  });

  it("reports the frozen tuning surface with the result", async () => {
    const r = await recall(store, embedder, "anything");
    expect(r.tuning).toBe(RECALL_TUNING); // same object — no per-call overrides exist to tune against R3
  });
});

describe("R2 parseAskReply", () => {
  it("reads the contract shape", () => {
    const p = parseAskReply('{"answer":"claude-code","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"proposed by claude-code"}]}');
    expect(p).toMatchObject({ answer: "claude-code", declined: false });
    expect(p!.citations[0]).toEqual({ excerpt: 1, quote: "proposed by claude-code" });
  });
  it("returns null on garbage rather than a fabricated decline", () => {
    expect(parseAskReply("I think the answer is probably claude-code.")).toBeNull();
  });
});

describe("R2 ask — the grounding contract", () => {
  it("marks an answer grounded ONLY when every citation verifies verbatim", async () => {
    const good = new StubChat(
      '{"answer":"claude-code proposed it","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"proposed by claude-code in message 0013"}]}',
    );
    const res = await ask(store, embedder, good, "who proposed the decision queue?");
    expect(res.declined).toBe(false);
    expect(res.citations[0]!.verdict).toBe("verified");
    expect(res.grounded).toBe(true);
  });

  it("a fabricated quote is caught mechanically and grounded stays false", async () => {
    const liar = new StubChat(
      '{"answer":"Brian proposed it","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"Brian proposed the decision queue himself"}]}',
    );
    const res = await ask(store, embedder, liar, "who proposed the decision queue?");
    expect(res.citations[0]!.verdict).toBe("unmatched");
    expect(res.grounded).toBe(false);
  });

  it("a NEAR-MISS quote does not ground an answer — diagnostic, never a survival", async () => {
    // One character off from the chunk text ("myssage"): verifyQuote says near_miss, and the registered E10
    // rule carries over to answer time — anything short of verbatim is not grounding. The mutation this
    // catches: `verdict === "verified" || verdict === "near_miss"` in the grounded check.
    const близко = new StubChat(
      '{"answer":"claude-code proposed it","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"proposed by claude-code in myssage 0013"}]}',
    );
    const res = await ask(store, embedder, близко, "who proposed the decision queue?");
    expect(res.citations[0]!.verdict).toBe("near_miss");
    expect(res.grounded).toBe(false);
  });

  it("an answer with no citations at all cannot be grounded", async () => {
    const bare = new StubChat('{"answer":"claude-code","declined":false,"decline_reason":"","citations":[]}');
    const res = await ask(store, embedder, bare, "who proposed the decision queue?");
    expect(res.grounded).toBe(false);
  });

  it("a citation to a non-existent excerpt is bad_index, not a crash and not a pass", async () => {
    const oob = new StubChat('{"answer":"x","declined":false,"decline_reason":"","citations":[{"excerpt":99,"quote":"whatever"}]}');
    const res = await ask(store, embedder, oob, "q");
    expect(res.citations[0]!.verdict).toBe("bad_index");
    expect(res.grounded).toBe(false);
  });

  it("decline is a first-class outcome, and an unparseable reply becomes a decline with the error kept", async () => {
    const decline = new StubChat('{"answer":"","declined":true,"decline_reason":"the excerpts do not say","citations":[]}');
    const res = await ask(store, embedder, decline, "what is the airspeed of an unladen swallow?");
    expect(res.declined).toBe(true);
    expect(res.grounded).toBe(false);

    const garbage = new StubChat("Well, let me think about this...");
    const res2 = await ask(store, embedder, garbage, "q");
    expect(res2.declined).toBe(true);
    expect(res2.parse_error).toBeTruthy();
  });

  it("renderContext numbers excerpts from 1 and carries chunk names for provenance", async () => {
    const r = await recall(store, embedder, "decision queue");
    const ctx = renderContext(r);
    expect(ctx).toMatch(/EXCERPT 1 \(from /);
  });
});

describe("R2 flag-miscompliance normalization (registered from the first R3 run)", () => {
  it("a bare-refusal answer text with the flag unset IS a decline, and is surfaced as miscompliance", () => {
    // 4 of 5 floor questions in the first eval run produced exactly this shape. The refusal is real; only
    // the flag is broken. Scoring it as an answer would fail correct refusals — instrument, not model.
    const p = parseAskReply('{"answer":"declined","declined":false,"decline_reason":"","citations":[]}');
    expect(p!.declined).toBe(true);
    expect(p!.flag_miscompliance).toBe(true);
  });
  it("does NOT convert a refusal-worded answer that carries citations", () => {
    // With citations attached the model is answering, whatever word it chose; conversion would let a model
    // dodge grounding checks by captioning real answers "declined".
    const p = parseAskReply('{"answer":"declined","declined":false,"decline_reason":"","citations":[{"excerpt":1,"quote":"x"}]}');
    expect(p!.declined).toBe(false);
  });
  it("does NOT convert a substantive answer", () => {
    const p = parseAskReply('{"answer":"The port is 7778.","declined":false,"decline_reason":"","citations":[]}');
    expect(p!.declined).toBe(false);
  });
});

describe("R4 span-containment grader (0033 rider — primary answer metric)", () => {
  it("credits a sentence answer containing the gold fact where EM would not", async () => {
    const { spanContainment, exactMatch } = await import("../src/ask/graders.js");
    expect(exactMatch("fidelity 0.574", "0.574")).toBe(false);   // the metric-fit gap, pinned
    expect(spanContainment("fidelity 0.574", "0.574")).toBe(true);
    expect(spanContainment("The ingested conversation graph is served on port 7778.", "7778")).toBe(true);
  });
  it("does not credit an answer missing the gold, and never credits empty gold", async () => {
    const { spanContainment } = await import("../src/ask/graders.js");
    expect(spanContainment("the port is 7777", "7778")).toBe(false);
    expect(spanContainment("anything at all", "")).toBe(false);  // empty gold must not match everything
  });
});

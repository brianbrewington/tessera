// Session-log ingest. Two properties carry the whole slice, and both are load-bearing for work that has not
// been built yet, so they are asserted directly rather than inferred:
//
//   1. A GROWING log does not duplicate. Sessions are stream-addressed and turns are keyed by the runtime's
//      record uuid, so re-reading an appended log reinforces what exists and adds only what is new. Under the
//      document rule (identity = hash of content) a live conversation would mint a fresh source and duplicate
//      every turn on every read.
//   2. Turns keep SPEAKER and TIMESTAMP. That is the binding constraint from the SESSION review round: a
//      first ingest that flattens a transcript to prose destroys attribution and forecloses the unification.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../src/store/graphStore.js";
import { Graph } from "../src/graph.js";
import { StubEmbedder } from "../src/embedder.js";
import { StubChat } from "../src/llm.js";
import { LlmExtractor, PROMPT_VERSION, type Extractor, type ExtractResult } from "../src/extract/extractor.js";
import { readSession } from "../src/ingest/session-adapter.js";
import { ingestSession } from "../src/ingest/ingest-session.js";
import { extractPending } from "../src/ingest/extract-pending.js";

const emb = new StubEmbedder(768);
const fresh = (): { store: GraphStore; g: Graph } => {
  const store = new GraphStore({ path: ":memory:", embedder: emb });
  return { store, g: Graph.attach(store, emb) };
};

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
let uuidN = 0;
const uid = (): string => `u${(++uuidN).toString().padStart(4, "0")}`;

function rec(o: Record<string, unknown>): string {
  return `${JSON.stringify({ sessionId: SID, uuid: uid(), timestamp: "2026-08-08T10:00:00.000Z", isSidechain: false, cwd: "/repo", gitBranch: "main", ...o })}\n`;
}
const userTurn = (text: string): string => rec({ type: "user", message: { role: "user", content: text } });
const asstTurn = (...blocks: Record<string, unknown>[]): string =>
  rec({ type: "assistant", message: { role: "assistant", content: blocks } });

function mkLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tessera-session-"));
  const p = join(dir, `${SID}.jsonl`);
  writeFileSync(p, lines.join(""));
  return p;
}

describe("the adapter selects, it does not convert", () => {
  it("keeps prose and refuses tool traffic, counting what it refused", () => {
    const p = mkLog([
      userTurn("Can you look at the layout code?"),
      asstTurn({ type: "thinking", thinking: "long internal reasoning" },
               { type: "text", text: "Looking at it now." },
               { type: "tool_use", name: "Read", input: {} }),
      rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "8000 lines of file" }] } }),
      rec({ type: "ai-title", title: "whatever" }),
    ]);
    const r = readSession(p);
    expect(r.turns.map((t) => t.text)).toEqual(["Can you look at the layout code?", "Looking at it now."]);
    // Refusals are counted, not silent: a session log is ~98% tool traffic and dropping it quietly would be
    // indistinguishable from losing it.
    expect(r.skipped.thinking).toBe(1);
    expect(r.skipped.tool_use).toBe(1);
    expect(r.skipped.tool_result).toBe(1);
    expect(r.skipped["ai-title"]).toBe(1);
  });

  it("strips harness scaffolding out of a user turn", () => {
    // A system-reminder is injected by the harness, not typed by the human. Keeping it would attribute the
    // harness's words to Brian, which is exactly what attribution exists to prevent.
    const p = mkLog([userTurn("Real question here.\n<system-reminder>\nignore me\n</system-reminder>")]);
    const r = readSession(p);
    expect(r.turns[0]!.text).toBe("Real question here.");
  });

  it("leaves sub-agent transcripts out by default", () => {
    const p = mkLog([
      userTurn("main thread"),
      rec({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }),
    ]);
    const r = readSession(p);
    expect(r.turns.length).toBe(1);
    expect(r.skipped.sidechain).toBe(1);
  });
});

describe("a session is a stream, not a document", () => {
  it("APPENDING to a log adds only the new turns — no duplication", async () => {
    // The property the second identity regime exists for. Under the document rule this would mint a whole new
    // source and re-create every turn beneath it, on every single read of a live conversation.
    const { store, g } = fresh();
    const p = mkLog([userTurn("first question"), asstTurn({ type: "text", text: "first answer" })]);
    const a = await ingestSession(g, p);
    expect(a.turns).toBe(2);

    appendFileSync(p, userTurn("second question"));
    const b = await ingestSession(g, p);

    expect(b.turns).toBe(3);
    expect(store.allNodes().filter((n) => n.subtype === "turn").length).toBe(3); // not 5
    expect(store.allNodes().filter((n) => n.subtype === "session").length).toBe(1); // one stream, not two
    store.close();
  });

  it("re-reading an UNCHANGED log creates nothing new", async () => {
    const { store, g } = fresh();
    const p = mkLog([userTurn("q"), asstTurn({ type: "text", text: "a" })]);
    await ingestSession(g, p);
    const before = store.allNodes().length;
    await ingestSession(g, p);
    expect(store.allNodes().length).toBe(before);
    store.close();
  });
});

describe("turns keep who said it and when", () => {
  it("records speaker, role and timestamp, and dates the node at utterance time", async () => {
    const { store, g } = fresh();
    const p = mkLog([userTurn("something I said")]);
    await ingestSession(g, p, { userName: "Brian" });

    const turn = store.allNodes().find((n) => n.subtype === "turn")!;
    expect(turn.provenance?.speaker).toBe("Brian");
    expect(turn.provenance?.role).toBe("user");
    expect(turn.provenance?.ts).toBe("2026-08-08T10:00:00.000Z");
    // Dated when it was SAID, not when it was ingested: otherwise a whole conversation shares one timestamp
    // and "when did he say that" is unanswerable.
    expect(turn.timestamp).toBe(Date.parse("2026-08-08T10:00:00.000Z"));
    store.close();
  });

  it("keeps the words VERBATIM — never prefixed, never reformatted", async () => {
    const { store, g } = fresh();
    const said = "I need an actual empty spot where something quiet can speak.";
    await ingestSession(g, mkLog([userTurn(said)]), { userName: "Brian" });
    expect(store.allNodes().find((n) => n.subtype === "turn")!.description).toBe(said);
    store.close();
  });

  it("hands the SPEAKER to extraction as the subject", async () => {
    // Subject-aware extraction measurably fixed KI-1 for persona documents. For a conversation the subject is
    // whoever is speaking, which is what turns "an entity appeared" into "Brian asserted this".
    const { store, g } = fresh();
    await ingestSession(g, mkLog([userTurn("a claim about Klipgat Farm")]), { userName: "Brian" });
    const seen: (string | undefined)[] = [];
    const ex: Extractor = {
      async extract(text: string, o: { subject?: string } = {}): Promise<ExtractResult> {
        seen.push(o.subject);
        return new LlmExtractor(new StubChat(JSON.stringify({ entities: [], relations: [] }))).extract(text);
      },
    };
    await extractPending(g, ex);
    expect(seen).toEqual(["Brian"]);
    store.close();
  });
});

describe("turns are ordinary units of work", () => {
  it("a turn is dirty, drains through the normal machinery, and then is clean", async () => {
    // No new queue, no new worker, no new node type: turns ride the same dirty/clean path as chunks, which is
    // what makes this slice small.
    const { store, g } = fresh();
    await ingestSession(g, mkLog([userTurn("mentions Klipgat Farm"), asstTurn({ type: "text", text: "and the harvest" })]));
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(2);

    const ex = new LlmExtractor(new StubChat(JSON.stringify({
      entities: [{ name: "Klipgat Farm", type: "PLACE", description: "a farm" }], relations: [],
    })));
    const d = await extractPending(g, ex);
    expect(d.extracted).toBe(2);
    expect(store.dirtyCounts(PROMPT_VERSION).dirty).toBe(0);
    expect(store.allNodes().some((n) => n.name === "Klipgat Farm")).toBe(true);
    store.close();
  });

  it("does not mint a SESSION or AGENT node — both are deferred types", async () => {
    const { store, g } = fresh();
    await ingestSession(g, mkLog([userTurn("q")]));
    const types = new Set(store.allNodes().map((n) => n.type));
    expect(types.has("SESSION" as never)).toBe(false);
    expect(types.has("AGENT" as never)).toBe(false);
    expect(store.allNodes().every((n) => n.type === "SOURCE")).toBe(true);
    store.close();
  });
});
